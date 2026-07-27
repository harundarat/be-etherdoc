import {
  BeforeApplicationShutdown,
  Injectable,
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
import type { OutboxJobType, RuntimeConfig } from '../config/runtime-config';
import { parseOutboxPayload, type OutboxPayload } from './outbox-payload';

export interface OutboxJob {
  attemptCount: number;
  id: string;
  jobType: OutboxJobType;
  leaseToken: string;
  payload: OutboxPayload;
}

export class OutboxLeaseLostError extends Error {
  constructor(jobId: string, operation: string) {
    super(`Outbox job ${jobId} lost its lease before ${operation}`);
    this.name = OutboxLeaseLostError.name;
  }
}

export function boundedBackoffMilliseconds(
  attempt: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 10));
  const base = Math.min(5 * 60_000, 1_000 * 2 ** safeAttempt);
  const jitter = Math.floor(base * 0.25 * Math.max(0, Math.min(random(), 1)));
  return Math.min(5 * 60_000, base + jitter);
}

@Injectable()
export class DatabaseService
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly lockTimeoutMs: number;
  private readonly pool: Pool;
  private readonly reclaimBatchSize: number;

  constructor(configService: ConfigService) {
    const runtime = configService.getOrThrow<RuntimeConfig>('runtime');
    this.lockTimeoutMs = runtime.worker.lockTimeoutMs;
    this.reclaimBatchSize = runtime.worker.batchSize;
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
    await this.reclaimExpiredOutboxJobs(this.reclaimBatchSize);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, [...values]);
  }

  async readiness(): Promise<boolean> {
    const result = await this.pool.query<{ table_name: string | null }>(
      `SELECT to_regclass('public.document_intent')::text AS table_name`,
    );
    return Boolean(result.rows[0]?.table_name);
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

  async withAdvisoryLock<T>(
    lockId: number,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let acquired = false;
    try {
      await client.query('SELECT pg_advisory_lock($1)', [lockId]);
      acquired = true;
      return await operation(client);
    } finally {
      try {
        if (acquired) {
          await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
        }
      } finally {
        client.release();
      }
    }
  }

  async withTryAdvisoryLock<T>(
    lockId: number,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    let acquired = false;
    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [lockId],
      );
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) {
        return false;
      }
      await operation(client);
      return true;
    } finally {
      try {
        if (acquired) {
          await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
        }
      } finally {
        client.release();
      }
    }
  }

  async claimOutboxJobs(workerId: string, limit: number): Promise<OutboxJob[]> {
    return this.transaction(async (client) => {
      const result = await client.query<{
        attempt_count: number;
        id: string;
        job_type: OutboxJobType;
        lease_token: string;
        payload: unknown;
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
            lease_token = gen_random_uuid(),
            attempt_count = attempt_count + 1,
            updated_at = now()
          FROM claimable
          WHERE job.id = claimable.id
          RETURNING
            job.id, job.job_type, job.payload, job.attempt_count,
            job.lease_token
        `,
        [limit, workerId],
      );
      return result.rows.map((row) => ({
        attemptCount: row.attempt_count,
        id: row.id,
        jobType: row.job_type,
        leaseToken: row.lease_token,
        payload: parseOutboxPayload(row.job_type, row.payload),
      }));
    });
  }

  async reclaimExpiredOutboxJobs(limit: number): Promise<number> {
    const result = await this.query<{ id: string }>(
      `
        WITH expired AS (
          SELECT id
          FROM outbox_job
          WHERE
            state = 'RUNNING'
            AND locked_at < now() - ($1::text || ' milliseconds')::interval
          ORDER BY locked_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE outbox_job AS job
        SET
          state = 'READY',
          available_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          lease_token = NULL,
          last_error = COALESCE(
            last_error,
            'Worker lease expired and was reclaimed'
          ),
          updated_at = now()
        FROM expired
        WHERE job.id = expired.id
        RETURNING job.id
      `,
      [this.lockTimeoutMs, limit],
    );
    return result.rowCount ?? 0;
  }

  async heartbeatOutboxJob(jobId: string, leaseToken: string): Promise<void> {
    const result = await this.query(
      `
        UPDATE outbox_job
        SET locked_at = now(), updated_at = now()
        WHERE id = $1 AND state = 'RUNNING' AND lease_token = $2
      `,
      [jobId, leaseToken],
    );
    this.assertLease(result.rowCount, jobId, 'heartbeat');
  }

  async retryOutboxJob(
    jobId: string,
    leaseToken: string,
    attempt: number,
    error: string,
  ): Promise<void> {
    const backoff = boundedBackoffMilliseconds(attempt);
    const result = await this.query(
      `
        UPDATE outbox_job
        SET
          state = 'READY',
          available_at = now() + ($3::text || ' milliseconds')::interval,
          locked_at = NULL,
          locked_by = NULL,
          lease_token = NULL,
          last_error = $4,
          updated_at = now()
        WHERE id = $1 AND state = 'RUNNING' AND lease_token = $2
      `,
      [jobId, leaseToken, backoff, error],
    );
    this.assertLease(result.rowCount, jobId, 'retry');
  }

  async completeOutboxJob(jobId: string, leaseToken: string): Promise<void> {
    const result = await this.query(
      `
        UPDATE outbox_job
        SET
          state = 'COMPLETED',
          locked_at = NULL,
          locked_by = NULL,
          lease_token = NULL,
          updated_at = now()
        WHERE id = $1 AND state = 'RUNNING' AND lease_token = $2
      `,
      [jobId, leaseToken],
    );
    this.assertLease(result.rowCount, jobId, 'completion');
  }

  async failOutboxJob(
    jobId: string,
    leaseToken: string,
    error: string,
  ): Promise<void> {
    const result = await this.query(
      `
        UPDATE outbox_job
        SET
          state = 'FAILED',
          locked_at = NULL,
          locked_by = NULL,
          lease_token = NULL,
          last_error = $3,
          updated_at = now()
        WHERE id = $1 AND state = 'RUNNING' AND lease_token = $2
      `,
      [jobId, leaseToken, error],
    );
    this.assertLease(result.rowCount, jobId, 'failure');
  }

  private assertLease(
    rowCount: number | null,
    jobId: string,
    operation: string,
  ): void {
    if (rowCount !== 1) {
      throw new OutboxLeaseLostError(jobId, operation);
    }
  }
}
