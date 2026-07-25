import { ConfigService } from '@nestjs/config';
import type { Address } from 'viem';
import type { BlockchainService } from '../blockchain/blockchain.service';
import type { RuntimeConfig } from '../config/runtime-config';
import type { DatabaseService } from '../database/database.service';
import { DestinationWorker } from './destination.worker';
import { RetryableJobError } from './worker-errors';

const documentId = `0x${'11'.repeat(32)}`;
const contentDigest = `0x${'22'.repeat(32)}`;
const messageId = `0x${'33'.repeat(32)}`;
const sourceAddress = '0x0000000000000000000000000000000000000001';
const destinationAddress = '0x0000000000000000000000000000000000000002';
const issuer = '0x0000000000000000000000000000000000000003';
const transactionHash = `0x${'44'.repeat(32)}`;
const blockHash = `0x${'55'.repeat(32)}`;

function runtime(): RuntimeConfig {
  const chain = {
    chainSelector: 1n,
    confirmations: 2,
    deploymentBlock: 1n,
    explorerUrl: 'https://explorer.example',
    linkToken: destinationAddress as Address,
    name: 'test',
    rpcUrl: 'https://rpc.example',
    router: destinationAddress as Address,
  };
  return {
    blockchain: {
      destination: {
        ...chain,
        chainId: 2,
        chainSelector: 22n,
        contractAddress: destinationAddress,
      },
      requestTimeoutMs: 1_000,
      signerAddress: issuer,
      signerPrivateKey: `0x${'01'.repeat(32)}`,
      source: {
        ...chain,
        chainId: 1,
        chainSelector: 11n,
        contractAddress: sourceAddress,
      },
    },
    corsOrigin: 'https://app.example',
    databaseUrl: 'postgresql://test',
    dispatch: {
      feeBufferBps: 1_000,
      maximumFeeWei: 1n,
      recoveryAfterSeconds: 3_600,
    },
    intent: { signatureTtlSeconds: 600 },
    jwt: { expiresIn: '15m', secret: 'x'.repeat(32) },
    pinata: {
      apiUrl: 'https://pinata.example',
      gatewayUrl: 'https://gateway.example',
      jwt: 'token',
      uploadUrl: 'https://upload.example',
    },
    port: 3_000,
    siwe: {
      domain: 'app.example',
      nonceTtlSeconds: 300,
      sessionTtlSeconds: 900,
      uri: 'https://app.example',
    },
    worker: {
      batchSize: 10,
      indexBlockRange: 2_000,
      indexIntervalMs: 15_000,
      pollIntervalMs: 1_000,
    },
  };
}

function dispatch() {
  return {
    content_digest: contentDigest,
    document_id: documentId,
    document_status: 'ACTIVE' as const,
    document_version: '1',
    id: 'dispatch-id',
    issuer,
    message_id: messageId,
    sent_at: new Date(),
    status: 'SOURCE_ACCEPTED',
  };
}

function createWorker() {
  const readContract = jest.fn();
  const getContractEvents = jest.fn();
  const destinationReader = {
    getBlockNumber: jest.fn().mockResolvedValue(10n),
    getContractEvents,
    readContract,
  };
  const blockchain = {
    destinationReader,
  } as unknown as BlockchainService;
  const query = jest.fn().mockResolvedValue({ rows: [dispatch()] });
  const clientQuery = jest
    .fn<
      Promise<{ rowCount: number; rows: never[] }>,
      [text: string, values?: readonly unknown[]]
    >()
    .mockResolvedValue({ rowCount: 1, rows: [] });
  const transaction = jest.fn(
    (operation: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
      operation({ query: clientQuery }),
  );
  const database = {
    query,
    transaction,
  } as unknown as DatabaseService;
  const config = {
    getOrThrow: jest.fn().mockReturnValue(runtime()),
  } as unknown as ConfigService;
  return {
    clientQuery,
    destinationReader,
    getContractEvents,
    query,
    readContract,
    transaction,
    worker: new DestinationWorker(blockchain, config, database),
  };
}

describe('DestinationWorker', () => {
  it('defers an unprocessed CCIP message without changing dispatch state', async () => {
    const context = createWorker();
    context.readContract
      .mockResolvedValueOnce({
        documentId,
        documentVersion: 1n,
        processed: false,
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{}, false, false]);

    await expect(context.worker.track('dispatch-id')).rejects.toBeInstanceOf(
      RetryableJobError,
    );
    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('records finalized receiver evidence and confirms the dispatch', async () => {
    const context = createWorker();
    const document = {
      contentDigest,
      documentId,
      issuer,
      status: 1,
      version: 1n,
    };
    context.readContract
      .mockResolvedValueOnce({
        documentId,
        documentVersion: 1n,
        processed: true,
      })
      .mockResolvedValueOnce({
        document,
        messageId,
        sender: sourceAddress,
        sourceChainSelector: 11n,
        status: 1,
      })
      .mockResolvedValueOnce([document, true, true]);
    context.getContractEvents
      .mockResolvedValueOnce([
        {
          args: {
            documentId,
            documentStatus: 1,
            documentVersion: 1n,
            sender: sourceAddress,
            sourceChainSelector: 11n,
          },
          blockHash,
          blockNumber: 9n,
          logIndex: 0,
          transactionHash,
        },
      ])
      .mockResolvedValueOnce([]);

    await context.worker.track('dispatch-id');

    expect(context.clientQuery).toHaveBeenCalledTimes(2);
    expect(context.clientQuery.mock.calls[1][0]).toContain('status = $2');
    expect(context.clientQuery.mock.calls[1][1]).toEqual([
      'dispatch-id',
      'DESTINATION_CONFIRMED',
      transactionHash,
      '9',
      blockHash,
    ]);
  });
});
