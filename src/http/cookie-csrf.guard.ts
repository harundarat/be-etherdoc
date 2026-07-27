import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { RuntimeConfig } from '../config/runtime-config';

const unsafeMethods = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

@Injectable()
export class CookieCsrfGuard implements CanActivate {
  private readonly allowedOrigin: string;

  constructor(configService: ConfigService) {
    const runtime = configService.getOrThrow<RuntimeConfig>('runtime');
    this.allowedOrigin = runtime.corsOrigin;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!unsafeMethods.has(request.method.toUpperCase())) {
      return true;
    }
    const cookie = request.cookies?.['etherdoc-auth'] as unknown;
    if (typeof cookie !== 'string' || !cookie) {
      return true;
    }
    if (/^Bearer\s+\S+$/i.test(request.get('authorization') ?? '')) {
      return true;
    }
    if (request.get('origin') === this.allowedOrigin) {
      return true;
    }
    throw new ForbiddenException({
      error: 'CSRF_ORIGIN_REJECTED',
      message:
        'Cookie-authenticated state changes require the configured Origin',
    });
  }
}
