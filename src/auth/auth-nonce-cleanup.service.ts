import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from '../config/runtime-config';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class AuthNonceCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly batchSize: number;
  private readonly intervalSeconds: number;
  private interval?: NodeJS.Timeout;
  private readonly logger = new Logger(AuthNonceCleanupService.name);
  private readonly retentionSeconds: number;
  private running = false;

  constructor(
    configService: ConfigService,
    private readonly database: DatabaseService,
  ) {
    const runtime = configService.getOrThrow<RuntimeConfig>('runtime');
    this.batchSize = runtime.auth.nonceCleanupBatchSize;
    this.intervalSeconds = runtime.auth.nonceCleanupIntervalSeconds;
    this.retentionSeconds = runtime.auth.nonceRetentionSeconds;
  }

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.cleanup();
    }, this.intervalSeconds * 1_000);
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  async cleanup(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - this.retentionSeconds * 1_000);
      const result = await this.database.query<{ id: string }>(
        `
          WITH candidates AS (
            SELECT id
            FROM authentication_nonce
            WHERE
              (consumed_at IS NOT NULL AND consumed_at < $1)
              OR (consumed_at IS NULL AND expires_at < $1)
            ORDER BY COALESCE(consumed_at, expires_at), id
            FOR UPDATE SKIP LOCKED
            LIMIT $2
          )
          DELETE FROM authentication_nonce AS nonce
          USING candidates
          WHERE nonce.id = candidates.id
          RETURNING nonce.id
        `,
        [cutoff, this.batchSize],
      );
      if (result.rowCount) {
        this.logger.log(`Removed ${result.rowCount} retained SIWE nonce(s)`);
      }
      return result.rowCount ?? 0;
    } catch (error) {
      this.logger.error(
        'SIWE nonce cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
