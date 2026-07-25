import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';
import type { RuntimeConfig } from '../config/runtime-config';

export interface OutboxJob {
  attemptCount: number;
  id: string;
  jobType: string;
  payload: Record<string, unknown>;
}

export function boundedBackoffMilliseconds(attempt: number): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 10));
  return Math.min(5 * 60_000, 1_000 * 2 ** safeAttempt);
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;

  constructor(configService: ConfigService) {
    const runtime = configService.getOrThrow<RuntimeConfig>('runtime');
    this.pool = new Pool({
      connectionString: runtime.databaseUrl,
      max: 20,
      statement_timeout: runtime.blockchain.requestTimeoutMs,
    });
  }

  async onModuleInit(): Promise<void> {
    const result = await this.pool.query<{ table_name: string | null }>(
      `SELECT to_regclass('public.document_intent')::text AS table_name`,
    );
    if (!result.rows[0]?.table_name) {
      throw new ServiceUnavailableException(
        'Database schema is missing; run `pnpm db:migrate`',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, [...values]);
  }

  async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimOutboxJobs(workerId: string, limit: number): Promise<OutboxJob[]> {
    return this.transaction(async (client) => {
      const result = await client.query<{
        attempt_count: number;
        id: string;
        job_type: string;
        payload: Record<string, unknown>;
      }>(
        `
          WITH claimable AS (
            SELECT id
            FROM outbox_job
            WHERE state = 'READY' AND available_at <= now()
            ORDER BY available_at, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $1
          )
          UPDATE outbox_job AS job
          SET
            state = 'RUNNING',
            locked_at = now(),
            locked_by = $2,
            attempt_count = attempt_count + 1,
            updated_at = now()
          FROM claimable
          WHERE job.id = claimable.id
          RETURNING job.id, job.job_type, job.payload, job.attempt_count
        `,
        [limit, workerId],
      );
      return result.rows.map((row) => ({
        attemptCount: row.attempt_count,
        id: row.id,
        jobType: row.job_type,
        payload: row.payload,
      }));
    });
  }

  async retryOutboxJob(jobId: string, attempt: number, error: string) {
    const backoff = boundedBackoffMilliseconds(attempt);
    await this.query(
      `
        UPDATE outbox_job
        SET
          state = 'READY',
          available_at = now() + ($2::text || ' milliseconds')::interval,
          locked_at = NULL,
          locked_by = NULL,
          last_error = $3,
          updated_at = now()
        WHERE id = $1 AND state = 'RUNNING'
      `,
      [jobId, backoff, error],
    );
  }
}
