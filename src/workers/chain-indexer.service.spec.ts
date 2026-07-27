import {
  ChainIndexerService,
  cursorRequiresRebuild,
  normalizedIndexedLog,
} from './chain-indexer.service';
import { ConfigService } from '@nestjs/config';
import type { BlockchainService } from '../blockchain/blockchain.service';
import type { DatabaseService } from '../database/database.service';
import { OperationalStateService } from '../observability/operational-state.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('normalizedIndexedLog', () => {
  it('keeps lossless finalized log evidence', () => {
    const log = normalizedIndexedLog('MessageSent', {
      args: { destinationChainSelector: 8_236_463_271_206_331_221n },
      blockHash: `0x${'11'.repeat(32)}`,
      blockNumber: 42n,
      logIndex: 3,
      transactionHash: `0x${'22'.repeat(32)}`,
    });

    expect(log).toEqual({
      args: { destinationChainSelector: 8_236_463_271_206_331_221n },
      blockHash: `0x${'11'.repeat(32)}`,
      blockNumber: 42n,
      eventName: 'MessageSent',
      logIndex: 3,
      transactionHash: `0x${'22'.repeat(32)}`,
    });
  });

  it('rejects logs without complete canonical block identity', () => {
    expect(
      normalizedIndexedLog('MessageReceived', {
        args: {},
        blockHash: null,
        blockNumber: 42n,
        logIndex: 3,
        transactionHash: `0x${'22'.repeat(32)}`,
      }),
    ).toBeNull();
  });
});

describe('cursorRequiresRebuild', () => {
  const storedHash = `0x${'11'.repeat(32)}` as const;

  it('keeps a cursor only while its finalized block hash remains canonical', () => {
    expect(cursorRequiresRebuild(42n, storedHash, 50n, storedHash)).toBe(false);
    expect(
      cursorRequiresRebuild(42n, storedHash, 50n, `0x${'22'.repeat(32)}`),
    ).toBe(true);
    expect(cursorRequiresRebuild(42n, storedHash, 41n, storedHash)).toBe(true);
  });
});

describe('ChainIndexerService lifecycle', () => {
  it('drains the active tick and refuses new work after shutdown starts', async () => {
    const lock = deferred<boolean>();
    const withTryAdvisoryLock = jest.fn().mockReturnValue(lock.promise);
    const database = {
      withTryAdvisoryLock,
    } as unknown as DatabaseService;
    const config = {
      getOrThrow: jest.fn().mockReturnValue({
        worker: {
          drainTimeoutMs: 5_000,
          indexIntervalMs: 60_000,
        },
      }),
    } as unknown as ConfigService;
    const service = new ChainIndexerService(
      {} as BlockchainService,
      config,
      database,
      new OperationalStateService(),
    );

    const tick = service.tick();
    let drained = false;
    const shutdown = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(drained).toBe(false);
    lock.resolve(false);
    await Promise.all([tick, shutdown]);
    await service.tick();

    expect(withTryAdvisoryLock).toHaveBeenCalledTimes(2);
  });
});
