import { ConfigService } from '@nestjs/config';
import type { Hex } from 'viem';
import type { BlockchainService } from '../blockchain/blockchain.service';
import type { RuntimeConfig } from '../config/runtime-config';
import type { DatabaseService } from '../database/database.service';
import type { PinataStorageService } from '../storage/pinata-storage.service';
import {
  CID_CODEC_RAW,
  computeDocumentId,
  sha256Digest,
} from './canonical-document';
import { registerTypedData, typedDataDigest } from './intent-typed-data';
import { DocumentIntentsService } from './document-intents.service';
import { StorageNetwork } from '../storage/storage-network';

const issuer = '0x0000000000000000000000000000000000000002';
const sender = '0x0000000000000000000000000000000000000001';
const bytes = Buffer.from('exact file bytes');
const contentDigest = sha256Digest(bytes);
const cidDigest = contentDigest;
const cid = 'bafkreibm6jgcbv3dbzqvj5g5jhqadvbs42vqlfc4lcwggg2w4lcavdvs4a';

function runtime(): RuntimeConfig {
  return {
    blockchain: {
      source: {
        chainId: 11155111,
        contractAddress: sender,
      },
    },
    intent: { signatureTtlSeconds: 600 },
  } as unknown as RuntimeConfig;
}

describe('DocumentIntentsService', () => {
  it('prepares a register intent only when local and contract digests match', async () => {
    const sourceReader = {
      readContract: jest.fn(
        ({ functionName, args }: { functionName: string; args: unknown[] }) => {
          if (functionName === 'isIssuerAuthorized') {
            return Promise.resolve(true);
          }
          if (functionName === 'issuerNonce') {
            return Promise.resolve(4n);
          }
          if (functionName === 'getRegisterDocumentDigest') {
            const [
              contractIssuer,
              contractContentDigest,
              ,
              metadataCommitment,
              nonce,
              deadline,
            ] = args as [typeof issuer, Hex, string, Hex, bigint, bigint];
            return Promise.resolve(
              typedDataDigest(
                registerTypedData(
                  { chainId: 11155111, verifyingContract: sender },
                  {
                    cidCodec: CID_CODEC_RAW,
                    cidDigest,
                    contentDigest: contractContentDigest,
                    deadline,
                    documentId: computeDocumentId(
                      contractIssuer,
                      contractContentDigest,
                    ),
                    issuer: contractIssuer,
                    metadataCommitment,
                    nonce,
                  },
                ),
              ),
            );
          }
          throw new Error(`Unexpected function ${functionName}`);
        },
      ),
    };
    const database = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      transaction: jest.fn(
        async (
          operation: (client: { query: jest.Mock }) => Promise<unknown>,
        ) => {
          let insertParameters: unknown[] = [];
          const client = {
            query: jest.fn((query: string, parameters: unknown[]) => {
              if (query.includes('INSERT INTO document_intent')) {
                insertParameters = parameters;
                return Promise.resolve({
                  rows: [
                    {
                      chain_nonce: String(parameters[3]),
                      created_at: new Date(),
                      deadline: new Date(Number(parameters[4]) * 1_000),
                      document_id: parameters[5],
                      failure_code: null,
                      failure_detail: null,
                      id: '0d1b64f2-3281-4cc4-8341-7ccb28dd7d41',
                      idempotency_key: parameters[0],
                      issuer: parameters[2],
                      old_document_id: null,
                      operation: parameters[1],
                      status: 'PREPARED',
                      typed_data: parameters[14],
                      typed_data_digest: parameters[15],
                      updated_at: new Date(),
                    },
                  ],
                });
              }
              if (query.includes('INSERT INTO pinned_artifact')) {
                return Promise.resolve({ rowCount: 1, rows: [] });
              }
              throw new Error(
                `Unexpected query after ${insertParameters.length}`,
              );
            }),
          };
          return operation(client);
        },
      ),
    };
    const storage = {
      pinAndVerify: jest.fn().mockResolvedValue({
        cid,
        cidCodec: CID_CODEC_RAW,
        cidDigest,
        contentDigest,
        providerId: 'pin-id',
        retrievedBytes: bytes.length,
        storageFilename: 'document.pdf',
      }),
    };
    const service = new DocumentIntentsService(
      { sourceReader } as unknown as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      database as unknown as DatabaseService,
      storage as unknown as PinataStorageService,
    );

    await expect(
      service.prepareRegister(
        issuer,
        {
          buffer: bytes,
          mimetype: 'application/pdf',
        } as Express.Multer.File,
        {
          idempotencyKey: 'register-idempotency',
          issuer,
          storageNetwork: StorageNetwork.PRIVATE,
        },
      ),
    ).resolves.toMatchObject({
      chainNonce: '4',
      documentId: computeDocumentId(issuer, contentDigest),
      issuer,
      operation: 'REGISTER',
      status: 'PREPARED',
    });
    expect(storage.pinAndVerify).toHaveBeenCalledTimes(1);
    expect(database.transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a claimed issuer that differs from the JWT subject', async () => {
    const service = new DocumentIntentsService(
      { sourceReader: {} } as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      { query: jest.fn() } as unknown as DatabaseService,
      {} as PinataStorageService,
    );

    await expect(
      service.prepareRevoke(issuer, {
        documentId: contentDigest,
        idempotencyKey: 'revoke-idempotency',
        issuer: '0x0000000000000000000000000000000000000003',
      }),
    ).rejects.toThrow('JWT subject must equal intent issuer');
  });

  it('returns an idempotent intent only when canonical input matches', async () => {
    const existing = {
      canonical_metadata: {},
      chain_nonce: '4',
      content_digest: null,
      created_at: new Date(),
      deadline: new Date(Date.now() + 60_000),
      document_id: contentDigest,
      failure_code: null,
      failure_detail: null,
      id: '0d1b64f2-3281-4cc4-8341-7ccb28dd7d41',
      idempotency_key: 'revoke-idempotency',
      issuer,
      metadata_commitment: null,
      old_document_id: null,
      operation: 'REVOKE',
      status: 'PREPARED',
      typed_data: {},
      typed_data_digest: cidDigest,
      updated_at: new Date(),
    };
    const sourceReader = { readContract: jest.fn() };
    const service = new DocumentIntentsService(
      { sourceReader } as unknown as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      {
        query: jest.fn().mockResolvedValue({ rows: [existing] }),
      } as unknown as DatabaseService,
      {} as PinataStorageService,
    );

    await expect(
      service.prepareRevoke(issuer, {
        documentId: contentDigest,
        idempotencyKey: 'revoke-idempotency',
        issuer,
      }),
    ).resolves.toMatchObject({
      documentId: contentDigest,
      id: existing.id,
    });
    expect(sourceReader.readContract).not.toHaveBeenCalled();

    await expect(
      service.prepareRevoke(issuer, {
        documentId: `0x${'44'.repeat(32)}`,
        idempotencyKey: 'revoke-idempotency',
        issuer,
      }),
    ).rejects.toThrow('different canonical intent input');
    expect(sourceReader.readContract).not.toHaveBeenCalled();
  });

  it('rejects a stale chain nonce before verifying the signature', async () => {
    const deadline = new Date(Date.now() + 60_000);
    const sourceReader = {
      readContract: jest.fn().mockResolvedValue(5n),
      verifyTypedData: jest.fn(),
    };
    const service = new DocumentIntentsService(
      { sourceReader } as unknown as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              canonical_metadata: {},
              chain_nonce: '4',
              content_digest: null,
              created_at: new Date(),
              deadline,
              document_id: contentDigest,
              failure_code: null,
              failure_detail: null,
              id: '0d1b64f2-3281-4cc4-8341-7ccb28dd7d41',
              idempotency_key: 'stale-nonce',
              issuer,
              metadata_commitment: null,
              old_document_id: null,
              operation: 'REVOKE',
              status: 'PREPARED',
              typed_data: {},
              typed_data_digest: cidDigest,
              updated_at: new Date(),
            },
          ],
        }),
      } as unknown as DatabaseService,
      {} as PinataStorageService,
    );

    await expect(
      service.submitSignature(issuer, 'intent-id', `0x${'11'.repeat(65)}`),
    ).rejects.toThrow('Issuer nonce is stale');
    expect(sourceReader.verifyTypedData).not.toHaveBeenCalled();
  });

  it('rejects an invalid EIP-712 signature without enqueueing', async () => {
    const deadline = new Date(Date.now() + 60_000);
    const sourceReader = {
      readContract: jest.fn().mockResolvedValue(4n),
      verifyTypedData: jest.fn().mockResolvedValue(false),
    };
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            canonical_metadata: {},
            chain_nonce: '4',
            content_digest: null,
            created_at: new Date(),
            deadline,
            document_id: contentDigest,
            failure_code: null,
            failure_detail: null,
            id: '0d1b64f2-3281-4cc4-8341-7ccb28dd7d41',
            idempotency_key: 'invalid-signature',
            issuer,
            metadata_commitment: null,
            old_document_id: null,
            operation: 'REVOKE',
            status: 'PREPARED',
            typed_data: {
              message: {
                currentVersion: '1',
                deadline: String(Math.floor(deadline.getTime() / 1_000)),
                documentId: contentDigest,
                nonce: '4',
              },
              primaryType: 'RevokeDocument',
            },
            typed_data_digest: cidDigest,
            updated_at: new Date(),
          },
        ],
      }),
      transaction: jest.fn(),
    };
    const service = new DocumentIntentsService(
      { sourceReader } as unknown as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      database as unknown as DatabaseService,
      {} as PinataStorageService,
    );

    await expect(
      service.submitSignature(issuer, 'intent-id', `0x${'11'.repeat(65)}`),
    ).rejects.toThrow('Invalid intent signature');
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
