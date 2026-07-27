#!/usr/bin/env node

import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
const argumentsList = process.argv.slice(2);
const enqueue = argumentsList.includes('--enqueue');

if (!databaseUrl) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}
if (argumentsList.some((argument) => !['--enqueue'].includes(argument))) {
  process.stderr.write('Usage: pnpm reconcile [--enqueue]\n');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query('SELECT pg_advisory_lock($1)', [836_483_625]);
  const candidates = await client.query(`
    SELECT
      (
        SELECT count(*)
        FROM source_transaction
        WHERE state = 'UNKNOWN'
      )::integer AS source_unknown,
      (
        SELECT count(*)
        FROM dispatch
        WHERE status = 'RECOVERY_REQUIRED'
      )::integer AS dispatch_recovery,
      (
        SELECT count(*)
        FROM dispatch
        WHERE status = 'SOURCE_ACCEPTED' AND message_id IS NOT NULL
      )::integer AS destination_tracking
  `);
  if (!enqueue) {
    process.stdout.write(
      `${JSON.stringify({ mode: 'dry-run', ...candidates.rows[0] }, null, 2)}\n`,
    );
    process.exitCode = 0;
  } else {
    await client.query('BEGIN');
    try {
      const source = await client.query(`
        INSERT INTO outbox_job(
          deduplication_key, job_type, intent_id, payload
        )
        SELECT
          'intent:' || intent_id || ':reconcile-source:' || id,
          'RECONCILE',
          intent_id,
          jsonb_build_object('intentId', intent_id, 'transactionId', id)
        FROM source_transaction
        WHERE state = 'UNKNOWN'
        ON CONFLICT (deduplication_key) DO UPDATE SET
          state = 'READY',
          available_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          lease_token = NULL,
          last_error = NULL,
          updated_at = now()
        WHERE outbox_job.state IN ('COMPLETED', 'FAILED')
      `);
      const dispatch = await client.query(`
        INSERT INTO outbox_job(
          deduplication_key, job_type, dispatch_id, payload
        )
        SELECT
          'dispatch:' || id || ':reconcile-operator',
          'RECONCILE',
          id,
          jsonb_build_object('dispatchId', id)
        FROM dispatch
        WHERE status = 'RECOVERY_REQUIRED'
        ON CONFLICT (deduplication_key) DO UPDATE SET
          state = 'READY',
          available_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          lease_token = NULL,
          last_error = NULL,
          updated_at = now()
        WHERE outbox_job.state IN ('COMPLETED', 'FAILED')
      `);
      const tracking = await client.query(`
        INSERT INTO outbox_job(
          deduplication_key, job_type, dispatch_id, payload
        )
        SELECT
          'dispatch:' || id || ':track-destination',
          'TRACK_DESTINATION',
          id,
          jsonb_build_object('dispatchId', id)
        FROM dispatch
        WHERE status = 'SOURCE_ACCEPTED' AND message_id IS NOT NULL
        ON CONFLICT (deduplication_key) DO UPDATE SET
          state = 'READY',
          available_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          lease_token = NULL,
          last_error = NULL,
          updated_at = now()
        WHERE outbox_job.state IN ('COMPLETED', 'FAILED')
      `);
      await client.query('COMMIT');
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: 'enqueue',
            candidates: candidates.rows[0],
            changed: {
              destinationTracking: tracking.rowCount,
              dispatchRecovery: dispatch.rowCount,
              sourceUnknown: source.rowCount,
            },
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [836_483_625]);
  client.release();
  await pool.end();
}
