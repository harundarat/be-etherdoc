import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import type { BlockchainService } from '../blockchain/blockchain.service';
import type { RuntimeConfig } from '../config/runtime-config';
import type { DatabaseService } from '../database/database.service';
import {
  bufferedMaximumFee,
  classifyDispatchFailure,
  DispatchWorker,
} from './dispatch.worker';

const signer = '0x0000000000000000000000000000000000000001';
const sender = '0x0000000000000000000000000000000000000002';
const receiver = '0x0000000000000000000000000000000000000003';
const documentId = `0x${'11'.repeat(32)}` as const;

function runtime(): RuntimeConfig {
  return {
    blockchain: {
      destination: {
        chainSelector: 5_002_929_347_135_767n,
        contractAddress: receiver,
      },
      requestTimeoutMs: 15_000,
      signerAddress: signer,
      source: {
        confirmations: 2,
        contractAddress: sender,
      },
    },
    dispatch: {
      feeBufferBps: 1_000,
      maximumFeeWei: 1_000_000n,
    },
  } as unknown as RuntimeConfig;
}

describe('bufferedMaximumFee', () => {
  it('adds a ceiling-rounded bounded quote buffer', () => {
    expect(bufferedMaximumFee(100n, 1_000, 1_000n)).toBe(110n);
    expect(bufferedMaximumFee(101n, 1_000, 1_000n)).toBe(112n);
    expect(bufferedMaximumFee(950n, 1_000, 1_000n)).toBe(1_000n);
  });

  it('rejects a quote above policy instead of underpaying', () => {
    expect(() => bufferedMaximumFee(1_001n, 1_000, 1_000n)).toThrow(
      'exceeds policy maximum',
    );
  });
});

describe('classifyDispatchFailure', () => {
  it.each([
    ['RPC connection refused', 'RETRYABLE'],
    ['DispatchIsPaused()', 'RETRYABLE'],
    ['NotEnoughBalance(0, 10)', 'RETRYABLE'],
    ['FeeExceedsMaximum(11, 10)', 'RETRYABLE'],
    ['UnauthorizedRole(0x01)', 'RECOVERY_REQUIRED'],
    ['DocumentAlreadyDispatched(0x01)', 'RECOVERY_REQUIRED'],
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(classifyDispatchFailure(new Error(message))).toBe(expected);
  });
});

describe('DispatchWorker nonce uncertainty', () => {
  it('reconciles a reserved nonce without a hash instead of broadcasting', async () => {
    let recoveryCode: unknown;
    const query = jest.fn((statement: string, values?: readonly unknown[]) => {
      if (statement.includes('FROM dispatch')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              document_id: documentId,
              document_version: '1',
              failure_code: null,
              id: 'dispatch-id',
              message_id: null,
              receiver,
              source_nonce: '7',
              source_transaction_hash: null,
              status: 'PENDING',
            },
          ],
        });
      }
      if (statement.includes("status = 'RECOVERY_REQUIRED'")) {
        recoveryCode = values?.[1];
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
    const readContract = jest.fn();
    const simulateContract = jest.fn();
    const writeContract = jest.fn();
    const blockchain = {
      operatorDispatch: { writeContract },
      sourceReader: {
        getTransactionCount: jest.fn(),
        readContract,
        simulateContract,
      },
    } as unknown as BlockchainService;
    const worker = new DispatchWorker(
      blockchain,
      new ConfigService({ runtime: runtime() }),
      database,
    );

    await worker.dispatch('dispatch-id');

    expect(readContract).not.toHaveBeenCalled();
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
    expect(recoveryCode).toBe('DISPATCH_RESERVED_NONCE_WITHOUT_HASH');
    expect(
      query.mock.calls.some(
        ([statement]) =>
          statement.includes("'RECONCILE'") &&
          statement.includes('ON CONFLICT'),
      ),
    ).toBe(true);
  });
});
