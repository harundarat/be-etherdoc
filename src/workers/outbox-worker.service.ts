import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import type { RuntimeConfig } from '../config/runtime-config';
import {
  DatabaseService,
  type OutboxJob,
  OutboxLeaseLostError,
} from '../database/database.service';
import { DestinationWorker } from './destination.worker';
import { DispatchWorker } from './dispatch.worker';
import { ReconciliationWorker } from './reconciliation.worker';
import { SourceTransactionWorker } from './source-transaction.worker';
import { TerminalJobError } from './worker-errors';

@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private readonly runtime: RuntimeConfig;
  private readonly workerId = `${hostname()}:${process.pid}`;
  private activeTick: Promise<void> | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    configService: ConfigService,
    private readonly database: DatabaseService,
    private readonly destinationWorker: DestinationWorker,
    private readonly dispatchWorker: DispatchWorker,
    private readonly reconciliationWorker: ReconciliationWorker,
    private readonly sourceWorker: SourceTransactionWorker,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.tick();
    }, this.runtime.worker.pollIntervalMs);
    this.interval.unref();
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.drainActiveTick();
  }

  tick(): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    if (this.activeTick) {
      return this.activeTick;
    }
    const tick = this.runTick().finally(() => {
      if (this.activeTick === tick) {
        this.activeTick = null;
      }
    });
    this.activeTick = tick;
    return tick;
  }

  private async runTick(): Promise<void> {
    try {
      const reclaimed = await this.database.reclaimExpiredOutboxJobs(
        this.runtime.worker.batchSize,
      );
      if (reclaimed > 0) {
        this.logger.warn(`Reclaimed ${reclaimed} expired outbox lease(s)`);
      }
      for (
        let claimed = 0;
        claimed < this.runtime.worker.batchSize && !this.stopping;
        claimed += 1
      ) {
        const [job] = await this.database.claimOutboxJobs(this.workerId, 1);
        if (!job) {
          break;
        }
        await this.process(job);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Outbox polling failed: ${message}`);
    }
  }

  private async drainActiveTick(): Promise<void> {
    const activeTick = this.activeTick;
    if (!activeTick) {
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = Symbol('timed-out');
    const result = await Promise.race([
      activeTick,
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(
          () => resolve(timedOut),
          this.runtime.worker.drainTimeoutMs,
        );
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (result === timedOut) {
      this.logger.error(
        `Shutdown drain timed out after ${this.runtime.worker.drainTimeoutMs}ms with an active outbox tick`,
      );
    }
  }

  private async process(job: OutboxJob): Promise<void> {
    const heartbeatState: { promise: Promise<void> | null } = {
      promise: null,
    };
    let leaseLost = false;
    const heartbeat = (): void => {
      if (heartbeatState.promise || leaseLost) {
        return;
      }
      const operation = this.database
        .heartbeatOutboxJob(job.id, job.leaseToken)
        .catch((error: unknown) => {
          if (error instanceof OutboxLeaseLostError) {
            leaseLost = true;
            this.logger.warn(error.message);
            return;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Outbox heartbeat failed for job ${job.id}: ${message}`,
          );
        })
        .finally(() => {
          if (heartbeatState.promise === operation) {
            heartbeatState.promise = null;
          }
        });
      heartbeatState.promise = operation;
    };
    const heartbeatInterval = setInterval(
      heartbeat,
      this.runtime.worker.heartbeatIntervalMs,
    );
    heartbeatInterval.unref();

    try {
      await this.execute(job);
    } catch (error) {
      clearInterval(heartbeatInterval);
      await this.settleHeartbeat(heartbeatState);
      if (leaseLost) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TerminalJobError) {
        await this.transitionWithLease(
          job,
          () => this.database.failOutboxJob(job.id, job.leaseToken, message),
          `Outbox job ${job.id} failed terminally: ${message}`,
        );
        return;
      }
      const maxAttempts = this.runtime.worker.maxAttempts[job.jobType];
      if (job.attemptCount >= maxAttempts) {
        const exhausted = `Retry exhausted after ${job.attemptCount} attempt(s): ${message}`;
        await this.transitionWithLease(
          job,
          () => this.database.failOutboxJob(job.id, job.leaseToken, exhausted),
          `Outbox job ${job.id} exhausted retries: ${message}`,
        );
        return;
      }
      await this.transitionWithLease(job, () =>
        this.database.retryOutboxJob(
          job.id,
          job.leaseToken,
          job.attemptCount,
          message,
        ),
      );
      return;
    }

    clearInterval(heartbeatInterval);
    await this.settleHeartbeat(heartbeatState);
    if (leaseLost) {
      return;
    }
    await this.transitionWithLease(job, () =>
      this.database.completeOutboxJob(job.id, job.leaseToken),
    );
  }

  private async settleHeartbeat(state: {
    promise: Promise<void> | null;
  }): Promise<void> {
    if (state.promise) {
      await state.promise;
    }
  }

  private async execute(job: OutboxJob): Promise<void> {
    if (job.jobType === 'SUBMIT_SOURCE') {
      await this.sourceWorker.submit(this.payloadId(job, 'intentId'));
    } else if (job.jobType === 'CONFIRM_SOURCE') {
      await this.sourceWorker.confirm(this.payloadId(job, 'intentId'));
    } else if (job.jobType === 'DISPATCH_DESTINATION') {
      await this.dispatchWorker.dispatch(this.payloadId(job, 'dispatchId'));
    } else if (job.jobType === 'TRACK_DESTINATION') {
      await this.destinationWorker.track(this.payloadId(job, 'dispatchId'));
    } else if (job.jobType === 'RECONCILE') {
      await this.reconciliationWorker.reconcile(job.payload);
    }
  }

  private async transitionWithLease(
    job: OutboxJob,
    transition: () => Promise<void>,
    alert?: string,
  ): Promise<void> {
    try {
      await transition();
      if (alert) {
        this.logger.error(alert);
      }
    } catch (error) {
      if (error instanceof OutboxLeaseLostError) {
        this.logger.warn(error.message);
        return;
      }
      throw error;
    }
  }

  private payloadId(job: OutboxJob, key: string): string {
    const value = job.payload[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new TerminalJobError(
        `Outbox job ${job.id} has invalid ${key} payload`,
      );
    }
    return value;
  }
}
