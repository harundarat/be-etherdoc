import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from '../config/runtime-config';
import { DatabaseService } from '../database/database.service';
import { OperationalStateService } from '../observability/operational-state.service';

export interface LivenessReport {
  checkedAt: string;
  status: 'live';
}

export interface ReadinessReport {
  checkedAt: string;
  checks: {
    blockchainStartup: 'ready' | 'starting';
    database: 'not_checked' | 'ready' | 'unavailable';
    schema: 'missing' | 'not_checked' | 'ready' | 'unknown';
  };
  status: 'degraded' | 'ready' | 'shutting_down';
}

interface DatabaseReadiness {
  database: 'ready' | 'unavailable';
  schema: 'ready' | 'missing' | 'unknown';
}

@Injectable()
export class HealthService {
  private readonly cacheMs: number;
  private cachedDatabase:
    { expiresAt: number; value: DatabaseReadiness } | undefined;
  private databaseCheck: Promise<DatabaseReadiness> | undefined;

  constructor(
    configService: ConfigService,
    private readonly database: DatabaseService,
    private readonly state: OperationalStateService,
  ) {
    this.cacheMs =
      configService.getOrThrow<RuntimeConfig>(
        'runtime',
      ).health.readinessCacheMs;
  }

  live(): LivenessReport {
    return {
      checkedAt: new Date().toISOString(),
      status: 'live',
    };
  }

  async ready(): Promise<ReadinessReport> {
    const operational = this.state.snapshot();
    const checkedAt = new Date().toISOString();
    if (operational.shuttingDown) {
      return {
        checkedAt,
        checks: {
          blockchainStartup: operational.blockchainReady ? 'ready' : 'starting',
          database: 'not_checked',
          schema: 'not_checked',
        },
        status: 'shutting_down',
      };
    }

    const database = await this.databaseReadiness();
    const blockchainStartup = operational.blockchainReady
      ? 'ready'
      : 'starting';
    return {
      checkedAt,
      checks: {
        blockchainStartup,
        ...database,
      },
      status:
        database.database === 'ready' &&
        database.schema === 'ready' &&
        blockchainStartup === 'ready'
          ? 'ready'
          : 'degraded',
    };
  }

  private databaseReadiness(): Promise<DatabaseReadiness> {
    const now = Date.now();
    if (this.cachedDatabase && this.cachedDatabase.expiresAt > now) {
      return Promise.resolve(this.cachedDatabase.value);
    }
    if (this.databaseCheck) {
      return this.databaseCheck;
    }
    const check = this.database
      .readiness()
      .then((schemaPresent) => ({
        database: 'ready' as const,
        schema: schemaPresent ? ('ready' as const) : ('missing' as const),
      }))
      .catch(() => ({
        database: 'unavailable' as const,
        schema: 'unknown' as const,
      }))
      .then((value) => {
        this.cachedDatabase = {
          expiresAt: Date.now() + this.cacheMs,
          value,
        };
        return value;
      })
      .finally(() => {
        if (this.databaseCheck === check) {
          this.databaseCheck = undefined;
        }
      });
    this.databaseCheck = check;
    return check;
  }
}
