import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import type { RuntimeConfig } from '../config/runtime-config';
import { CookieCsrfGuard } from './cookie-csrf.guard';
import {
  clientTracker,
  EtherdocThrottlerGuard,
  walletFromRequest,
  walletTracker,
} from './rate-limit.guard';

function requestPath(request: Request): string {
  return request.path || request.originalUrl.split('?')[0];
}

function isAuthRequest(request: Request): boolean {
  return ['/auth/nonce', '/auth/verify'].includes(requestPath(request));
}

function isJsonSearch(request: Request): boolean {
  return (
    requestPath(request) === '/documents/search' &&
    !request.is('multipart/form-data')
  );
}

function isMultipart(request: Request): boolean {
  return Boolean(request.is('multipart/form-data'));
}

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { rateLimit } =
          configService.getOrThrow<RuntimeConfig>('runtime');
        return {
          errorMessage: 'RATE_LIMIT_EXCEEDED',
          throttlers: [
            {
              getTracker: clientTracker,
              limit: rateLimit.apiLimit,
              name: 'api',
              ttl: rateLimit.windowMs,
            },
            {
              getTracker: clientTracker,
              limit: rateLimit.authLimit,
              name: 'auth-ip',
              skipIf: (context) =>
                !isAuthRequest(context.switchToHttp().getRequest<Request>()),
              ttl: rateLimit.windowMs,
            },
            {
              getTracker: walletTracker,
              limit: rateLimit.authLimit,
              name: 'auth-wallet',
              skipIf: (context) =>
                !isAuthRequest(context.switchToHttp().getRequest<Request>()),
              ttl: rateLimit.windowMs,
            },
            {
              getTracker: clientTracker,
              limit: rateLimit.searchLimit,
              name: 'search-ip',
              skipIf: (context) =>
                !isJsonSearch(context.switchToHttp().getRequest<Request>()),
              ttl: rateLimit.windowMs,
            },
            {
              getTracker: walletTracker,
              limit: rateLimit.searchLimit,
              name: 'search-wallet',
              skipIf: (context) => {
                const request = context.switchToHttp().getRequest<Request>();
                return !isJsonSearch(request) || !walletFromRequest(request);
              },
              ttl: rateLimit.windowMs,
            },
            {
              getTracker: clientTracker,
              limit: rateLimit.uploadLimit,
              name: 'upload-ip',
              skipIf: (context) =>
                !isMultipart(context.switchToHttp().getRequest<Request>()),
              ttl: rateLimit.windowMs,
            },
          ],
        };
      },
    }),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: EtherdocThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CookieCsrfGuard,
    },
  ],
})
export class HttpSecurityModule {}
