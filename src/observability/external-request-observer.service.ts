import { Injectable, Logger } from '@nestjs/common';
import { CorrelationContextService } from './correlation-context.service';
import { redactSensitiveText } from './log-safety';

export type ExternalDependency = 'pinata' | 'rpc';

export function classifyExternalFailure(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message}`.toLowerCase()
      : String(error).toLowerCase();
  if (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('abort')
  ) {
    return 'TIMEOUT';
  }
  if (
    text.includes('fetch failed') ||
    text.includes('network') ||
    text.includes('connection')
  ) {
    return 'NETWORK';
  }
  return 'UNKNOWN';
}

@Injectable()
export class ExternalRequestObserver {
  private readonly logger = new Logger(ExternalRequestObserver.name);

  constructor(private readonly correlation: CorrelationContextService) {}

  async fetch(
    dependency: ExternalDependency,
    operation: string,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const startedAt = performance.now();
    try {
      const response = await fetch(input, init);
      const record = {
        correlationId: this.correlation.currentId(),
        dependency,
        durationMs: Math.round(performance.now() - startedAt),
        event: 'external_request_completed',
        failureClassification: response.ok ? null : `HTTP_${response.status}`,
        operation,
        outcome: response.ok ? 'success' : 'failure',
        statusCode: response.status,
      };
      if (response.ok) {
        this.logger.log(record);
      } else {
        this.logger.warn(record);
      }
      return response;
    } catch (error) {
      this.logger.error(
        {
          correlationId: this.correlation.currentId(),
          dependency,
          durationMs: Math.round(performance.now() - startedAt),
          event: 'external_request_failed',
          failureClassification: classifyExternalFailure(error),
          operation,
          outcome: 'failure',
        },
        redactSensitiveText(error instanceof Error ? error.stack : null),
      );
      throw error;
    }
  }
}
