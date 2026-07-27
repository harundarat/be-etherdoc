import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
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
import { CorrelationContextService } from '../observability/correlation-context.service';
import { redactSensitiveText } from '../observability/log-safety';

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
    @Optional() private readonly correlation?: CorrelationContextService,
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
        this.logger.warn({
          event: 'outbox_expired_leases_reclaimed',
          reclaimed,
        });
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
        const correlationId = this.jobCorrelationId(job);
        if (this.correlation) {
          await this.correlation.run(correlationId, () => this.process(job));
        } else {
          await this.process(job);
        }
      }
    } catch (error) {
      this.logger.error(
        {
          errorClassification: this.errorClassification(error),
          event: 'outbox_poll_failed',
        },
        redactSensitiveText(error instanceof Error ? error.stack : null),
      );
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
      this.logger.error({
        drainTimeoutMs: this.runtime.worker.drainTimeoutMs,
        event: 'outbox_shutdown_drain_timed_out',
      });
    }
  }

  private async process(job: OutboxJob): Promise<void> {
    const startedAt = performance.now();
    const context = this.jobLogContext(job);
    this.logger.log({
      ...context,
      event: 'outbox_job_started',
    });
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
            this.logger.warn({
              ...context,
              event: 'outbox_lease_lost',
              operation: 'heartbeat',
            });
            return;
          }
          this.logger.error(
            {
              ...context,
              errorClassification: this.errorClassification(error),
              event: 'outbox_heartbeat_failed',
            },
            redactSensitiveText(error instanceof Error ? error.stack : null),
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
        const transitioned = await this.transitionWithLease(job, () =>
          this.database.failOutboxJob(job.id, job.leaseToken, message),
        );
        if (transitioned) {
          this.logJobError(
            'outbox_job_failed_terminally',
            job,
            error,
            startedAt,
          );
        }
        return;
      }
      const maxAttempts = this.runtime.worker.maxAttempts[job.jobType];
      if (job.attemptCount >= maxAttempts) {
        const exhausted = `Retry exhausted after ${job.attemptCount} attempt(s): ${message}`;
        const transitioned = await this.transitionWithLease(job, () =>
          this.database.failOutboxJob(job.id, job.leaseToken, exhausted),
        );
        if (transitioned) {
          this.logJobError('outbox_job_retry_exhausted', job, error, startedAt);
        }
        return;
      }
      const transitioned = await this.transitionWithLease(job, () =>
        this.database.retryOutboxJob(
          job.id,
          job.leaseToken,
          job.attemptCount,
          message,
        ),
      );
      if (transitioned) {
        this.logger.warn({
          ...context,
          durationMs: Math.round(performance.now() - startedAt),
          errorClassification: this.errorClassification(error),
          event: 'outbox_job_retry_scheduled',
        });
      }
      return;
    }

    clearInterval(heartbeatInterval);
    await this.settleHeartbeat(heartbeatState);
    if (leaseLost) {
      return;
    }
    const transitioned = await this.transitionWithLease(job, () =>
      this.database.completeOutboxJob(job.id, job.leaseToken),
    );
    if (transitioned) {
      this.logger.log({
        ...context,
        durationMs: Math.round(performance.now() - startedAt),
        event: 'outbox_job_completed',
      });
    }
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
  ): Promise<boolean> {
    try {
      await transition();
      return true;
    } catch (error) {
      if (error instanceof OutboxLeaseLostError) {
        this.logger.warn({
          ...this.jobLogContext(job),
          event: 'outbox_lease_lost',
          operation: 'state_transition',
        });
        return false;
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

  private errorClassification(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
  }

  private jobCorrelationId(job: OutboxJob): string {
    const correlationId = job.payload.correlationId;
    return typeof correlationId === 'string' && correlationId.length <= 128
      ? correlationId
      : `outbox:${job.id}`;
  }

  private jobLogContext(job: OutboxJob) {
    return {
      attempt: job.attemptCount,
      correlationId: this.jobCorrelationId(job),
      dispatchId:
        typeof job.payload.dispatchId === 'string'
          ? job.payload.dispatchId
          : null,
      intentId:
        typeof job.payload.intentId === 'string' ? job.payload.intentId : null,
      jobId: job.id,
      jobType: job.jobType,
      leaseOwner: this.workerId,
      leaseFingerprint: createHash('sha256')
        .update(job.leaseToken)
        .digest('hex')
        .slice(0, 12),
    };
  }

  private logJobError(
    event: string,
    job: OutboxJob,
    error: unknown,
    startedAt: number,
  ): void {
    this.logger.error(
      {
        ...this.jobLogContext(job),
        durationMs: Math.round(performance.now() - startedAt),
        errorClassification: this.errorClassification(error),
        event,
      },
      redactSensitiveText(error instanceof Error ? error.stack : null),
    );
  }
}
