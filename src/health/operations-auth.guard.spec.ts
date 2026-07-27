import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { RuntimeConfig } from '../config/runtime-config';
import { OperationsAuthGuard } from './operations-auth.guard';

const token = 'an-independent-operations-token-123456789';

function guard(): OperationsAuthGuard {
  const runtime = { operations: { token } } as RuntimeConfig;
  return new OperationsAuthGuard(new ConfigService({ runtime }));
}

function context(authorization?: string): ExecutionContext {
  const request = {
    header: jest.fn().mockReturnValue(authorization),
  } as unknown as Request;
  return {
    switchToHttp: () => ({
      getNext: jest.fn(),
      getRequest: () => request,
      getResponse: jest.fn(),
    }),
  } as unknown as ExecutionContext;
}

describe('OperationsAuthGuard', () => {
  it('accepts only the exact operations bearer credential', () => {
    expect(guard().canActivate(context(`Bearer ${token}`))).toBe(true);
  });

  it.each([
    undefined,
    '',
    token,
    'Basic credentials',
    `Bearer ${token}-suffix`,
  ])('rejects a missing or invalid authorization value', (authorization) => {
    expect(() => guard().canActivate(context(authorization))).toThrow(
      UnauthorizedException,
    );
  });

  it('returns a stable operator authentication error', () => {
    try {
      guard().canActivate(context('Bearer invalid'));
      throw new Error('Expected the guard to reject invalid credentials');
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      if (!(error instanceof UnauthorizedException)) {
        throw error;
      }
      expect(error.getResponse()).toEqual({
        error: 'OPERATIONS_AUTH_REQUIRED',
        message: 'A valid operations bearer token is required',
      });
    }
  });
});
