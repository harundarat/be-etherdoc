import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import type { RuntimeConfig } from '../config/runtime-config';
import { DatabaseService, type OutboxJob } from '../database/database.service';
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
      const jobs = await this.database.claimOutboxJobs(
        this.workerId,
        this.runtime.worker.batchSize,
      );
      for (const job of jobs) {
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
    try {
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
      } else {
        throw new TerminalJobError(`Unsupported outbox job ${job.jobType}`);
      }
      await this.database.completeOutboxJob(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TerminalJobError) {
        await this.database.failOutboxJob(job.id, message);
        return;
      }
      await this.database.retryOutboxJob(job.id, job.attemptCount, message);
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
