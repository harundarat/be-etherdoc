import { ConfigService } from '@nestjs/config';
import type { DatabaseService, OutboxJob } from '../database/database.service';
import type { DestinationWorker } from './destination.worker';
import type { DispatchWorker } from './dispatch.worker';
import { OutboxWorkerService } from './outbox-worker.service';
import type { ReconciliationWorker } from './reconciliation.worker';
import type { SourceTransactionWorker } from './source-transaction.worker';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('OutboxWorkerService lifecycle', () => {
  it('drains the active tick and refuses new work after shutdown starts', async () => {
    const claim = deferred<OutboxJob[]>();
    const claimOutboxJobs = jest.fn().mockReturnValue(claim.promise);
    const database = {
      claimOutboxJobs,
    } as unknown as DatabaseService;
    const config = {
      getOrThrow: jest.fn().mockReturnValue({
        worker: {
          batchSize: 10,
          drainTimeoutMs: 5_000,
          pollIntervalMs: 60_000,
        },
      }),
    } as unknown as ConfigService;
    const service = new OutboxWorkerService(
      config,
      database,
      {} as DestinationWorker,
      {} as DispatchWorker,
      {} as ReconciliationWorker,
      {} as SourceTransactionWorker,
    );

    const tick = service.tick();
    let drained = false;
    const shutdown = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(drained).toBe(false);
    claim.resolve([]);
    await Promise.all([tick, shutdown]);
    await service.tick();

    expect(claimOutboxJobs).toHaveBeenCalledTimes(1);
  });
});
