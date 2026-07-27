import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress, type Address, type Hex } from 'viem';
import { BlockchainService } from '../blockchain/blockchain.service';
import type { RuntimeConfig } from '../config/runtime-config';
import { etherdocContractArtifacts } from '../contracts/generated';
import { DatabaseService } from '../database/database.service';
import { RetryableJobError, TerminalJobError } from './worker-errors';
import { CorrelationContextService } from '../observability/correlation-context.service';

interface TrackedDispatch {
  content_digest: Hex;
  document_id: Hex;
  document_status: 'ACTIVE' | 'REVOKED' | 'SUPERSEDED';
  document_version: string;
  id: string;
  issuer: Address;
  message_id: Hex;
  sent_at: Date;
  status: string;
}

interface ReceiptRecord {
  document: {
    contentDigest: Hex;
    documentId: Hex;
    issuer: Address;
    status: number;
    version: bigint;
  };
  messageId: Hex;
  sender: Address;
  sourceChainSelector: bigint;
  status: number;
}

const lifecycleStatus = {
  ACTIVE: 1,
  REVOKED: 2,
  SUPERSEDED: 3,
} as const;

@Injectable()
export class DestinationWorker {
  private readonly logger = new Logger(DestinationWorker.name);
  private readonly receiverAbi =
    etherdocContractArtifacts.contracts.receiver.abi;
  private readonly runtime: RuntimeConfig;

  constructor(
    private readonly blockchain: BlockchainService,
    configService: ConfigService,
    private readonly database: DatabaseService,
    @Optional() private readonly correlation?: CorrelationContextService,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  async track(dispatchId: string): Promise<void> {
    const dispatch = await this.readDispatch(dispatchId);
    if (!dispatch || dispatch.status !== 'SOURCE_ACCEPTED') {
      return;
    }
    const finalizedBlock = await this.finalizedBlock();
    const [processedRaw, receiptRaw, verification] = await Promise.all([
      this.blockchain.destinationReader.readContract({
        abi: this.receiverAbi,
        address: this.runtime.blockchain.destination.contractAddress,
        args: [dispatch.message_id],
        functionName: 'getProcessedMessage',
        blockNumber: finalizedBlock,
      }),
      this.blockchain.destinationReader.readContract({
        abi: this.receiverAbi,
        address: this.runtime.blockchain.destination.contractAddress,
        args: [dispatch.document_id],
        functionName: 'getReceipt',
        blockNumber: finalizedBlock,
      }),
      this.blockchain.destinationReader.readContract({
        abi: this.receiverAbi,
        address: this.runtime.blockchain.destination.contractAddress,
        args: [dispatch.document_id, dispatch.content_digest],
        functionName: 'verifyDocument',
        blockNumber: finalizedBlock,
      }),
    ]);
    const processed = processedRaw;
    const receipt = receiptRaw as ReceiptRecord;

    if (!processed.processed) {
      await this.deferOrRecover(dispatch);
      return;
    }
    if (
      processed.documentId !== dispatch.document_id ||
      processed.documentVersion.toString() !== dispatch.document_version
    ) {
      await this.markRecovery(
        dispatch.id,
        'DESTINATION_MESSAGE_MISMATCH',
        'Processed message points to another document or version',
      );
      throw new TerminalJobError('Destination message evidence mismatch');
    }

    const [verifiedDocument, integrityMatches] = verification;
    if (
      !integrityMatches ||
      verifiedDocument.documentId !== dispatch.document_id ||
      verifiedDocument.contentDigest !== dispatch.content_digest ||
      getAddress(verifiedDocument.issuer) !== getAddress(dispatch.issuer)
    ) {
      await this.markRecovery(
        dispatch.id,
        'DESTINATION_INTEGRITY_MISMATCH',
        'verifyDocument did not match canonical source provenance',
      );
      throw new TerminalJobError('Destination integrity verification failed');
    }

    const [receivedEvents, ignoredEvents] = await Promise.all([
      this.blockchain.destinationReader.getContractEvents({
        abi: this.receiverAbi,
        address: this.runtime.blockchain.destination.contractAddress,
        args: { messageId: dispatch.message_id },
        eventName: 'MessageReceived',
        fromBlock: this.runtime.blockchain.destination.deploymentBlock,
        toBlock: finalizedBlock,
      }),
      this.blockchain.destinationReader.getContractEvents({
        abi: this.receiverAbi,
        address: this.runtime.blockchain.destination.contractAddress,
        args: { messageId: dispatch.message_id },
        eventName: 'MessageIgnored',
        fromBlock: this.runtime.blockchain.destination.deploymentBlock,
        toBlock: finalizedBlock,
      }),
    ]);
    const received = receivedEvents.at(-1);
    const ignored = ignoredEvents.at(-1);
    if (received) {
      const {
        documentId,
        documentStatus,
        documentVersion,
        sender,
        sourceChainSelector,
      } = received.args;
      if (
        documentId === undefined ||
        documentStatus === undefined ||
        documentVersion === undefined ||
        sender === undefined ||
        sourceChainSelector === undefined ||
        documentId !== dispatch.document_id ||
        documentVersion.toString() !== dispatch.document_version ||
        documentStatus !== lifecycleStatus[dispatch.document_status] ||
        sourceChainSelector !== this.runtime.blockchain.source.chainSelector ||
        getAddress(sender) !== this.runtime.blockchain.source.contractAddress
      ) {
        await this.markRecovery(
          dispatch.id,
          'DESTINATION_EVENT_MISMATCH',
          'MessageReceived fields do not match the source dispatch',
        );
        throw new TerminalJobError('Destination event evidence mismatch');
      }
      if (
        receipt.status !== 1 ||
        receipt.document.documentId !== dispatch.document_id ||
        receipt.document.version < BigInt(dispatch.document_version) ||
        receipt.sourceChainSelector !==
          this.runtime.blockchain.source.chainSelector ||
        getAddress(receipt.sender) !==
          this.runtime.blockchain.source.contractAddress
      ) {
        await this.markRecovery(
          dispatch.id,
          'DESTINATION_RECEIPT_MISMATCH',
          'Receiver receipt does not match canonical source evidence',
        );
        throw new TerminalJobError('Destination receipt mismatch');
      }
      await this.recordEvent(
        dispatch,
        'DESTINATION_CONFIRMED',
        'MessageReceived',
        received,
      );
      return;
    }
    if (ignored) {
      const { documentId, incomingVersion } = ignored.args;
      if (
        documentId === undefined ||
        incomingVersion === undefined ||
        documentId !== dispatch.document_id ||
        incomingVersion.toString() !== dispatch.document_version
      ) {
        await this.markRecovery(
          dispatch.id,
          'DESTINATION_IGNORED_EVENT_MISMATCH',
          'MessageIgnored fields do not match the source dispatch',
        );
        throw new TerminalJobError('Destination ignored event mismatch');
      }
      await this.recordEvent(
        dispatch,
        'DESTINATION_IGNORED',
        'MessageIgnored',
        ignored,
      );
      return;
    }

    await this.markRecovery(
      dispatch.id,
      'DESTINATION_EVENT_MISSING',
      'Message is processed but no finalized receiver event was found',
    );
    throw new TerminalJobError('Destination event evidence is missing');
  }

  private async finalizedBlock(): Promise<bigint> {
    const head = await this.blockchain.destinationReader.getBlockNumber();
    const depth = BigInt(this.runtime.blockchain.destination.confirmations);
    if (depth === 0n) {
      return head;
    }
    return head >= depth ? head - depth + 1n : 0n;
  }

  private async readDispatch(
    dispatchId: string,
  ): Promise<TrackedDispatch | null> {
    const result = await this.database.query<TrackedDispatch>(
      `
        SELECT
          id, document_id, document_version, content_digest, document_status,
          issuer, message_id, sent_at, status
        FROM dispatch
        WHERE id = $1
      `,
      [dispatchId],
    );
    return result.rows[0] ?? null;
  }

  private async deferOrRecover(dispatch: TrackedDispatch): Promise<never> {
    const elapsedSeconds = (Date.now() - dispatch.sent_at.getTime()) / 1_000;
    if (elapsedSeconds >= this.runtime.dispatch.recoveryAfterSeconds) {
      await this.markRecovery(
        dispatch.id,
        'DESTINATION_CONFIRMATION_TIMEOUT',
        'CCIP message exceeded the configured destination confirmation window',
      );
      throw new TerminalJobError('Destination confirmation requires recovery');
    }
    throw new RetryableJobError('Destination message is not finalized yet');
  }

  private async recordEvent(
    dispatch: TrackedDispatch,
    status: 'DESTINATION_CONFIRMED' | 'DESTINATION_IGNORED',
    eventName: 'MessageIgnored' | 'MessageReceived',
    event: {
      args: unknown;
      blockHash: Hex | null;
      blockNumber: bigint | null;
      logIndex: number | null;
      transactionHash: Hex | null;
    },
  ): Promise<void> {
    if (
      event.blockNumber === null ||
      event.blockHash === null ||
      event.transactionHash === null ||
      event.logIndex === null
    ) {
      throw new RetryableJobError('Destination event lacks finalized evidence');
    }
    const blockNumber = event.blockNumber;
    const blockHash = event.blockHash;
    const transactionHash = event.transactionHash;
    const logIndex = event.logIndex;
    const payload = JSON.parse(
      JSON.stringify(event.args, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ) as Record<string, unknown>;
    await this.database.transaction(async (client) => {
      await client.query(
        `
          INSERT INTO processed_chain_event(
            chain_id, contract_address, transaction_hash, log_index,
            block_number, block_hash, event_name, event_payload
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (chain_id, transaction_hash, log_index)
          DO UPDATE SET canonical = true, processed_at = now()
        `,
        [
          this.runtime.blockchain.destination.chainId,
          this.runtime.blockchain.destination.contractAddress,
          transactionHash,
          logIndex,
          blockNumber.toString(),
          blockHash,
          eventName,
          payload,
        ],
      );
      await client.query(
        `
          UPDATE dispatch
          SET
            status = $2,
            destination_transaction_hash = $3,
            destination_block_number = $4,
            destination_block_hash = $5,
            destination_confirmed_at = now(),
            failure_code = NULL,
            failure_detail = NULL,
            updated_at = now()
          WHERE id = $1 AND status = 'SOURCE_ACCEPTED'
        `,
        [
          dispatch.id,
          status,
          transactionHash,
          blockNumber.toString(),
          blockHash,
        ],
      );
    });
  }

  private async markRecovery(
    dispatchId: string,
    code: string,
    detail: string,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
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
      await client.query(
        `
          INSERT INTO outbox_job(
            deduplication_key, job_type, dispatch_id, payload
          )
          VALUES($1, 'RECONCILE', $2, $3)
          ON CONFLICT (deduplication_key) DO NOTHING
        `,
        [
          `dispatch:${dispatchId}:reconcile-destination`,
          dispatchId,
          { dispatchId },
        ],
      );
    });
    this.logger.error({
      correlationId: this.correlation?.currentId() ?? null,
      dispatchId,
      event: 'destination_recovery_required',
      failureCode: code,
    });
  }
}
