import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';
import { verifyMessage } from 'ethers';

@Injectable()
export class AuthService {
  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {}
  async getNonce() {
    try {
      const uuid = uuidv4();

      await this.cacheManager.set('nonce', uuid, 100000);

      const messageObject = {
        address: this.configService.get<string>('ADDRESS_ADMIN'),
        message: 'auth-login',
        nonce: uuid,
      };

      const messageString = JSON.stringify(messageObject);

      return { messageObject, messageString };
    } catch (error) {
      console.error(error);
    }
  }

  async signIn(signature: string) {
    const addressAdmin = this.configService.get<string>('ADDRESS_ADMIN');
    try {
      const nonce = await this.cacheManager.get('nonce');

      // reconstruct message
      const messageObject = {
        address: addressAdmin,
        message: 'auth-login',
        nonce: nonce,
      };

      const messageString = JSON.stringify(messageObject);

      const recoveredAddress = verifyMessage(messageString, signature);

      if (recoveredAddress != addressAdmin) {
        throw new UnauthorizedException('Invalid signature');
      }

      const payload = { sub: addressAdmin, admin: true };

      return await this.jwtService.signAsync(payload);
    } catch (error) {
      console.error(error);
    }
  }
}
