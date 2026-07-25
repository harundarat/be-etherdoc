import { Body, Controller, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuthService, type NonceChallenge } from './auth.service';
import { LoginResponseDto, RequestNonceDto, VerifyAuthDto } from './dto';
import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from '../config/runtime-config';

@Controller('auth')
export class AuthController {
  private readonly secureCookie: boolean;

  constructor(
    private readonly authService: AuthService,
    configService: ConfigService,
  ) {
    const runtime = configService.getOrThrow<RuntimeConfig>('runtime');
    this.secureCookie = new URL(runtime.siwe.uri).protocol === 'https:';
  }

  @Post('nonce')
  createNonce(@Body() request: RequestNonceDto): Promise<NonceChallenge> {
    return this.authService.createNonceChallenge(request.address);
  }

  @Post('verify')
  async verify(
    @Body() request: VerifyAuthDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponseDto> {
    const session = await this.authService.verify(
      request.message,
      request.signature,
    );
    response.cookie('etherdoc-auth', session.accessToken, {
      httpOnly: true,
      maxAge: session.expiresInSeconds * 1_000,
      sameSite: 'lax',
      secure: this.secureCookie,
    });
    return session;
  }
}
