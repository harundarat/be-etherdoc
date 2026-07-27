import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress, type Hex } from 'viem';
import { BlockchainService } from '../blockchain/blockchain.service';
import type { RuntimeConfig } from '../config/runtime-config';
import { etherdocContractArtifacts } from '../contracts/generated';
import { DatabaseService } from '../database/database.service';
import type { OutboxPayload } from '../database/outbox-payload';
import { DestinationWorker } from './destination.worker';
import { DispatchWorker } from './dispatch.worker';
import { RetryableJobError, TerminalJobError } from './worker-errors';

interface RecoverableIntent {
  document_id: Hex;
  id: string;
  old_document_id: Hex | null;
  operation: 'REGISTER' | 'REVOKE' | 'SUPERSEDE';
  transaction_id: string;
  transaction_nonce: string;
}

interface RecoverableDispatch {
  document_id: Hex;
  document_version: string;
  failure_code: string | null;
  id: string;
  message_id: Hex | null;
  receiver: string;
  source_nonce: string | null;
  status: string;
}

export function missingNonceEvidenceDisposition(
  latestNonce: bigint,
  reservedNonce: bigint,
): 'MANUAL_RECOVERY' | 'WAIT' {
  return latestNonce <= reservedNonce ? 'WAIT' : 'MANUAL_RECOVERY';
}

@Injectable()
export class ReconciliationWorker {
  private readonly runtime: RuntimeConfig;
  private readonly senderAbi = etherdocContractArtifacts.contracts.sender.abi;

  constructor(
    private readonly blockchain: BlockchainService,
    configService: ConfigService,
    private readonly database: DatabaseService,
    private readonly destinationWorker: DestinationWorker,
    private readonly dispatchWorker: DispatchWorker,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  async reconcile(payload: OutboxPayload): Promise<void> {
    const intentId = payload.intentId;
    const transactionId = payload.transactionId;
    if (typeof intentId === 'string' && typeof transactionId === 'string') {
      await this.reconcileSourceIntent(intentId, transactionId);
      return;
    }
    const dispatchId = payload.dispatchId;
    if (typeof dispatchId === 'string') {
      await this.reconcileDispatch(dispatchId);
      return;
    }
    throw new TerminalJobError('Reconciliation job has an invalid target');
  }

  private async reconcileSourceIntent(
    intentId: string,
    transactionId: string,
  ): Promise<void> {
    const result = await this.database.query<RecoverableIntent>(
      `
        SELECT
          intent.id, intent.operation, intent.document_id,
          intent.old_document_id, tx.id AS transaction_id,
          tx.nonce AS transaction_nonce
        FROM document_intent intent
        JOIN source_transaction tx ON tx.intent_id = intent.id
        WHERE
          intent.id = $1
          AND tx.id = $2
          AND tx.state = 'UNKNOWN'
      `,
      [intentId, transactionId],
    );
    const intent = result.rows[0];
    if (!intent) {
      return;
    }

    const finalizedBlock = await this.finalizedSourceBlock();
    const [registered, statusChanged] = await Promise.all([
      intent.operation === 'REVOKE'
        ? Promise.resolve([])
        : this.blockchain.sourceReader.getContractEvents({
            abi: this.senderAbi,
            address: this.runtime.blockchain.source.contractAddress,
            args: { documentId: intent.document_id },
            eventName: 'DocumentRegistered',
            fromBlock: this.runtime.blockchain.source.deploymentBlock,
            toBlock: finalizedBlock,
          }),
      intent.operation === 'REGISTER'
        ? Promise.resolve([])
        : this.blockchain.sourceReader.getContractEvents({
            abi: this.senderAbi,
            address: this.runtime.blockchain.source.contractAddress,
            args: {
              documentId:
                intent.operation === 'SUPERSEDE'
                  ? intent.old_document_id!
                  : intent.document_id,
            },
            eventName: 'DocumentStatusChanged',
            fromBlock: this.runtime.blockchain.source.deploymentBlock,
            toBlock: finalizedBlock,
          }),
    ]);

    const transactionHash =
      intent.operation === 'REGISTER'
        ? registered.at(-1)?.transactionHash
        : intent.operation === 'REVOKE'
          ? statusChanged.at(-1)?.transactionHash
          : registered.find((registration) =>
              statusChanged.some(
                (status) =>
                  status.transactionHash === registration.transactionHash,
              ),
            )?.transactionHash;
    if (!transactionHash) {
      await this.handleMissingSourceEvidence(intent);
      return;
    }
    await this.assertSignerTransaction(
      transactionHash,
      intent.transaction_nonce,
    );

    await this.database.transaction(async (client) => {
      await client.query(
        `
          UPDATE source_transaction
          SET
            state = 'BROADCAST',
            transaction_hash = $2,
            submitted_at = COALESCE(submitted_at, now()),
            failure_code = NULL,
            failure_detail = NULL,
            updated_at = now()
          WHERE id = $1 AND state = 'UNKNOWN'
        `,
        [intent.transaction_id, transactionHash],
      );
      await client.query(
        `
          UPDATE document_intent
          SET
            status = 'SOURCE_PENDING',
            failure_code = NULL,
            failure_detail = NULL,
            updated_at = now()
          WHERE id = $1
        `,
        [intent.id],
      );
      await client.query(
        `
          INSERT INTO outbox_job(
            deduplication_key, job_type, intent_id, payload
          )
          VALUES($1, 'CONFIRM_SOURCE', $2, $3)
          ON CONFLICT (deduplication_key) DO UPDATE SET
            state = 'READY',
            available_at = now(),
            locked_at = NULL,
            locked_by = NULL,
            lease_token = NULL,
            last_error = NULL,
            updated_at = now()
          WHERE outbox_job.state IN ('COMPLETED', 'FAILED')
        `,
        [
          `intent:${intent.id}:confirm-source`,
          intent.id,
          { intentId: intent.id },
        ],
      );
    });
  }

  private async reconcileDispatch(dispatchId: string): Promise<void> {
    const result = await this.database.query<RecoverableDispatch>(
      `
        SELECT
          id, document_id, document_version, receiver, status, message_id,
          source_nonce, failure_code
        FROM dispatch
        WHERE id = $1 AND status = 'RECOVERY_REQUIRED'
      `,
      [dispatchId],
    );
    const dispatch = result.rows[0];
    if (!dispatch) {
      return;
    }

    if (dispatch.failure_code?.startsWith('DESTINATION_')) {
      if (!dispatch.message_id) {
        throw new TerminalJobError(
          'Destination recovery is missing the source message identifier',
        );
      }
      await this.database.query(
        `
          UPDATE dispatch
          SET status = 'SOURCE_ACCEPTED', updated_at = now()
          WHERE id = $1 AND status = 'RECOVERY_REQUIRED'
        `,
        [dispatch.id],
      );
      await this.destinationWorker.track(dispatch.id);
      return;
    }
    if (
      dispatch.failure_code === 'DISPATCH_QUOTE_RECOVERY_REQUIRED' ||
      dispatch.failure_code === 'DISPATCH_SIMULATION_RECOVERY_REQUIRED'
    ) {
      throw new TerminalJobError(
        `${dispatch.failure_code} requires operator intervention`,
      );
    }

    const finalizedBlock = await this.finalizedSourceBlock();
    const events = await this.blockchain.sourceReader.getContractEvents({
      abi: this.senderAbi,
      address: this.runtime.blockchain.source.contractAddress,
      args: {
        destinationChainSelector:
          this.runtime.blockchain.destination.chainSelector,
        documentId: dispatch.document_id,
      },
      eventName: 'MessageSent',
      fromBlock: this.runtime.blockchain.source.deploymentBlock,
      toBlock: finalizedBlock,
    });
    const event = events.find(
      (candidate) =>
        candidate.args.documentVersion !== undefined &&
        candidate.args.documentVersion.toString() ===
          dispatch.document_version &&
        candidate.args.receiver !== undefined &&
        getAddress(candidate.args.receiver) ===
          this.runtime.blockchain.destination.contractAddress,
    );
    if (!event?.transactionHash || event.args.messageId === undefined) {
      await this.handleMissingDispatchEvidence(dispatch);
      return;
    }
    if (dispatch.source_nonce !== null) {
      await this.assertSignerTransaction(
        event.transactionHash,
        dispatch.source_nonce,
      );
    }
    const recordRaw = await this.blockchain.sourceReader.readContract({
      abi: this.senderAbi,
      address: this.runtime.blockchain.source.contractAddress,
      args: [
        dispatch.document_id,
        this.runtime.blockchain.destination.chainSelector,
        BigInt(dispatch.document_version),
      ],
      functionName: 'getDispatchAtVersion',
      blockNumber: finalizedBlock,
    });
    const record = recordRaw;
    if (
      record.status !== 1 ||
      record.messageId !== event.args.messageId ||
      record.documentVersion.toString() !== dispatch.document_version ||
      getAddress(record.receiver) !==
        this.runtime.blockchain.destination.contractAddress
    ) {
      throw new TerminalJobError(
        'Recovered dispatch does not match the canonical sender record',
      );
    }

    await this.database.query(
      `
        UPDATE dispatch
        SET
          status = 'PENDING',
          source_transaction_hash = $2,
          message_id = $3,
          failure_code = NULL,
          failure_detail = NULL,
          recovery_reason = NULL,
          updated_at = now()
        WHERE id = $1 AND status = 'RECOVERY_REQUIRED'
      `,
      [dispatch.id, event.transactionHash, event.args.messageId],
    );
    await this.dispatchWorker.dispatch(dispatch.id);
  }

  private async assertSignerTransaction(
    transactionHash: Hex,
    reservedNonce: string,
  ): Promise<void> {
    const transaction = await this.blockchain.sourceReader.getTransaction({
      hash: transactionHash,
    });
    if (
      getAddress(transaction.from) !== this.runtime.blockchain.signerAddress ||
      BigInt(transaction.nonce) !== BigInt(reservedNonce)
    ) {
      throw new TerminalJobError(
        'Recovered event was not emitted by the reserved signer transaction',
      );
    }
  }

  private async handleMissingSourceEvidence(
    intent: RecoverableIntent,
  ): Promise<never> {
    const reservedNonce = BigInt(intent.transaction_nonce);
    const latestNonce = await this.blockchain.sourceReader.getTransactionCount({
      address: this.runtime.blockchain.signerAddress,
      blockTag: 'latest',
    });
    if (
      missingNonceEvidenceDisposition(BigInt(latestNonce), reservedNonce) ===
      'WAIT'
    ) {
      throw new RetryableJobError(
        `No finalized source evidence exists yet for reserved nonce ${reservedNonce}`,
      );
    }
    await this.database.transaction(async (client) => {
      await client.query(
        `
          UPDATE source_transaction
          SET
            state = 'FAILED',
            failure_code = 'NONCE_CONSUMED_WITHOUT_CANONICAL_EVENT',
            failure_detail = $2,
            updated_at = now()
          WHERE id = $1 AND state = 'UNKNOWN'
        `,
        [
          intent.transaction_id,
          `Signer nonce ${reservedNonce} was consumed without a matching lifecycle event`,
        ],
      );
      await client.query(
        `
          UPDATE document_intent
          SET
            status = 'FAILED_TERMINAL',
            failure_code = 'MANUAL_RECOVERY_REQUIRED',
            failure_detail = $2,
            updated_at = now()
          WHERE id = $1
        `,
        [
          intent.id,
          `Reserved signer nonce ${reservedNonce} was consumed without canonical contract evidence`,
        ],
      );
    });
    throw new TerminalJobError(
      'Source nonce was consumed without canonical lifecycle evidence',
    );
  }

  private async handleMissingDispatchEvidence(
    dispatch: RecoverableDispatch,
  ): Promise<never> {
    if (dispatch.source_nonce === null) {
      throw new TerminalJobError(
        'Dispatch recovery has no reserved source nonce',
      );
    }
    const reservedNonce = BigInt(dispatch.source_nonce);
    const latestNonce = await this.blockchain.sourceReader.getTransactionCount({
      address: this.runtime.blockchain.signerAddress,
      blockTag: 'latest',
    });
    if (
      missingNonceEvidenceDisposition(BigInt(latestNonce), reservedNonce) ===
      'WAIT'
    ) {
      throw new RetryableJobError(
        `No finalized MessageSent exists yet for reserved nonce ${reservedNonce}`,
      );
    }
    await this.database.query(
      `
        UPDATE dispatch
        SET
          failure_code = 'MANUAL_RECOVERY_REQUIRED',
          failure_detail = $2,
          recovery_reason = $2,
          updated_at = now()
        WHERE id = $1 AND status = 'RECOVERY_REQUIRED'
      `,
      [
        dispatch.id,
        `Signer nonce ${reservedNonce} was consumed without a matching MessageSent event`,
      ],
    );
    throw new TerminalJobError(
      'Dispatch nonce was consumed without canonical MessageSent evidence',
    );
  }

  private async finalizedSourceBlock(): Promise<bigint> {
    const head = await this.blockchain.sourceReader.getBlockNumber();
    const depth = BigInt(this.runtime.blockchain.source.confirmations);
    if (depth === 0n) {
      return head;
    }
    return head >= depth ? head - depth + 1n : 0n;
  }
}
