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
      reclaimExpiredOutboxJobs: jest.fn().mockResolvedValue(0),
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
    await Promise.resolve();
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

describe('OutboxWorkerService retry policy', () => {
  it('moves an exhausted job to FAILED with actionable context', async () => {
    const job: OutboxJob = {
      attemptCount: 3,
      id: 'job-id',
      jobType: 'SUBMIT_SOURCE',
      leaseToken: 'lease-token',
      payload: { intentId: 'intent-id' },
    };
    const failOutboxJob = jest.fn().mockResolvedValue(undefined);
    const retryOutboxJob = jest.fn().mockResolvedValue(undefined);
    const claimOutboxJobs = jest
      .fn()
      .mockResolvedValueOnce([job])
      .mockResolvedValue([]);
    const database = {
      claimOutboxJobs,
      completeOutboxJob: jest.fn().mockResolvedValue(undefined),
      failOutboxJob,
      heartbeatOutboxJob: jest.fn().mockResolvedValue(undefined),
      reclaimExpiredOutboxJobs: jest.fn().mockResolvedValue(0),
      retryOutboxJob,
    } as unknown as DatabaseService;
    const config = {
      getOrThrow: jest.fn().mockReturnValue({
        worker: {
          batchSize: 10,
          drainTimeoutMs: 5_000,
          heartbeatIntervalMs: 60_000,
          maxAttempts: {
            CONFIRM_SOURCE: 3,
            DISPATCH_DESTINATION: 3,
            RECONCILE: 3,
            SUBMIT_SOURCE: 3,
            TRACK_DESTINATION: 3,
          },
          pollIntervalMs: 60_000,
        },
      }),
    } as unknown as ConfigService;
    const sourceWorker = {
      submit: jest.fn().mockRejectedValue(new Error('RPC unavailable')),
    } as unknown as SourceTransactionWorker;
    const service = new OutboxWorkerService(
      config,
      database,
      {} as DestinationWorker,
      {} as DispatchWorker,
      {} as ReconciliationWorker,
      sourceWorker,
    );

    await service.tick();

    expect(failOutboxJob).toHaveBeenCalledWith(
      'job-id',
      'lease-token',
      'Retry exhausted after 3 attempt(s): RPC unavailable',
    );
    expect(retryOutboxJob).not.toHaveBeenCalled();
  });

  it('heartbeats a long-running job before completing its lease', async () => {
    jest.useFakeTimers();
    try {
      const job: OutboxJob = {
        attemptCount: 1,
        id: 'job-id',
        jobType: 'SUBMIT_SOURCE',
        leaseToken: 'lease-token',
        payload: { intentId: 'intent-id' },
      };
      const submission = deferred<void>();
      const heartbeatOutboxJob = jest.fn().mockResolvedValue(undefined);
      const completeOutboxJob = jest.fn().mockResolvedValue(undefined);
      const database = {
        claimOutboxJobs: jest
          .fn()
          .mockResolvedValueOnce([job])
          .mockResolvedValue([]),
        completeOutboxJob,
        heartbeatOutboxJob,
        reclaimExpiredOutboxJobs: jest.fn().mockResolvedValue(0),
      } as unknown as DatabaseService;
      const config = {
        getOrThrow: jest.fn().mockReturnValue({
          worker: {
            batchSize: 10,
            drainTimeoutMs: 5_000,
            heartbeatIntervalMs: 1_000,
            maxAttempts: {
              CONFIRM_SOURCE: 3,
              DISPATCH_DESTINATION: 3,
              RECONCILE: 3,
              SUBMIT_SOURCE: 3,
              TRACK_DESTINATION: 3,
            },
            pollIntervalMs: 60_000,
          },
        }),
      } as unknown as ConfigService;
      const sourceWorker = {
        submit: jest.fn().mockReturnValue(submission.promise),
      } as unknown as SourceTransactionWorker;
      const service = new OutboxWorkerService(
        config,
        database,
        {} as DestinationWorker,
        {} as DispatchWorker,
        {} as ReconciliationWorker,
        sourceWorker,
      );

      const tick = service.tick();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(heartbeatOutboxJob).toHaveBeenCalledWith('job-id', 'lease-token');

      submission.resolve();
      await tick;
      expect(completeOutboxJob).toHaveBeenCalledWith('job-id', 'lease-token');
    } finally {
      jest.useRealTimers();
    }
  });
});
