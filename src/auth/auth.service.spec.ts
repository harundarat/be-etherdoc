import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { RuntimeConfig } from '../config/runtime-config';
import type { DatabaseService } from '../database/database.service';
import type { BlockchainService } from '../blockchain/blockchain.service';
import { AuthService } from './auth.service';

const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
);

function runtime(): RuntimeConfig {
  return {
    blockchain: {
      source: { chainId: 11155111 },
    },
    jwt: {
      secret: 'a-secure-test-secret-with-more-than-32-characters',
    },
    siwe: {
      domain: 'etherdoc.example',
      nonceTtlSeconds: 300,
      sessionTtlSeconds: 900,
      uri: 'https://etherdoc.example',
    },
  } as RuntimeConfig;
}

function siweMessage(
  issuedAt = new Date(),
  expirationTime = new Date(issuedAt.getTime() + 300_000),
): string {
  return createSiweMessage({
    address: account.address,
    chainId: runtime().blockchain.source.chainId,
    domain: runtime().siwe.domain,
    expirationTime,
    issuedAt,
    nonce: 'abcdefgh',
    uri: runtime().siwe.uri,
    version: '1',
  });
}

describe('AuthService', () => {
  it('creates and atomically consumes a wallet-specific SIWE challenge', async () => {
    let inserted:
      | {
          address: string;
          expiresAt: Date;
          message: string;
          nonce: string;
        }
      | undefined;
    const database = {
      query: jest.fn(
        (_query: string, values?: [string, string, string, Date, Date]) => {
          if (values?.length === 5) {
            inserted = {
              address: values[0],
              nonce: values[1],
              message: values[2],
              expiresAt: values[4],
            };
            return Promise.resolve({ rowCount: 1, rows: [] });
          }
          if (_query.includes('SELECT id')) {
            return Promise.resolve({
              rowCount: 1,
              rows: [
                {
                  expires_at: inserted!.expiresAt,
                  id: 'nonce-id',
                  siwe_message: inserted!.message,
                  wallet_address: inserted!.address,
                },
              ],
            });
          }
          return Promise.resolve({ rowCount: 1, rows: [] });
        },
      ),
    };
    const blockchain = {
      sourceReader: createPublicClient({
        transport: http('http://127.0.0.1:1'),
      }),
    };
    const jwtService = new JwtService({
      secret: runtime().jwt.secret,
      signOptions: { expiresIn: runtime().siwe.sessionTtlSeconds },
    });
    const service = new AuthService(
      blockchain as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      database as unknown as DatabaseService,
      jwtService,
    );

    const challenge = await service.createNonceChallenge(account.address);
    const signature = await account.signMessage({
      message: challenge.message,
    });
    const session = await service.verify(challenge.message, signature);
    expect(session).toMatchObject({
      address: account.address,
      expiresInSeconds: 900,
    });
    const payload = jwtService.decode<{ exp: number; iat: number }>(
      session.accessToken,
    );
    expect(payload.exp - payload.iat).toBe(session.expiresInSeconds);
    expect(database.query).toHaveBeenCalledTimes(3);
  });

  it('rejects a message bound to another domain before signature verification', async () => {
    const service = new AuthService(
      {
        sourceReader: createPublicClient({
          transport: http('http://127.0.0.1:1'),
        }),
      } as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      {
        query: jest.fn(),
      } as unknown as DatabaseService,
      new JwtService({ secret: runtime().jwt.secret }),
    );
    const message =
      `attacker.example wants you to sign in with your Ethereum account:\n` +
      `${account.address}\n\nURI: https://attacker.example\nVersion: 1\n` +
      `Chain ID: 11155111\nNonce: abcdefgh\nIssued At: ${new Date().toISOString()}\n` +
      `Expiration Time: ${new Date(Date.now() + 60_000).toISOString()}`;

    await expect(service.verify(message, '0x00')).rejects.toThrow(
      'domain, URI, chain, or time binding',
    );
  });

  it('allows only one session when a valid challenge is verified concurrently', async () => {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 300_000);
    const challenge = await (async () => {
      const nonceService = new AuthService(
        {
          sourceReader: createPublicClient({
            transport: http('http://127.0.0.1:1'),
          }),
        } as BlockchainService,
        new ConfigService({ runtime: runtime() }),
        {
          query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
        } as unknown as DatabaseService,
        new JwtService({ secret: runtime().jwt.secret }),
      );
      return nonceService.createNonceChallenge(account.address);
    })();
    const signature = await account.signMessage({ message: challenge.message });
    let consumed = false;
    const database = {
      query: jest.fn((query: string) => {
        if (query.includes('SELECT id')) {
          return Promise.resolve({
            rowCount: 1,
            rows: [
              {
                expires_at: expiresAt,
                id: 'nonce-id',
                siwe_message: challenge.message,
                wallet_address: account.address,
              },
            ],
          });
        }
        if (query.includes('UPDATE authentication_nonce')) {
          if (consumed) {
            return Promise.resolve({ rowCount: 0, rows: [] });
          }
          consumed = true;
          return Promise.resolve({ rowCount: 1, rows: [] });
        }
        throw new Error('Unexpected query');
      }),
    };
    const service = new AuthService(
      {
        sourceReader: createPublicClient({
          transport: http('http://127.0.0.1:1'),
        }),
      } as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      database as unknown as DatabaseService,
      new JwtService({
        secret: runtime().jwt.secret,
        signOptions: { expiresIn: runtime().siwe.sessionTtlSeconds },
      }),
    );

    const attempts = await Promise.allSettled([
      service.verify(challenge.message, signature),
      service.verify(challenge.message, signature),
    ]);

    expect(
      attempts.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
  });

  it('rejects an expired stored challenge before signature verification', async () => {
    const message = siweMessage();
    const request = jest.fn();
    const database = {
      query: jest.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            expires_at: new Date(Date.now() - 1),
            id: 'nonce-id',
            siwe_message: message,
            wallet_address: account.address,
          },
        ],
      }),
    };
    const service = new AuthService(
      { sourceReader: { request } } as unknown as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      database as unknown as DatabaseService,
      new JwtService({ secret: runtime().jwt.secret }),
    );

    await expect(service.verify(message, '0x00')).rejects.toThrow(
      'SIWE challenge expired or changed',
    );
    expect(request).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('fails closed when smart-account signature verification loses RPC', async () => {
    const message = siweMessage();
    const request = jest
      .fn()
      .mockRejectedValue(new Error('ERC-1271 RPC unavailable'));
    const database = {
      query: jest.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            expires_at: new Date(Date.now() + 300_000),
            id: 'nonce-id',
            siwe_message: message,
            wallet_address: account.address,
          },
        ],
      }),
    };
    const service = new AuthService(
      { sourceReader: { request } } as unknown as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      database as unknown as DatabaseService,
      new JwtService({ secret: runtime().jwt.secret }),
    );
    const invalidContractSignature = `0x${'00'.repeat(65)}`;

    await expect(
      service.verify(message, invalidContractSignature),
    ).rejects.toThrow('Invalid SIWE signature');
    expect(request).toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledTimes(1);
  });
});
