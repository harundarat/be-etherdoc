import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { RuntimeConfig } from '../config/runtime-config';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';

describe('AuthController', () => {
  it('sets an explicit cookie whose lifetime matches the session response', async () => {
    const session = {
      accessToken: 'signed.jwt',
      address: '0x0000000000000000000000000000000000000001',
      expiresInSeconds: 1200,
    };
    const authService = {
      verify: jest.fn().mockResolvedValue(session),
    };
    const runtime = {
      http: { cookieSecure: true },
    } as RuntimeConfig;
    const controller = new AuthController(
      authService as unknown as AuthService,
      new ConfigService({ runtime }),
    );
    const cookie = jest.fn();
    const response = { cookie } as unknown as Response;

    await expect(
      controller.verify({ message: 'message', signature: '0x01' }, response),
    ).resolves.toBe(session);
    expect(cookie).toHaveBeenCalledWith('etherdoc-auth', session.accessToken, {
      httpOnly: true,
      maxAge: session.expiresInSeconds * 1_000,
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
  });
});
