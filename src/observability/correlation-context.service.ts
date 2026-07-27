import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

interface CorrelationStore {
  correlationId: string;
}

@Injectable()
export class CorrelationContextService {
  private readonly storage = new AsyncLocalStorage<CorrelationStore>();

  currentId(): string | null {
    return this.storage.getStore()?.correlationId ?? null;
  }

  run<T>(correlationId: string, operation: () => T): T {
    return this.storage.run({ correlationId }, operation);
  }
}
