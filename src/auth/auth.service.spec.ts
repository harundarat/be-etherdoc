import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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
      expiresIn: '15m',
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
        (_query: string, values: [string, string, string, Date, Date]) => {
          inserted = {
            address: values[0],
            nonce: values[1],
            message: values[2],
            expiresAt: values[4],
          };
          return Promise.resolve({ rowCount: 1, rows: [] });
        },
      ),
      transaction: jest.fn(
        async (
          operation: (client: { query: jest.Mock }) => Promise<unknown>,
        ) => {
          let calls = 0;
          return operation({
            query: jest.fn(() => {
              calls += 1;
              if (calls === 1) {
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
            }),
          });
        },
      ),
    };
    const blockchain = {
      sourceReader: createPublicClient({
        transport: http('http://127.0.0.1:1'),
      }),
    };
    const service = new AuthService(
      blockchain as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      database as unknown as DatabaseService,
      new JwtService({ secret: runtime().jwt.secret }),
    );

    const challenge = await service.createNonceChallenge(account.address);
    const signature = await account.signMessage({
      message: challenge.message,
    });
    await expect(
      service.verify(challenge.message, signature),
    ).resolves.toMatchObject({
      address: account.address,
      expiresInSeconds: 900,
    });
    expect(database.transaction).toHaveBeenCalledTimes(1);
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
        transaction: jest.fn(),
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
});
