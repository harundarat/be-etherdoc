import { ConfigService } from '@nestjs/config';
import type { BlockchainService } from '../blockchain/blockchain.service';
import type { RuntimeConfig } from '../config/runtime-config';
import type { DatabaseService } from '../database/database.service';
import type { PinataStorageService } from '../storage/pinata-storage.service';
import { computeDocumentId, sha256Digest } from './canonical-document';
import { DocumentsService } from './documents.service';

const issuer = '0x0000000000000000000000000000000000000003';
const sourceAddress = '0x0000000000000000000000000000000000000001';
const destinationAddress = '0x0000000000000000000000000000000000000002';
const bytes = Buffer.from('canonical PDF bytes');
const contentDigest = sha256Digest(bytes);
const documentId = computeDocumentId(issuer, contentDigest);
const blockHash = `0x${'11'.repeat(32)}`;
const transactionHash = `0x${'22'.repeat(32)}`;

function runtime(): RuntimeConfig {
  return {
    blockchain: {
      destination: {
        chainId: 763373,
        chainSelector: 9_763_904_284_804_119_144n,
        contractAddress: destinationAddress,
      },
      source: {
        chainId: 5003,
        chainSelector: 8_236_463_271_206_331_221n,
        confirmations: 2,
        contractAddress: sourceAddress,
      },
    },
    pinata: {
      apiUrl: 'https://api.pinata.example',
      jwt: 'token',
    },
  } as unknown as RuntimeConfig;
}

function canonicalDocument() {
  return {
    cidCodec: 0x55,
    cidDigest: contentDigest,
    contentDigest,
    documentCID: 'bafkreibm6jgcbv3dbzqvj5g5jhqadvbs42vqlfc4lcwggg2w4lcavdvs4a',
    documentId,
    issuer,
    metadataCommitment: `0x${'33'.repeat(32)}`,
    registeredAt: 1_700_000_000n,
    schemaVersion: 1,
    sourceChainId: 5003n,
    status: 2,
    supersededBy: `0x${'0'.repeat(64)}`,
    supersedes: `0x${'0'.repeat(64)}`,
    updatedAt: 1_700_000_100n,
    version: 2n,
  };
}

function createService() {
  const document = canonicalDocument();
  const sourceReader = {
    getBlock: jest.fn().mockResolvedValue({ hash: blockHash }),
    getBlockNumber: jest.fn().mockResolvedValue(101n),
    readContract: jest.fn(({ functionName }: { functionName: string }) =>
      Promise.resolve(
        functionName === 'verifyDocument' ? [document, true, false] : document,
      ),
    ),
  };
  const destinationReader = { readContract: jest.fn() };
  const database = {
    query: jest.fn((query: string) =>
      Promise.resolve(
        query.includes('FROM document_projection')
          ? {
              rows: [
                {
                  content_digest: contentDigest,
                  document_version: '2',
                  issuer,
                  lifecycle_status: 'REVOKED',
                  source_block_hash: blockHash,
                  source_block_number: '100',
                  source_tx_hash: transactionHash,
                },
              ],
            }
          : { rows: [] },
      ),
    ),
  };
  const storage = {
    checkAvailability: jest.fn().mockResolvedValue({
      available: true,
      checkedAt: '2026-07-25T00:00:00.000Z',
      status: 'AVAILABLE',
    }),
  };
  return {
    service: new DocumentsService(
      {
        destinationReader,
        sourceReader,
      } as unknown as BlockchainService,
      new ConfigService({ runtime: runtime() }),
      database as unknown as DatabaseService,
      storage as unknown as PinataStorageService,
    ),
    sourceReader,
  };
}

describe('DocumentsService read model', () => {
  it('keeps revoked source truth separate from storage availability', async () => {
    const { service } = createService();

    await expect(service.getDocument(documentId)).resolves.toMatchObject({
      canonicalSource: true,
      document: {
        documentId,
        status: 'REVOKED',
        version: '2',
      },
      integrity: {
        active: false,
        matches: true,
      },
      source: {
        confirmationStatus: 'CONFIRMED',
        projectionMatches: true,
        transactionHash,
      },
      storage: {
        authenticity: 'NOT_INFERRED_FROM_AVAILABILITY',
        available: true,
      },
    });
  });

  it('derives file search identity from exact bytes and issuer', async () => {
    const { service, sourceReader } = createService();

    await service.search({ issuer }, {
      buffer: bytes,
      mimetype: 'application/pdf',
    } as Express.Multer.File);

    expect(sourceReader.readContract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: [documentId],
        functionName: 'getDocument',
      }),
    );
  });
});
