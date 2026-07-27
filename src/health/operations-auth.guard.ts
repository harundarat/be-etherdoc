import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { RuntimeConfig } from '../config/runtime-config';

function equalSecret(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

@Injectable()
export class OperationsAuthGuard implements CanActivate {
  private readonly token: string;

  constructor(configService: ConfigService) {
    this.token =
      configService.getOrThrow<RuntimeConfig>('runtime').operations.token;
  }

  canActivate(context: ExecutionContext): boolean {
    const authorization = context
      .switchToHttp()
      .getRequest<Request>()
      .header('authorization');
    const candidate = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    if (!equalSecret(candidate, this.token)) {
      throw new UnauthorizedException({
        error: 'OPERATIONS_AUTH_REQUIRED',
        message: 'A valid operations bearer token is required',
      });
    }
    return true;
  }
}
