import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { requireQueryRow } from '../src/database/query-result';
import { AuthNonceCleanupService } from '../src/auth/auth-nonce-cleanup.service';
import type { RuntimeConfig } from '../src/config/runtime-config';
import {
  DatabaseService,
  OutboxLeaseLostError,
} from '../src/database/database.service';
import type { DestinationWorker } from '../src/workers/destination.worker';
import type { DispatchWorker } from '../src/workers/dispatch.worker';
import { OutboxWorkerService } from '../src/workers/outbox-worker.service';
import type { ReconciliationWorker } from '../src/workers/reconciliation.worker';
import type { SourceTransactionWorker } from '../src/workers/source-transaction.worker';
import { OperationalStatusService } from '../src/health/operational-status.service';
import { OperationalStateService } from '../src/observability/operational-state.service';

const issuer = '0x0000000000000000000000000000000000000001';
const documentId = `0x${'11'.repeat(32)}`;

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      'DATABASE_URL is required for PostgreSQL integration tests',
    );
  }
  return value;
}

function runtime(url: string): RuntimeConfig {
  return {
    blockchain: {
      destination: {
        chainId: 2,
        contractAddress: '0x0000000000000000000000000000000000000002',
      },
      requestTimeoutMs: 5_000,
      source: {
        chainId: 1,
        contractAddress: '0x0000000000000000000000000000000000000001',
      },
    },
    database: { statementTimeoutMs: 5_000 },
    databaseUrl: url,
    worker: {
      batchSize: 10,
      drainTimeoutMs: 5_000,
      heartbeatIntervalMs: 1_000,
      indexBlockRange: 2_000,
      indexIntervalMs: 15_000,
      lockTimeoutMs: 10_000,
      maxAttempts: {
        CONFIRM_SOURCE: 8,
        DISPATCH_DESTINATION: 8,
        RECONCILE: 8,
        SUBMIT_SOURCE: 8,
        TRACK_DESTINATION: 8,
      },
      pollIntervalMs: 60_000,
    },
  } as unknown as RuntimeConfig;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function insertIntent(pool: Pool, idempotencyKey: string, nonce: string) {
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO document_intent(
        idempotency_key, operation, status, issuer, chain_nonce, deadline,
        document_id, typed_data, typed_data_digest
      )
      VALUES(
        $1,'REGISTER','PREPARED',$2,$3,now() + interval '10 minutes',
        $4,'{}',$5
      )
      RETURNING id
    `,
    [idempotencyKey, issuer, nonce, documentId, `0x${'0'.repeat(64)}`],
  );
  return requireQueryRow(result.rows, 'integration intent insert').id;
}

describe('PostgreSQL protocol state', () => {
  const url = databaseUrl();
  const pool = new Pool({ connectionString: url });

  beforeEach(async () => {
    await pool.query(
      `
        TRUNCATE
          authentication_nonce, document_intent, processed_chain_event,
          chain_cursor
        RESTART IDENTITY CASCADE
      `,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies every migration exactly once', async () => {
    const migrations = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migration ORDER BY version`,
    );
    expect(migrations.rows.map((row) => row.version)).toEqual([
      '001_protocol_state.sql',
      '002_intent_digest.sql',
      '003_dispatch_evidence.sql',
      '004_dispatch_canonical_snapshot.sql',
      '005_auth_nonce_retention.sql',
      '006_outbox_lease.sql',
    ]);
  });

  it('enforces idempotency and issuer nonce uniqueness', async () => {
    await insertIntent(pool, 'idempotency-one', '1');

    await expect(
      insertIntent(pool, 'idempotency-one', '2'),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insertIntent(pool, 'idempotency-two', '1'),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('reports operational cursor lag and outbox failures from PostgreSQL', async () => {
    const intentId = await insertIntent(pool, 'status-intent', '1');
    await pool.query(
      `
        INSERT INTO chain_cursor(
          chain_id, contract_address, next_block, last_finalized_block
        )
        VALUES
          (1, '0x0000000000000000000000000000000000000001', 99, 98),
          (2, '0x0000000000000000000000000000000000000002', 50, 49)
      `,
    );
    await pool.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, intent_id, state, payload,
          attempt_count, last_error
        )
        VALUES(
          'status-failed', 'SUBMIT_SOURCE', $1::uuid, 'FAILED',
          jsonb_build_object('intentId', $1::uuid::text), 8,
          'request to https://user:password@rpc.example failed'
        );
      `,
      [intentId],
    );
    const config = new ConfigService({ runtime: runtime(databaseUrl()) });
    const database = new DatabaseService(config);
    await database.onModuleInit();
    const state = new OperationalStateService();
    state.markIndexerSuccess('source', 100n);
    state.markIndexerSuccess('destination', 50n);
    const statusService = new OperationalStatusService(config, database, state);

    try {
      await expect(statusService.status()).resolves.toMatchObject({
        indexers: {
          destination: { cursorBlock: '49', lagBlocks: 1 },
          source: { cursorBlock: '98', lagBlocks: 2 },
        },
        outbox: {
          counts: { failed: 1 },
          recentFailures: [
            {
              error: 'request to [redacted-url] failed',
              intentId,
            },
          ],
        },
      });
    } finally {
      await database.beforeApplicationShutdown();
    }
  });

  it('deletes retained authentication nonces in bounded batches', async () => {
    await pool.query(
      `
        INSERT INTO authentication_nonce(
          wallet_address, nonce, siwe_message, issued_at, expires_at, consumed_at
        )
        VALUES
          ($1, 'old-consumed', 'message', now() - interval '10 days',
           now() - interval '9 days', now() - interval '8 days'),
          ($1, 'old-expired', 'message', now() - interval '10 days',
           now() - interval '8 days', NULL),
          ($1, 'recent-consumed', 'message', now() - interval '2 days',
           now() - interval '1 day', now() - interval '1 day'),
          ($1, 'active', 'message', now(), now() + interval '5 minutes', NULL)
      `,
      [issuer],
    );
    const cleanup = new AuthNonceCleanupService(
      new ConfigService({
        runtime: {
          auth: {
            nonceCleanupBatchSize: 1,
            nonceCleanupIntervalSeconds: 3_600,
            nonceRetentionSeconds: 604_800,
          },
        } as RuntimeConfig,
      }),
      {
        query: (text: string, values: readonly unknown[]) =>
          pool.query(text, [...values]),
      } as unknown as DatabaseService,
    );

    await expect(cleanup.cleanup()).resolves.toBe(1);
    await expect(cleanup.cleanup()).resolves.toBe(1);
    await expect(cleanup.cleanup()).resolves.toBe(0);
    const remaining = await pool.query<{ nonce: string }>(
      `SELECT nonce FROM authentication_nonce ORDER BY nonce`,
    );
    expect(remaining.rows.map(({ nonce }) => nonce)).toEqual([
      'active',
      'recent-consumed',
    ]);
  });

  it('lets concurrent workers claim distinct jobs with SKIP LOCKED', async () => {
    const firstIntent = await insertIntent(pool, 'claim-one', '1');
    const secondIntent = await insertIntent(pool, 'claim-two', '2');
    await pool.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, intent_id, payload
        )
        VALUES
          (
            'claim-one','SUBMIT_SOURCE',$1::uuid,
            jsonb_build_object('intentId',$1::text)
          ),
          (
            'claim-two','SUBMIT_SOURCE',$2::uuid,
            jsonb_build_object('intentId',$2::text)
          )
      `,
      [firstIntent, secondIntent],
    );
    const firstDatabase = new DatabaseService(
      new ConfigService({ runtime: runtime(url) }),
    );
    const secondDatabase = new DatabaseService(
      new ConfigService({ runtime: runtime(url) }),
    );
    await Promise.all([
      firstDatabase.onModuleInit(),
      secondDatabase.onModuleInit(),
    ]);

    const [firstClaim, secondClaim] = await Promise.all([
      firstDatabase.claimOutboxJobs('worker-one', 1),
      secondDatabase.claimOutboxJobs('worker-two', 1),
    ]);

    expect(firstClaim).toHaveLength(1);
    expect(secondClaim).toHaveLength(1);
    const firstJob = requireQueryRow(firstClaim, 'first concurrent claim');
    const secondJob = requireQueryRow(secondClaim, 'second concurrent claim');
    expect(firstJob.id).not.toBe(secondJob.id);
    expect(firstJob.leaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(secondJob.leaseToken).not.toBe(firstJob.leaseToken);
    await Promise.all([
      firstDatabase.beforeApplicationShutdown(),
      secondDatabase.beforeApplicationShutdown(),
    ]);
  });

  it('recovers an expired running job lease after restart', async () => {
    const intentId = await insertIntent(pool, 'restart-intent', '1');
    await pool.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, intent_id, payload, state,
          locked_at, locked_by
        )
        VALUES(
          'restart-job','SUBMIT_SOURCE',$1::uuid,
          jsonb_build_object('intentId',$1::text),'RUNNING',
          now() - interval '1 hour','dead-worker'
        )
      `,
      [intentId],
    );
    const database = new DatabaseService(
      new ConfigService({ runtime: runtime(url) }),
    );
    await database.onModuleInit();

    const recovered = await pool.query<{
      lease_token: string | null;
      locked_by: string | null;
      state: string;
    }>(
      `
        SELECT state, locked_by, lease_token
        FROM outbox_job
        WHERE deduplication_key = 'restart-job'
      `,
    );

    expect(recovered.rows[0]).toEqual({
      lease_token: null,
      locked_by: null,
      state: 'READY',
    });
    await database.beforeApplicationShutdown();
  });

  it('heartbeats a current lease and rejects a stale owner after reclaim', async () => {
    const intentId = await insertIntent(pool, 'lease-intent', '1');
    await pool.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, intent_id, payload
        )
        VALUES(
          'leased-job','SUBMIT_SOURCE',$1::uuid,
          jsonb_build_object('intentId',$1::text)
        )
      `,
      [intentId],
    );
    const firstDatabase = new DatabaseService(
      new ConfigService({ runtime: runtime(url) }),
    );
    const secondDatabase = new DatabaseService(
      new ConfigService({ runtime: runtime(url) }),
    );
    await Promise.all([
      firstDatabase.onModuleInit(),
      secondDatabase.onModuleInit(),
    ]);

    const firstClaim = requireQueryRow(
      await firstDatabase.claimOutboxJobs('worker-one', 1),
      'first reclaimed lease claim',
    );
    await pool.query(
      `
        UPDATE outbox_job
        SET locked_at = now() - interval '1 hour'
        WHERE id = $1
      `,
      [firstClaim.id],
    );
    await expect(secondDatabase.reclaimExpiredOutboxJobs(1)).resolves.toBe(1);
    const secondClaim = requireQueryRow(
      await secondDatabase.claimOutboxJobs('worker-two', 1),
      'second reclaimed lease claim',
    );

    expect(secondClaim.id).toBe(firstClaim.id);
    expect(secondClaim.leaseToken).not.toBe(firstClaim.leaseToken);
    await secondDatabase.heartbeatOutboxJob(
      secondClaim.id,
      secondClaim.leaseToken,
    );
    await expect(secondDatabase.reclaimExpiredOutboxJobs(1)).resolves.toBe(0);
    await expect(
      firstDatabase.heartbeatOutboxJob(firstClaim.id, firstClaim.leaseToken),
    ).rejects.toBeInstanceOf(OutboxLeaseLostError);
    await expect(
      firstDatabase.retryOutboxJob(
        firstClaim.id,
        firstClaim.leaseToken,
        firstClaim.attemptCount,
        'stale retry',
      ),
    ).rejects.toBeInstanceOf(OutboxLeaseLostError);
    await expect(
      firstDatabase.failOutboxJob(
        firstClaim.id,
        firstClaim.leaseToken,
        'stale failure',
      ),
    ).rejects.toBeInstanceOf(OutboxLeaseLostError);
    await expect(
      firstDatabase.completeOutboxJob(firstClaim.id, firstClaim.leaseToken),
    ).rejects.toBeInstanceOf(OutboxLeaseLostError);

    const stillOwned = await pool.query<{
      lease_token: string;
      state: string;
    }>(`SELECT state, lease_token FROM outbox_job WHERE id = $1`, [
      secondClaim.id,
    ]);
    expect(stillOwned.rows[0]).toEqual({
      lease_token: secondClaim.leaseToken,
      state: 'RUNNING',
    });

    await secondDatabase.completeOutboxJob(
      secondClaim.id,
      secondClaim.leaseToken,
    );
    const completed = await pool.query<{
      lease_token: string | null;
      state: string;
    }>(`SELECT state, lease_token FROM outbox_job WHERE id = $1`, [
      secondClaim.id,
    ]);
    expect(completed.rows[0]).toEqual({
      lease_token: null,
      state: 'COMPLETED',
    });
    await Promise.all([
      firstDatabase.beforeApplicationShutdown(),
      secondDatabase.beforeApplicationShutdown(),
    ]);
  });

  it('skips a held periodic advisory lock without blocking', async () => {
    const firstDatabase = new DatabaseService(
      new ConfigService({ runtime: runtime(url) }),
    );
    const secondDatabase = new DatabaseService(
      new ConfigService({ runtime: runtime(url) }),
    );
    await Promise.all([
      firstDatabase.onModuleInit(),
      secondDatabase.onModuleInit(),
    ]);
    const started = deferred<void>();
    const release = deferred<void>();
    const firstLock = firstDatabase.withTryAdvisoryLock(
      836_483_699,
      async () => {
        started.resolve();
        await release.promise;
      },
    );
    await started.promise;

    await expect(
      secondDatabase.withTryAdvisoryLock(836_483_699, () => Promise.resolve()),
    ).resolves.toBe(false);
    release.resolve();
    await expect(firstLock).resolves.toBe(true);
    await Promise.all([
      firstDatabase.beforeApplicationShutdown(),
      secondDatabase.beforeApplicationShutdown(),
    ]);
  });

  it('drains an active PostgreSQL outbox job before the pool closes', async () => {
    const intentId = await insertIntent(pool, 'shutdown-intent', '1');
    await pool.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, intent_id, payload
        )
        VALUES(
          'shutdown-job','SUBMIT_SOURCE',$1::uuid,
          jsonb_build_object('intentId',$1::text)
        )
      `,
      [intentId],
    );
    const config = new ConfigService({ runtime: runtime(url) });
    const database = new DatabaseService(config);
    await database.onModuleInit();
    const submission = deferred<void>();
    const submit = jest.fn().mockReturnValue(submission.promise);
    const worker = new OutboxWorkerService(
      config,
      database,
      {} as DestinationWorker,
      {} as DispatchWorker,
      {} as ReconciliationWorker,
      { submit } as unknown as SourceTransactionWorker,
    );

    const tick = worker.tick();
    while (submit.mock.calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    let drained = false;
    const shutdown = worker.onModuleDestroy().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    submission.resolve();
    await Promise.all([tick, shutdown]);
    const completed = await pool.query<{ state: string }>(
      `
        SELECT state
        FROM outbox_job
        WHERE deduplication_key = 'shutdown-job'
      `,
    );
    expect(
      requireQueryRow(completed.rows, 'completed shutdown job').state,
    ).toBe('COMPLETED');
    await database.beforeApplicationShutdown();
  });

  it('deduplicates replayed chain evidence and reconciliation jobs', async () => {
    const intentId = await insertIntent(pool, 'reconcile-intent', '1');
    const transaction = await pool.query<{ id: string }>(
      `
        INSERT INTO source_transaction(intent_id, attempt, state, nonce)
        VALUES($1,1,'UNKNOWN',7)
        RETURNING id
      `,
      [intentId],
    );
    await pool.query(
      `
        INSERT INTO processed_chain_event(
          chain_id, contract_address, transaction_hash, log_index,
          block_number, block_hash, event_name, event_payload
        )
        VALUES(11155111,$1,$2,0,100,$3,'DocumentRegistered','{}')
        ON CONFLICT (chain_id, transaction_hash, log_index)
        DO UPDATE SET canonical = true
      `,
      [issuer, `0x${'22'.repeat(32)}`, `0x${'33'.repeat(32)}`],
    );
    await pool.query(
      `
        INSERT INTO processed_chain_event(
          chain_id, contract_address, transaction_hash, log_index,
          block_number, block_hash, event_name, event_payload
        )
        VALUES(11155111,$1,$2,0,100,$3,'DocumentRegistered','{}')
        ON CONFLICT (chain_id, transaction_hash, log_index)
        DO UPDATE SET canonical = true
      `,
      [issuer, `0x${'22'.repeat(32)}`, `0x${'33'.repeat(32)}`],
    );
    const evidence = await pool.query<{ count: string }>(
      `SELECT count(*) FROM processed_chain_event`,
    );
    await pool.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, intent_id, payload
        )
        VALUES(
          'reconcile-once','RECONCILE',$1::uuid,
          jsonb_build_object(
            'intentId',$1::text,
            'transactionId',$2::text
          )
        )
        ON CONFLICT (deduplication_key) DO NOTHING
      `,
      [
        intentId,
        requireQueryRow(transaction.rows, 'source transaction insert').id,
      ],
    );
    await pool.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, intent_id, payload
        )
        VALUES(
          'reconcile-once','RECONCILE',$1::uuid,
          jsonb_build_object(
            'intentId',$1::text,
            'transactionId',$2::text
          )
        )
        ON CONFLICT (deduplication_key) DO NOTHING
      `,
      [
        intentId,
        requireQueryRow(transaction.rows, 'source transaction insert').id,
      ],
    );
    const reconciliation = await pool.query<{ count: string }>(
      `SELECT count(*) FROM outbox_job WHERE deduplication_key = 'reconcile-once'`,
    );

    expect(requireQueryRow(evidence.rows, 'evidence count').count).toBe('1');
    expect(
      requireQueryRow(reconciliation.rows, 'reconciliation count').count,
    ).toBe('1');
  });
});
