import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  decodeEventLog,
  getAddress,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import type { PoolClient } from 'pg';
import { BlockchainService } from '../blockchain/blockchain.service';
import type { RuntimeConfig } from '../config/runtime-config';
import { etherdocContractArtifacts } from '../contracts/generated';
import { DatabaseService } from '../database/database.service';
import { RetryableJobError, TerminalJobError } from './worker-errors';
import {
  BlockchainErrorKind,
  classifyBlockchainError,
} from '../blockchain/blockchain.errors';

const SIGNER_ADVISORY_LOCK = 836_483_622;

interface DispatchRow {
  document_id: Hex;
  document_version: string;
  failure_code: string | null;
  id: string;
  message_id: Hex | null;
  receiver: string;
  source_nonce: string | null;
  source_transaction_hash: Hex | null;
  status:
    | 'PENDING'
    | 'SOURCE_ACCEPTED'
    | 'DESTINATION_CONFIRMED'
    | 'DESTINATION_IGNORED'
    | 'RECOVERY_REQUIRED';
}

export type DispatchFailureDisposition = 'RECOVERY_REQUIRED' | 'RETRYABLE';

export function classifyDispatchFailure(
  error: unknown,
): DispatchFailureDisposition {
  const classified = classifyBlockchainError(error);
  const message =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (
    classified.kind === BlockchainErrorKind.RPC_UNAVAILABLE ||
    classified.kind === BlockchainErrorKind.TIMEOUT ||
    /DispatchIsPaused|NotEnoughBalance|FeeExceedsMaximum|temporarily unavailable/i.test(
      message,
    )
  ) {
    return 'RETRYABLE';
  }
  if (
    /UnauthorizedRole|DestinationChainNotAllowlisted|DocumentNotRegistered|DocumentAlreadyDispatched/i.test(
      message,
    )
  ) {
    return 'RECOVERY_REQUIRED';
  }
  return classified.kind === BlockchainErrorKind.CONTRACT_REVERT
    ? 'RECOVERY_REQUIRED'
    : 'RETRYABLE';
}

export function bufferedMaximumFee(
  quote: bigint,
  bufferBps: number,
  policyMaximum: bigint,
): bigint {
  if (quote > policyMaximum) {
    throw new TerminalJobError('Quoted CCIP fee exceeds policy maximum');
  }
  const buffered = quote + (quote * BigInt(bufferBps) + 9_999n) / 10_000n;
  return buffered > policyMaximum ? policyMaximum : buffered;
}

@Injectable()
export class DispatchWorker {
  private readonly runtime: RuntimeConfig;
  private readonly senderAbi = etherdocContractArtifacts.contracts.sender.abi;

  constructor(
    private readonly blockchain: BlockchainService,
    configService: ConfigService,
    private readonly database: DatabaseService,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  async dispatch(dispatchId: string): Promise<void> {
    await this.database.withAdvisoryLock(
      SIGNER_ADVISORY_LOCK,
      async (client) => {
        const dispatch = await this.lockAndReserveNonce(client, dispatchId);
        if (!dispatch || dispatch.status !== 'PENDING') {
          return;
        }
        if (!dispatch.source_transaction_hash) {
          let maximumFee: bigint;
          try {
            const quote = await this.quote(dispatch.document_id);
            maximumFee = bufferedMaximumFee(
              quote,
              this.runtime.dispatch.feeBufferBps,
              this.runtime.dispatch.maximumFeeWei,
            );
          } catch (error) {
            if (error instanceof TerminalJobError) {
              await this.markRecoveryRequired(
                client,
                dispatch.id,
                'DISPATCH_QUOTE_RECOVERY_REQUIRED',
                error,
              );
              throw error;
            }
            await this.clearReservedNonce(client, dispatch.id);
            throw error;
          }
          let broadcast: () => Promise<Hex>;
          try {
            const simulation =
              await this.blockchain.sourceReader.simulateContract({
                abi: this.senderAbi,
                account: this.runtime.blockchain.signerAddress,
                address: this.runtime.blockchain.source.contractAddress,
                args: [
                  dispatch.document_id,
                  this.runtime.blockchain.destination.chainSelector,
                  maximumFee,
                ],
                functionName: 'dispatchDocument',
                nonce: Number(dispatch.source_nonce),
              });
            broadcast = () =>
              this.blockchain.operatorDispatch.writeContract(
                simulation.request,
              );
          } catch (error) {
            const disposition = classifyDispatchFailure(error);
            if (disposition === 'RECOVERY_REQUIRED') {
              await this.markRecoveryRequired(
                client,
                dispatch.id,
                'DISPATCH_SIMULATION_RECOVERY_REQUIRED',
                error,
              );
              throw new TerminalJobError(
                'CCIP dispatch requires reconciliation',
                error,
              );
            }
            await this.clearReservedNonce(client, dispatch.id);
            throw new RetryableJobError(
              'CCIP dispatch simulation failed',
              error,
            );
          }
          try {
            const transactionHash = await broadcast();
            await this.saveTransactionHash(
              client,
              dispatch.id,
              transactionHash,
            );
            dispatch.source_transaction_hash = transactionHash;
          } catch (error) {
            await this.markRecoveryRequired(
              client,
              dispatch.id,
              'DISPATCH_BROADCAST_OUTCOME_UNKNOWN',
              error,
            );
            return;
          }
        }
        await this.confirmSourceAcceptance(dispatch);
      },
    );
  }

  private async quote(documentId: Hex): Promise<bigint> {
    try {
      return await this.blockchain.sourceReader.readContract({
        abi: this.senderAbi,
        address: this.runtime.blockchain.source.contractAddress,
        args: [documentId, this.runtime.blockchain.destination.chainSelector],
        functionName: 'quoteFee',
      });
    } catch (error) {
      if (classifyDispatchFailure(error) === 'RECOVERY_REQUIRED') {
        throw new TerminalJobError('CCIP quote requires reconciliation', error);
      }
      throw new RetryableJobError('Unable to quote CCIP fee', error);
    }
  }

  private async lockAndReserveNonce(
    client: PoolClient,
    dispatchId: string,
  ): Promise<DispatchRow | null> {
    await client.query('BEGIN');
    try {
      const result = await client.query<DispatchRow>(
        `SELECT * FROM dispatch WHERE id = $1 FOR UPDATE`,
        [dispatchId],
      );
      const dispatch = result.rows[0];
      if (!dispatch || dispatch.status !== 'PENDING') {
        await client.query('COMMIT');
        return dispatch ?? null;
      }
      if (!dispatch.source_transaction_hash && !dispatch.source_nonce) {
        const nonce = await this.blockchain.sourceReader.getTransactionCount({
          address: this.runtime.blockchain.signerAddress,
          blockTag: 'pending',
        });
        await client.query(
          `
            UPDATE dispatch
            SET source_nonce = $2, updated_at = now()
            WHERE id = $1
          `,
          [dispatch.id, nonce],
        );
        dispatch.source_nonce = String(nonce);
      } else if (
        !dispatch.source_transaction_hash &&
        dispatch.source_nonce !== null
      ) {
        await this.markRecoveryRequired(
          client,
          dispatch.id,
          'DISPATCH_RESERVED_NONCE_WITHOUT_HASH',
          new Error(`Reserved nonce ${dispatch.source_nonce}`),
          false,
        );
        await client.query('COMMIT');
        return null;
      }
      await client.query('COMMIT');
      return dispatch;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  private async saveTransactionHash(
    client: PoolClient,
    dispatchId: string,
    transactionHash: Hex,
  ): Promise<void> {
    await client.query('BEGIN');
    try {
      await client.query(
        `
          UPDATE dispatch
          SET
            source_transaction_hash = $2,
            failure_code = NULL,
            failure_detail = NULL,
            updated_at = now()
          WHERE id = $1 AND status = 'PENDING'
        `,
        [dispatchId, transactionHash],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  private async clearReservedNonce(
    client: PoolClient,
    dispatchId: string,
  ): Promise<void> {
    await client.query('BEGIN');
    try {
      await client.query(
        `
          UPDATE dispatch
          SET source_nonce = NULL, updated_at = now()
          WHERE id = $1
            AND status = 'PENDING'
            AND source_transaction_hash IS NULL
        `,
        [dispatchId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  private async confirmSourceAcceptance(dispatch: DispatchRow): Promise<void> {
    let receipt: TransactionReceipt;
    try {
      receipt = await this.blockchain.sourceReader.waitForTransactionReceipt({
        confirmations: this.runtime.blockchain.source.confirmations,
        hash: dispatch.source_transaction_hash!,
        timeout: this.runtime.blockchain.requestTimeoutMs,
      });
    } catch (error) {
      throw new RetryableJobError(
        'Dispatch source receipt is not confirmed yet',
        error,
      );
    }
    if (receipt.status !== 'success') {
      await this.database.query(
        `
          UPDATE dispatch
          SET
            status = 'RECOVERY_REQUIRED',
            failure_code = 'DISPATCH_TRANSACTION_REVERTED',
            source_block_number = $2,
            source_block_hash = $3,
            updated_at = now()
          WHERE id = $1
        `,
        [dispatch.id, receipt.blockNumber.toString(), receipt.blockHash],
      );
      throw new TerminalJobError('Dispatch transaction reverted');
    }
    const message = this.parseMessageSent(dispatch, receipt);
    const sourceBlock = await this.blockchain.sourceReader.getBlock({
      blockNumber: receipt.blockNumber,
    });
    await this.database.transaction(async (client) => {
      const result = await client.query(
        `
          UPDATE dispatch
          SET
            status = 'SOURCE_ACCEPTED',
            message_id = $2,
            source_block_number = $3,
            source_block_hash = $4,
            gas_limit = $5,
            fee_token = $6,
            fee_amount = $7,
            sent_at = to_timestamp($8),
            updated_at = now()
          WHERE id = $1 AND status = 'PENDING'
        `,
        [
          dispatch.id,
          message.messageId,
          receipt.blockNumber.toString(),
          receipt.blockHash,
          message.gasLimit,
          message.feeToken,
          message.fees.toString(),
          sourceBlock.timestamp.toString(),
        ],
      );
      if (result.rowCount !== 1) {
        throw new TerminalJobError('Dispatch state changed concurrently');
      }
      await client.query(
        `
          INSERT INTO outbox_job(
            deduplication_key, job_type, dispatch_id, payload
          )
          VALUES($1, 'TRACK_DESTINATION', $2, $3)
          ON CONFLICT (deduplication_key) DO NOTHING
        `,
        [
          `dispatch:${dispatch.id}:track-destination`,
          dispatch.id,
          { dispatchId: dispatch.id },
        ],
      );
    });
  }

  private parseMessageSent(
    dispatch: DispatchRow,
    receipt: TransactionReceipt,
  ): {
    feeToken: string;
    fees: bigint;
    gasLimit: number;
    messageId: Hex;
  } {
    for (const log of receipt.logs) {
      if (
        getAddress(log.address) !==
        this.runtime.blockchain.source.contractAddress
      ) {
        continue;
      }
      try {
        const decoded = decodeEventLog({
          abi: this.senderAbi,
          data: log.data,
          topics: log.topics,
        });
        if (
          decoded.eventName === 'MessageSent' &&
          'documentId' in decoded.args &&
          decoded.args.documentId === dispatch.document_id &&
          decoded.args.documentVersion.toString() ===
            dispatch.document_version &&
          decoded.args.destinationChainSelector ===
            this.runtime.blockchain.destination.chainSelector &&
          getAddress(decoded.args.receiver) ===
            this.runtime.blockchain.destination.contractAddress
        ) {
          return {
            feeToken: decoded.args.feeToken,
            fees: decoded.args.fees,
            gasLimit: decoded.args.gasLimit,
            messageId: decoded.args.messageId,
          };
        }
      } catch {
        continue;
      }
    }
    throw new TerminalJobError('Dispatch receipt is missing MessageSent');
  }

  private async markRecoveryRequired(
    client: PoolClient,
    dispatchId: string,
    code: string,
    error: unknown,
    manageTransaction = true,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    if (manageTransaction) {
      await client.query('BEGIN');
    }
    try {
      await client.query(
        `
          UPDATE dispatch
          SET
            status = 'RECOVERY_REQUIRED',
            failure_code = $2,
            failure_detail = $3,
            recovery_reason = $3,
            updated_at = now()
          WHERE id = $1
        `,
        [dispatchId, code, detail],
      );
      if (manageTransaction) {
        await client.query('COMMIT');
      }
    } catch (transactionError) {
      if (manageTransaction) {
        await client.query('ROLLBACK');
      }
      throw transactionError;
    }
  }
}
