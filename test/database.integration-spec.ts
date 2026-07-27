import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthNonceCleanupService } from '../src/auth/auth-nonce-cleanup.service';
import type { RuntimeConfig } from '../src/config/runtime-config';
import { DatabaseService } from '../src/database/database.service';

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
    blockchain: { requestTimeoutMs: 5_000 },
    databaseUrl: url,
    worker: { drainTimeoutMs: 30_000, lockTimeoutMs: 10_000 },
  } as RuntimeConfig;
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
  return result.rows[0].id;
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
    expect(firstClaim[0].id).not.toBe(secondClaim[0].id);
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
      locked_by: string | null;
      state: string;
    }>(
      `SELECT state, locked_by FROM outbox_job WHERE deduplication_key = 'restart-job'`,
    );

    expect(recovered.rows[0]).toEqual({ locked_by: null, state: 'READY' });
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
      [intentId, transaction.rows[0].id],
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
      [intentId, transaction.rows[0].id],
    );
    const reconciliation = await pool.query<{ count: string }>(
      `SELECT count(*) FROM outbox_job WHERE deduplication_key = 'reconcile-once'`,
    );

    expect(evidence.rows[0].count).toBe('1');
    expect(reconciliation.rows[0].count).toBe('1');
  });
});
