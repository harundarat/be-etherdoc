import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { getAddress, type Address } from 'viem';
import type { RuntimeConfig } from '../config/runtime-config';

interface JwtPayload {
  chainId: number;
  sub: string;
}

export interface AuthenticatedUser {
  address: Address;
  chainId: number;
}

const cookieExtractor = (request: Request): string | null => {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const token = cookies?.['etherdoc-auth'];
  return typeof token === 'string' ? token : null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly sourceChainId: number;

  constructor(configService: ConfigService) {
    const runtime = configService.getOrThrow<RuntimeConfig>('runtime');
    super({
      ignoreExpiration: false,
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: runtime.jwt.secret,
    });
    this.sourceChainId = runtime.blockchain.source.chainId;
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (
      !payload ||
      typeof payload.sub !== 'string' ||
      payload.chainId !== this.sourceChainId
    ) {
      throw new UnauthorizedException('Invalid token payload');
    }
    try {
      return {
        address: getAddress(payload.sub),
        chainId: payload.chainId,
      };
    } catch {
      throw new UnauthorizedException('Invalid token subject');
    }
  }
}
