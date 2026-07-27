import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from '../config/runtime-config';
import type { DatabaseService } from '../database/database.service';
import { AuthNonceCleanupService } from './auth-nonce-cleanup.service';

function runtime(): RuntimeConfig {
  return {
    auth: {
      nonceCleanupBatchSize: 250,
      nonceCleanupIntervalSeconds: 60,
      nonceRetentionSeconds: 86_400,
    },
  } as RuntimeConfig;
}

describe('AuthNonceCleanupService', () => {
  it('deletes at most one configured batch using the retention cutoff', async () => {
    let receivedCutoff: Date | undefined;
    const database = {
      query: jest.fn((_query: string, parameters: readonly unknown[]) => {
        if (parameters[0] instanceof Date) {
          receivedCutoff = parameters[0];
        }
        return Promise.resolve({
          rowCount: 2,
          rows: [{ id: 'one' }, { id: 'two' }],
        });
      }),
    };
    const service = new AuthNonceCleanupService(
      new ConfigService({ runtime: runtime() }),
      database as unknown as DatabaseService,
    );

    await expect(service.cleanup()).resolves.toBe(2);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      [expect.any(Date), 250],
    );
    expect(receivedCutoff).toBeInstanceOf(Date);
    expect(Date.now() - receivedCutoff!.getTime()).toBeGreaterThanOrEqual(
      86_400_000,
    );
  });

  it('does not overlap cleanup runs', async () => {
    let release: (() => void) | undefined;
    const database = {
      query: jest.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ rowCount: 0, rows: [] });
          }),
      ),
    };
    const service = new AuthNonceCleanupService(
      new ConfigService({ runtime: runtime() }),
      database as unknown as DatabaseService,
    );

    const active = service.cleanup();
    await expect(service.cleanup()).resolves.toBe(0);
    expect(database.query).toHaveBeenCalledTimes(1);
    release?.();
    await active;
  });
});
