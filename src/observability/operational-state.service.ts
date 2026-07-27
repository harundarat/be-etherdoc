import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';

export type ChainSide = 'destination' | 'source';

export interface IndexerState {
  finalizedHead: string | null;
  lastSuccessfulTickAt: string | null;
}

export interface OperationalStateSnapshot {
  blockchainReady: boolean;
  indexers: Record<ChainSide, IndexerState>;
  shuttingDown: boolean;
}

@Injectable()
export class OperationalStateService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(OperationalStateService.name);
  private blockchainReady = false;
  private readonly indexers: Record<ChainSide, IndexerState> = {
    destination: { finalizedHead: null, lastSuccessfulTickAt: null },
    source: { finalizedHead: null, lastSuccessfulTickAt: null },
  };
  private shuttingDown = false;

  beforeApplicationShutdown(signal?: string): void {
    this.shuttingDown = true;
    this.logger.warn({
      event: 'graceful_shutdown_started',
      signal: signal ?? 'application_close',
    });
  }

  markBlockchainReady(): void {
    this.blockchainReady = true;
  }

  markIndexerSuccess(side: ChainSide, finalizedHead: bigint): void {
    this.indexers[side] = {
      finalizedHead: finalizedHead.toString(),
      lastSuccessfulTickAt: new Date().toISOString(),
    };
  }

  snapshot(): OperationalStateSnapshot {
    return {
      blockchainReady: this.blockchainReady,
      indexers: {
        destination: { ...this.indexers.destination },
        source: { ...this.indexers.source },
      },
      shuttingDown: this.shuttingDown,
    };
  }
}
