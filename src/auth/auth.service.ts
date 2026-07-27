import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getAddress, type Address, type Hex } from 'viem';
import {
  createSiweMessage,
  generateSiweNonce,
  parseSiweMessage,
  verifySiweMessage,
} from 'viem/siwe';
import type { RuntimeConfig } from '../config/runtime-config';
import { DatabaseService } from '../database/database.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import type { LoginResponseDto } from './dto';

export interface NonceChallenge {
  address: Address;
  expiresAt: string;
  message: string;
  nonce: string;
}

interface NonceRow {
  expires_at: Date;
  id: string;
  siwe_message: string;
  wallet_address: string;
}

@Injectable()
export class AuthService {
  private readonly runtime: RuntimeConfig;

  constructor(
    private readonly blockchain: BlockchainService,
    private readonly configService: ConfigService,
    private readonly database: DatabaseService,
    private readonly jwtService: JwtService,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  async createNonceChallenge(wallet: string): Promise<NonceChallenge> {
    const address = this.parseAddress(wallet);
    const nonce = generateSiweNonce();
    const issuedAt = new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + this.runtime.siwe.nonceTtlSeconds * 1_000,
    );
    const message = createSiweMessage({
      address,
      chainId: this.runtime.blockchain.source.chainId,
      domain: this.runtime.siwe.domain,
      expirationTime: expiresAt,
      issuedAt,
      nonce,
      statement: 'Authenticate to Etherdoc without sharing your private key.',
      uri: this.runtime.siwe.uri,
      version: '1',
    });

    await this.database.query(
      `
        INSERT INTO authentication_nonce(
          wallet_address,
          nonce,
          siwe_message,
          issued_at,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [address, nonce, message, issuedAt, expiresAt],
    );

    return {
      address,
      expiresAt: expiresAt.toISOString(),
      message,
      nonce,
    };
  }

  async verify(message: string, signature: string): Promise<LoginResponseDto> {
    const parsed = parseSiweMessage(message);
    if (!parsed.address || !parsed.nonce) {
      throw new UnauthorizedException('Malformed SIWE message');
    }
    const address = this.parseAddress(parsed.address);
    this.assertMessageBinding(parsed);

    const result = await this.database.query<NonceRow>(
      `
        SELECT id, wallet_address, siwe_message, expires_at
        FROM authentication_nonce
        WHERE
          nonce = $1
          AND lower(wallet_address) = lower($2)
          AND consumed_at IS NULL
      `,
      [parsed.nonce, address],
    );
    const challenge = result.rows[0];
    if (!challenge) {
      throw new UnauthorizedException('SIWE nonce is missing or already used');
    }
    if (
      challenge.expires_at.getTime() <= Date.now() ||
      challenge.siwe_message !== message
    ) {
      throw new UnauthorizedException('SIWE challenge expired or changed');
    }

    let valid: boolean;
    try {
      valid = await verifySiweMessage(this.blockchain.sourceReader, {
        address,
        domain: this.runtime.siwe.domain,
        message,
        nonce: parsed.nonce,
        signature: signature as Hex,
        time: new Date(),
      });
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new UnauthorizedException('Invalid SIWE signature');
    }

    const consumed = await this.database.query(
      `
        UPDATE authentication_nonce
        SET consumed_at = now()
        WHERE
          id = $1
          AND siwe_message = $2
          AND consumed_at IS NULL
          AND expires_at > now()
      `,
      [challenge.id, message],
    );
    if (consumed.rowCount !== 1) {
      throw new UnauthorizedException('SIWE nonce replay detected');
    }

    try {
      const accessToken = await this.jwtService.signAsync({
        chainId: this.runtime.blockchain.source.chainId,
        sub: address,
      });
      return {
        accessToken,
        address,
        expiresInSeconds: this.runtime.siwe.sessionTtlSeconds,
      };
    } catch {
      throw new InternalServerErrorException('Unable to create session');
    }
  }

  private assertMessageBinding(
    parsed: ReturnType<typeof parseSiweMessage>,
  ): void {
    if (
      parsed.domain !== this.runtime.siwe.domain ||
      parsed.uri !== this.runtime.siwe.uri ||
      parsed.chainId !== this.runtime.blockchain.source.chainId ||
      parsed.version !== '1' ||
      !parsed.issuedAt ||
      !parsed.expirationTime
    ) {
      throw new UnauthorizedException(
        'SIWE message domain, URI, chain, or time binding is invalid',
      );
    }
    const lifetime =
      parsed.expirationTime.getTime() - parsed.issuedAt.getTime();
    if (lifetime <= 0 || lifetime > this.runtime.siwe.nonceTtlSeconds * 1_000) {
      throw new UnauthorizedException('SIWE message lifetime is invalid');
    }
  }

  private parseAddress(value: string): Address {
    try {
      return getAddress(value);
    } catch {
      throw new UnauthorizedException('Invalid wallet address');
    }
  }
}
