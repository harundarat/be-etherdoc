import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import type { RuntimeConfig } from '../config/runtime-config';

// Extract jwt from cookie
const cookieExtractor = (req: Request): string | null => {
  let token: string | null = null;
  if (req && req.cookies) {
    token = req.cookies['etherdoc-auth'];
  }
  return token;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private configService: ConfigService) {
    const runtime =
      configService.getOrThrow<RuntimeConfig>('runtime');
    super({
      // Prioritize extraction from cookie, then from Authorization Bearer header
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: runtime.jwt.secret,
    });
  }

  async validate(payload: any) {
    if (!payload || !payload.sub || typeof payload.admin !== 'boolean') {
      throw new UnauthorizedException('Invalid token payload');
    }

    return { address: payload.sub, isAdmin: payload.admin };
  }
}
