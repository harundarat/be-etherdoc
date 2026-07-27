import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import type { BlockchainService } from '../blockchain/blockchain.service';
import type { RuntimeConfig } from '../config/runtime-config';
import type { DatabaseService } from '../database/database.service';
import {
  classifySourceFailure,
  SourceTransactionWorker,
} from './source-transaction.worker';

const issuer = '0x0000000000000000000000000000000000000001';
const signer = '0x0000000000000000000000000000000000000002';
const sender = '0x0000000000000000000000000000000000000003';
const documentId = `0x${'11'.repeat(32)}` as const;
const contentDigest = `0x${'22'.repeat(32)}` as const;
const metadataCommitment = `0x${'33'.repeat(32)}` as const;

function runtime(): RuntimeConfig {
  return {
    blockchain: {
      requestTimeoutMs: 15_000,
      signerAddress: signer,
      source: {
        chainId: 11_155_111,
        confirmations: 2,
        contractAddress: sender,
      },
    },
  } as unknown as RuntimeConfig;
}

describe('classifySourceFailure', () => {
  it.each([
    ['RPC connection refused', 'RETRYABLE'],
    ['request timed out', 'RETRYABLE'],
    ['RegistrationIsPaused()', 'RETRYABLE'],
    ['SignatureExpired(123)', 'TERMINAL'],
    ['InvalidIssuerSignature(0x01)', 'TERMINAL'],
    ['DocumentNotActive(0x01)', 'TERMINAL'],
    ['execution reverted', 'TERMINAL'],
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(classifySourceFailure(new Error(message))).toBe(expected);
  });
});

describe('SourceTransactionWorker broadcast uncertainty', () => {
  it('marks an unknown broadcast for reconciliation and never resends it', async () => {
    let transactionState: 'PREPARED' | 'UNKNOWN' | undefined;
    const query = jest.fn((statement: string) => {
      if (statement.includes('FROM document_intent intent')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              chain_nonce: '7',
              content_digest: contentDigest,
              current_version: null,
              deadline: new Date('2026-07-27T01:00:00.000Z'),
              document_cid: 'bafy-document',
              document_id: documentId,
              id: 'intent-id',
              issuer,
              metadata_commitment: metadataCommitment,
              old_document_id: null,
              operation: 'REGISTER',
              signature: '0x1234',
              status: 'SIGNED',
            },
          ],
        });
      }
      if (statement.includes('FROM source_transaction')) {
        return Promise.resolve({
          rowCount: transactionState ? 1 : 0,
          rows: transactionState
            ? [
                {
                  attempt: 1,
                  id: 'transaction-id',
                  nonce: '7',
                  state: transactionState,
                  transaction_hash: null,
                },
              ]
            : [],
        });
      }
      if (statement.includes('INSERT INTO source_transaction')) {
        transactionState = 'PREPARED';
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              attempt: 1,
              id: 'transaction-id',
              nonce: '7',
              state: transactionState,
              transaction_hash: null,
            },
          ],
        });
      }
      if (
        statement.includes('UPDATE source_transaction') &&
        statement.includes("state = 'UNKNOWN'")
      ) {
        transactionState = 'UNKNOWN';
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const client = { query } as unknown as PoolClient;
    const database = {
      withAdvisoryLock: jest.fn(
        (_lock: number, operation: (locked: PoolClient) => Promise<void>) =>
          operation(client),
      ),
    } as unknown as DatabaseService;
    const getTransactionCount = jest.fn().mockResolvedValue(7);
    const simulateContract = jest
      .fn()
      .mockResolvedValue({ request: { nonce: 7 } });
    const writeContract = jest
      .fn()
      .mockRejectedValue(new Error('RPC disconnected after submission'));
    const blockchain = {
      relayerSubmission: { writeContract },
      sourceReader: { getTransactionCount, simulateContract },
    } as unknown as BlockchainService;
    const worker = new SourceTransactionWorker(
      blockchain,
      new ConfigService({ runtime: runtime() }),
      database,
    );

    await worker.submit('intent-id');
    await worker.submit('intent-id');

    expect(transactionState).toBe('UNKNOWN');
    expect(getTransactionCount).toHaveBeenCalledTimes(1);
    expect(simulateContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.some(([statement]) =>
        statement.includes("failure_code = 'BROADCAST_OUTCOME_UNKNOWN'"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([statement]) =>
          statement.includes("'RECONCILE'") &&
          statement.includes('ON CONFLICT'),
      ),
    ).toBe(true);
  });
});
