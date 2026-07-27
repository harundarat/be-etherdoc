import {
  Global,
  MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { CorrelationContextService } from './correlation-context.service';
import { ExternalRequestObserver } from './external-request-observer.service';
import { OperationalStateService } from './operational-state.service';
import { RequestContextMiddleware } from './request-context.middleware';

@Global()
@Module({
  exports: [
    CorrelationContextService,
    ExternalRequestObserver,
    OperationalStateService,
  ],
  providers: [
    CorrelationContextService,
    ExternalRequestObserver,
    OperationalStateService,
    RequestContextMiddleware,
  ],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes({ method: RequestMethod.ALL, path: '{*splat}' });
  }
}
