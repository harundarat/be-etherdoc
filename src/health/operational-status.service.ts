import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OutboxJobType, RuntimeConfig } from '../config/runtime-config';
import { DatabaseService } from '../database/database.service';
import {
  type ChainSide,
  OperationalStateService,
} from '../observability/operational-state.service';
import { redactSensitiveText } from '../observability/log-safety';

type OutboxState = 'COMPLETED' | 'FAILED' | 'READY' | 'RUNNING';

interface CursorRow {
  chain_id: string;
  contract_address: string;
  last_finalized_block: string | null;
}

interface OutboxCountRow {
  completed: string;
  expired_leases: string;
  failed: string;
  oldest_ready_age_seconds: string | null;
  ready: string;
  running: string;
}

interface OutboxTypeRow {
  count: string;
  job_type: OutboxJobType;
  state: OutboxState;
}

interface FailedJobRow {
  attempt_count: number;
  dispatch_id: string | null;
  id: string;
  intent_id: string | null;
  job_type: OutboxJobType;
  last_error: string | null;
  updated_at: Date;
}

interface RecoveryRow {
  failure_code: string | null;
  failure_detail: string | null;
  id: string;
  updated_at: Date;
}

export interface IndexerOperationalStatus {
  chainId: number;
  cursorBlock: string | null;
  finalizedHead: string | null;
  lagBlocks: number | null;
  lastSuccessfulTickAt: string | null;
}

export interface OperationalStatusReport {
  generatedAt: string;
  indexers: {
    destination: IndexerOperationalStatus;
    source: IndexerOperationalStatus;
  };
  outbox: {
    byType: Array<{
      count: number;
      jobType: OutboxJobType;
      state: OutboxState;
    }>;
    counts: {
      completed: number;
      expiredLeases: number;
      failed: number;
      ready: number;
      running: number;
    };
    oldestReadyAgeSeconds: number | null;
    recentFailures: Array<{
      attemptCount: number;
      dispatchId: string | null;
      error: string | null;
      id: string;
      intentId: string | null;
      jobType: OutboxJobType;
      updatedAt: string;
    }>;
  };
  recoveryRequiredDispatches: Array<{
    failureCode: string | null;
    failureDetail: string | null;
    id: string;
    updatedAt: string;
  }>;
  shutdown: {
    inProgress: boolean;
  };
  status: 'operational';
}

export function sanitizedOperationalError(value: string | null): string | null {
  return redactSensitiveText(value, 512);
}

@Injectable()
export class OperationalStatusService {
  private readonly runtime: RuntimeConfig;

  constructor(
    configService: ConfigService,
    private readonly database: DatabaseService,
    private readonly state: OperationalStateService,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  async status(): Promise<OperationalStatusReport> {
    const [cursors, counts, byType, failedJobs, recoveryDispatches] =
      await Promise.all([
        this.database.query<CursorRow>(
          `
            SELECT
              chain_id::text, contract_address, last_finalized_block::text
            FROM chain_cursor
            WHERE (chain_id, lower(contract_address)) IN (($1, lower($2)), ($3, lower($4)))
          `,
          [
            this.runtime.blockchain.source.chainId,
            this.runtime.blockchain.source.contractAddress,
            this.runtime.blockchain.destination.chainId,
            this.runtime.blockchain.destination.contractAddress,
          ],
        ),
        this.database.query<OutboxCountRow>(
          `
            SELECT
              count(*) FILTER (WHERE state = 'READY')::text AS ready,
              count(*) FILTER (WHERE state = 'RUNNING')::text AS running,
              count(*) FILTER (WHERE state = 'FAILED')::text AS failed,
              count(*) FILTER (WHERE state = 'COMPLETED')::text AS completed,
              count(*) FILTER (
                WHERE state = 'RUNNING'
                  AND locked_at < now() - ($1::text || ' milliseconds')::interval
              )::text AS expired_leases,
              extract(epoch FROM now() - min(created_at) FILTER (
                WHERE state = 'READY'
              ))::text AS oldest_ready_age_seconds
            FROM outbox_job
          `,
          [this.runtime.worker.lockTimeoutMs],
        ),
        this.database.query<OutboxTypeRow>(
          `
            SELECT job_type, state, count(*)::text AS count
            FROM outbox_job
            WHERE state IN ('READY', 'RUNNING', 'FAILED')
            GROUP BY job_type, state
            ORDER BY job_type, state
          `,
        ),
        this.database.query<FailedJobRow>(
          `
            SELECT
              id, job_type, attempt_count, intent_id, dispatch_id,
              last_error, updated_at
            FROM outbox_job
            WHERE state = 'FAILED'
            ORDER BY updated_at DESC
            LIMIT 20
          `,
        ),
        this.database.query<RecoveryRow>(
          `
            SELECT id, failure_code, failure_detail, updated_at
            FROM dispatch
            WHERE status = 'RECOVERY_REQUIRED'
            ORDER BY updated_at DESC
            LIMIT 20
          `,
        ),
      ]);
    const snapshot = this.state.snapshot();
    const count = counts.rows[0];

    return {
      generatedAt: new Date().toISOString(),
      indexers: {
        destination: this.indexerStatus(
          'destination',
          cursors.rows,
          snapshot.indexers.destination,
        ),
        source: this.indexerStatus(
          'source',
          cursors.rows,
          snapshot.indexers.source,
        ),
      },
      outbox: {
        byType: byType.rows.map((row) => ({
          count: Number(row.count),
          jobType: row.job_type,
          state: row.state,
        })),
        counts: {
          completed: Number(count?.completed ?? 0),
          expiredLeases: Number(count?.expired_leases ?? 0),
          failed: Number(count?.failed ?? 0),
          ready: Number(count?.ready ?? 0),
          running: Number(count?.running ?? 0),
        },
        oldestReadyAgeSeconds:
          count?.oldest_ready_age_seconds === null ||
          count?.oldest_ready_age_seconds === undefined
            ? null
            : Math.max(0, Math.floor(Number(count.oldest_ready_age_seconds))),
        recentFailures: failedJobs.rows.map((row) => ({
          attemptCount: row.attempt_count,
          dispatchId: row.dispatch_id,
          error: sanitizedOperationalError(row.last_error),
          id: row.id,
          intentId: row.intent_id,
          jobType: row.job_type,
          updatedAt: row.updated_at.toISOString(),
        })),
      },
      recoveryRequiredDispatches: recoveryDispatches.rows.map((row) => ({
        failureCode: row.failure_code,
        failureDetail: sanitizedOperationalError(row.failure_detail),
        id: row.id,
        updatedAt: row.updated_at.toISOString(),
      })),
      shutdown: {
        inProgress: snapshot.shuttingDown,
      },
      status: 'operational',
    };
  }

  private indexerStatus(
    side: ChainSide,
    cursors: CursorRow[],
    tick: { finalizedHead: string | null; lastSuccessfulTickAt: string | null },
  ): IndexerOperationalStatus {
    const chain = this.runtime.blockchain[side];
    const cursor = cursors.find(
      (row) =>
        row.chain_id === String(chain.chainId) &&
        row.contract_address.toLowerCase() ===
          chain.contractAddress.toLowerCase(),
    );
    const finalizedHead =
      tick.finalizedHead === null ? null : BigInt(tick.finalizedHead);
    const lastFinalizedBlock =
      cursor?.last_finalized_block === null ||
      cursor?.last_finalized_block === undefined
        ? null
        : BigInt(cursor.last_finalized_block);
    return {
      chainId: chain.chainId,
      cursorBlock: lastFinalizedBlock?.toString() ?? null,
      finalizedHead: finalizedHead?.toString() ?? null,
      lagBlocks:
        finalizedHead === null || lastFinalizedBlock === null
          ? null
          : Number(
              finalizedHead > lastFinalizedBlock
                ? finalizedHead - lastFinalizedBlock
                : 0n,
            ),
      lastSuccessfulTickAt: tick.lastSuccessfulTickAt,
    };
  }
}
