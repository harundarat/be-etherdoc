import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from '../config/runtime-config';
import type { DatabaseService } from '../database/database.service';
import { OperationalStateService } from '../observability/operational-state.service';
import {
  OperationalStatusService,
  sanitizedOperationalError,
} from './operational-status.service';

function runtime(): RuntimeConfig {
  const source = '0x0000000000000000000000000000000000000001';
  const destination = '0x0000000000000000000000000000000000000002';
  return {
    blockchain: {
      destination: { chainId: 2, contractAddress: destination },
      source: { chainId: 1, contractAddress: source },
    },
    worker: { lockTimeoutMs: 60_000 },
  } as unknown as RuntimeConfig;
}

describe('OperationalStatusService', () => {
  it('reports cursor lag, queue state, and sanitized recovery context', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            chain_id: '1',
            contract_address: '0x0000000000000000000000000000000000000001',
            last_finalized_block: '98',
          },
          {
            chain_id: '2',
            contract_address: '0x0000000000000000000000000000000000000002',
            last_finalized_block: '49',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            completed: '10',
            expired_leases: '1',
            failed: '2',
            oldest_ready_age_seconds: '12.9',
            ready: '3',
            running: '1',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ count: '2', job_type: 'SUBMIT_SOURCE', state: 'READY' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            attempt_count: 8,
            dispatch_id: null,
            id: 'job-id',
            intent_id: 'intent-id',
            job_type: 'SUBMIT_SOURCE',
            last_error:
              'request to https://user:password@rpc.example failed token=secret',
            updated_at: new Date('2026-07-27T10:00:00.000Z'),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            failure_code: 'MANUAL_RECOVERY_REQUIRED',
            failure_detail: 'Bearer private-value',
            id: 'dispatch-id',
            updated_at: new Date('2026-07-27T10:00:00.000Z'),
          },
        ],
      });
    const state = new OperationalStateService();
    state.markIndexerSuccess('source', 100n);
    state.markIndexerSuccess('destination', 50n);
    const service = new OperationalStatusService(
      new ConfigService({ runtime: runtime() }),
      { query } as unknown as DatabaseService,
      state,
    );

    await expect(service.status()).resolves.toMatchObject({
      indexers: {
        destination: { cursorBlock: '49', lagBlocks: 1 },
        source: { cursorBlock: '98', lagBlocks: 2 },
      },
      outbox: {
        counts: {
          completed: 10,
          expiredLeases: 1,
          failed: 2,
          ready: 3,
          running: 1,
        },
        oldestReadyAgeSeconds: 12,
        recentFailures: [
          {
            error: 'request to [redacted-url] failed token=[redacted]',
            id: 'job-id',
          },
        ],
      },
      recoveryRequiredDispatches: [
        {
          failureDetail: 'Bearer [redacted]',
          id: 'dispatch-id',
        },
      ],
      status: 'operational',
    });
  });

  it('redacts URLs and credential-shaped values', () => {
    expect(
      sanitizedOperationalError(
        'postgresql://user:pass@database/name password=hunter2',
      ),
    ).toBe('[redacted-url] password=[redacted]');
  });
});
