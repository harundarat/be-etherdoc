import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { CorrelationContextService } from './correlation-context.service';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestContextMiddleware.name);

  constructor(private readonly correlation: CorrelationContextService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const supplied = request.header('x-request-id');
    const correlationId =
      supplied && uuidPattern.test(supplied) ? supplied : randomUUID();
    const startedAt = performance.now();
    response.setHeader('X-Request-ID', correlationId);

    this.correlation.run(correlationId, () => {
      response.once('finish', () => {
        this.logger.log({
          correlationId,
          durationMs: Math.round(performance.now() - startedAt),
          event: 'http_request_completed',
          method: request.method,
          path: request.path,
          statusCode: response.statusCode,
        });
      });
      next();
    });
  }
}
