import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';
import { verifyMessage } from 'ethers';
import { LoginResponseDto, NonceResponseDto } from './dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {}
  async getNonce(): Promise<NonceResponseDto> {
    try {
      const uuid = uuidv4();

      await this.cacheManager.set('nonce', uuid, 100000);

      const address = this.configService.get<string>('ADDRESS_ADMIN');
      if (!address) {
        this.logger.error('ADDRESS_ADMIN is not configured');
        throw new InternalServerErrorException('Server configuration error');
      }

      const messageObject = {
        address: address,
        message: 'auth-login',
        nonce: uuid,
      };

      const messageString = JSON.stringify(messageObject);

      return { messageObject, messageString };
    } catch (error) {
      this.logger.error('Failed to generate nonce:', error.stack);
      if (
        !(error instanceof UnauthorizedException) &&
        !(error instanceof InternalServerErrorException)
      ) {
        throw new InternalServerErrorException(
          'Could not generate authentication nonce',
        );
      }
      throw error;
    }
  }

  async signIn(signature: string): Promise<LoginResponseDto> {
    const addressAdmin = this.configService.get<string>('ADDRESS_ADMIN');
    if (!addressAdmin) {
      this.logger.error('ADDRESS_ADMIN is not configured for sign in.');
      throw new InternalServerErrorException(
        'Server configuration error during sign-in',
      );
    }

    try {
      const nonce = await this.cacheManager.get<string>('nonce');
      if (!nonce) {
        throw new UnauthorizedException(
          'Nonce not found or expired. Please request a new nonce.',
        );
      }

      // reconstruct message
      const messageObject = {
        address: addressAdmin,
        message: 'auth-login',
        nonce: nonce,
      };

      const messageString = JSON.stringify(messageObject);

      const recoveredAddress = verifyMessage(messageString, signature);

      if (recoveredAddress.toLowerCase() != addressAdmin.toLowerCase()) {
        throw new UnauthorizedException('Invalid signature');
      }

      // delete nonce to avoid replay attack
      await this.cacheManager.del('nonce');

      const payload = { sub: addressAdmin, admin: true };

      const accessToken = await this.jwtService.signAsync(payload);
      return { accessToken: accessToken };
    } catch (error) {
      this.logger.error(
        `Sign-in failed for address: ${addressAdmin}: `,
        error.stack,
      );
      if (
        error instanceof UnauthorizedException ||
        error instanceof InternalServerErrorException
      ) {
        throw error;
      }

      throw new InternalServerErrorException(
        'An error occured during the sign-in process.',
      );
    }
  }
}
