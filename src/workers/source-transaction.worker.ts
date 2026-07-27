import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  decodeEventLog,
  getAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../config/runtime-config';
import { etherdocContractArtifacts } from '../contracts/generated';
import { BlockchainService } from '../blockchain/blockchain.service';
import {
  BlockchainErrorKind,
  classifyBlockchainError,
} from '../blockchain/blockchain.errors';
import { DatabaseService } from '../database/database.service';
import { requireQueryRow } from '../database/query-result';
import { requireDocumentLifecycleStatus } from '../documents/document-status';
import { RetryableJobError, TerminalJobError } from './worker-errors';

const SIGNER_ADVISORY_LOCK = 836_483_622;

interface SubmissionIntent {
  chain_nonce: string;
  content_digest: Hex | null;
  current_version: string | null;
  deadline: Date;
  document_cid: string | null;
  document_id: Hex;
  id: string;
  issuer: Address;
  metadata_commitment: Hex | null;
  old_document_id: Hex | null;
  operation: 'REGISTER' | 'REVOKE' | 'SUPERSEDE';
  signature: Hex;
  status: string;
}

interface SourceTransactionRow {
  attempt: number;
  id: string;
  nonce: string | null;
  state: 'BROADCAST' | 'CONFIRMED' | 'FAILED' | 'PREPARED' | 'UNKNOWN';
  transaction_hash: Hex | null;
}

interface ChainDocumentRecord {
  cidCodec: number;
  cidDigest: Hex;
  contentDigest: Hex;
  documentCID: string;
  documentId: Hex;
  issuer: Address;
  metadataCommitment: Hex;
  registeredAt: bigint;
  schemaVersion: number;
  sourceChainId: bigint;
  status: number;
  supersededBy: Hex;
  supersedes: Hex;
  updatedAt: bigint;
  version: bigint;
}

interface PreparedSubmission {
  intent: SubmissionIntent;
  nonce: number;
  sourceTransaction: SourceTransactionRow;
}

export type SourceFailureDisposition = 'RETRYABLE' | 'TERMINAL';

export function classifySourceFailure(
  error: unknown,
): SourceFailureDisposition {
  const classified = classifyBlockchainError(error);
  const message =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (
    classified.kind === BlockchainErrorKind.RPC_UNAVAILABLE ||
    classified.kind === BlockchainErrorKind.TIMEOUT ||
    /RegistrationIsPaused|temporarily unavailable/i.test(message)
  ) {
    return 'RETRYABLE';
  }
  if (
    /SignatureExpired|InvalidIssuerSignature|IssuerNotAuthorized|DocumentNotActive|DocumentNotRegistered|DocumentAlreadyRegistered|CallerNotDocumentIssuer/i.test(
      message,
    )
  ) {
    return 'TERMINAL';
  }
  return classified.kind === BlockchainErrorKind.CONTRACT_REVERT
    ? 'TERMINAL'
    : 'RETRYABLE';
}

@Injectable()
export class SourceTransactionWorker {
  private readonly runtime: RuntimeConfig;
  private readonly senderAbi = etherdocContractArtifacts.contracts.sender.abi;

  constructor(
    private readonly blockchain: BlockchainService,
    configService: ConfigService,
    private readonly database: DatabaseService,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  async submit(intentId: string): Promise<void> {
    await this.database.withAdvisoryLock(
      SIGNER_ADVISORY_LOCK,
      async (client) => {
        const prepared = await this.prepareSubmission(client, intentId);
        if (!prepared) {
          return;
        }
        const { intent, sourceTransaction, nonce } = prepared;
        let broadcast: () => Promise<Hex>;
        try {
          broadcast = await this.simulate(intent, nonce);
        } catch (error) {
          const disposition = classifySourceFailure(error);
          await this.markPreBroadcastFailure(
            client,
            intent.id,
            sourceTransaction.id,
            error,
            disposition,
          );
          if (disposition === 'TERMINAL') {
            throw new TerminalJobError(
              'Source simulation failed terminally',
              error,
            );
          }
          throw new RetryableJobError('Source simulation failed', error);
        }

        let transactionHash: Hex;
        try {
          transactionHash = await broadcast();
        } catch (error) {
          await this.markUncertainBroadcast(
            client,
            intent.id,
            sourceTransaction.id,
            nonce,
            error,
          );
          return;
        }
        await this.markBroadcast(
          client,
          intent.id,
          sourceTransaction.id,
          transactionHash,
        );
      },
    );
  }

  async confirm(intentId: string): Promise<void> {
    const result = await this.database.query<
      SubmissionIntent & {
        source_transaction_id: string;
        transaction_hash: Hex;
      }
    >(
      `
        SELECT
          intent.chain_nonce,
          intent.content_digest,
          intent.current_version,
          intent.deadline,
          intent.document_cid,
          intent.document_id,
          intent.id,
          intent.issuer,
          intent.metadata_commitment,
          intent.old_document_id,
          intent.operation,
          intent.status,
          signature.signature,
          tx.id AS source_transaction_id,
          tx.transaction_hash
        FROM document_intent intent
        JOIN document_signature signature ON signature.intent_id = intent.id
        JOIN LATERAL (
          SELECT id, state, transaction_hash
          FROM source_transaction
          WHERE intent_id = intent.id
          ORDER BY attempt DESC
          LIMIT 1
        ) tx ON true
        WHERE intent.id = $1 AND tx.state = 'BROADCAST'
      `,
      [intentId],
    );
    const intent = result.rows[0];
    if (!intent) {
      return;
    }

    let receipt: TransactionReceipt;
    try {
      receipt = await this.blockchain.sourceReader.waitForTransactionReceipt({
        confirmations: this.runtime.blockchain.source.confirmations,
        hash: intent.transaction_hash,
        timeout: this.runtime.blockchain.requestTimeoutMs,
      });
    } catch (error) {
      throw new RetryableJobError('Source receipt is not confirmed yet', error);
    }
    if (receipt.status !== 'success') {
      await this.markReceiptFailure(intent, receipt);
      throw new TerminalJobError('Source transaction reverted');
    }
    this.assertCanonicalEvents(intent, receipt);
    const documentIds =
      intent.operation === 'SUPERSEDE'
        ? [intent.old_document_id!, intent.document_id]
        : [intent.document_id];
    const documents = await Promise.all(
      documentIds.map((documentId) => this.readDocument(documentId)),
    );

    await this.database.transaction(async (client) => {
      for (const document of documents) {
        await this.upsertProjection(client, document, receipt);
        await this.enqueueDispatch(client, document);
      }
      await client.query(
        `
          UPDATE source_transaction
          SET
            state = 'CONFIRMED',
            block_number = $2,
            block_hash = $3,
            receipt_status = 1,
            confirmation_count = $4,
            canonical_event = $5,
            updated_at = now()
          WHERE id = $1 AND state = 'BROADCAST'
        `,
        [
          intent.source_transaction_id,
          receipt.blockNumber.toString(),
          receipt.blockHash,
          this.runtime.blockchain.source.confirmations,
          { documentIds },
        ],
      );
      await client.query(
        `
          UPDATE document_intent
          SET
            status = 'SOURCE_CONFIRMED',
            source_confirmed_at = now(),
            updated_at = now(),
            failure_code = NULL,
            failure_detail = NULL
          WHERE id = $1
        `,
        [intent.id],
      );
    });
  }

  private async prepareSubmission(
    client: PoolClient,
    intentId: string,
  ): Promise<PreparedSubmission | null> {
    await client.query('BEGIN');
    try {
      const intentResult = await client.query<SubmissionIntent>(
        `
          SELECT
            intent.chain_nonce,
            intent.content_digest,
            intent.current_version,
            intent.deadline,
            intent.document_cid,
            intent.document_id,
            intent.id,
            intent.issuer,
            intent.metadata_commitment,
            intent.old_document_id,
            intent.operation,
            intent.status,
            signature.signature
          FROM document_intent intent
          JOIN document_signature signature ON signature.intent_id = intent.id
          WHERE intent.id = $1
          FOR UPDATE OF intent
        `,
        [intentId],
      );
      const intent = intentResult.rows[0];
      if (!intent || !['SIGNED', 'FAILED_RETRYABLE'].includes(intent.status)) {
        await client.query('COMMIT');
        return null;
      }
      const transactionResult = await client.query<SourceTransactionRow>(
        `
          SELECT attempt, id, nonce, state, transaction_hash
          FROM source_transaction
          WHERE intent_id = $1
          ORDER BY attempt DESC
          LIMIT 1
          FOR UPDATE
        `,
        [intentId],
      );
      const latest = transactionResult.rows[0];
      if (
        latest &&
        ['BROADCAST', 'CONFIRMED', 'UNKNOWN', 'PREPARED'].includes(latest.state)
      ) {
        if (latest.state === 'PREPARED') {
          await client.query(
            `
              UPDATE source_transaction
              SET state = 'UNKNOWN', updated_at = now()
              WHERE id = $1
            `,
            [latest.id],
          );
          await this.enqueueReconciliation(client, intentId, latest.id);
        }
        await client.query('COMMIT');
        return null;
      }
      const nonce = await this.blockchain.sourceReader.getTransactionCount({
        address: this.runtime.blockchain.signerAddress,
        blockTag: 'pending',
      });
      const attempt = (latest?.attempt ?? 0) + 1;
      const inserted = await client.query<SourceTransactionRow>(
        `
          INSERT INTO source_transaction(intent_id, attempt, state, nonce)
          VALUES ($1, $2, 'PREPARED', $3)
          RETURNING attempt, id, nonce, state, transaction_hash
        `,
        [intentId, attempt, nonce],
      );
      await client.query('COMMIT');
      return {
        intent,
        nonce,
        sourceTransaction: requireQueryRow(
          inserted.rows,
          'source transaction insert',
        ),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  private simulate(intent: SubmissionIntent, nonce: number) {
    const base = {
      account: this.runtime.blockchain.signerAddress,
      address: this.runtime.blockchain.source.contractAddress,
      abi: this.senderAbi,
      nonce,
    } as const;
    const deadline = BigInt(Math.floor(intent.deadline.getTime() / 1_000));
    if (intent.operation === 'REGISTER') {
      return this.blockchain.sourceReader
        .simulateContract({
          ...base,
          functionName: 'registerDocumentBySig',
          args: [
            intent.content_digest!,
            intent.document_cid!,
            intent.metadata_commitment!,
            intent.issuer,
            deadline,
            intent.signature,
          ],
        })
        .then(
          ({ request }) =>
            () =>
              this.blockchain.relayerSubmission.writeContract(request),
        );
    }
    if (intent.operation === 'REVOKE') {
      return this.blockchain.sourceReader
        .simulateContract({
          ...base,
          functionName: 'revokeDocumentBySig',
          args: [intent.document_id, intent.issuer, deadline, intent.signature],
        })
        .then(
          ({ request }) =>
            () =>
              this.blockchain.relayerSubmission.writeContract(request),
        );
    }
    return this.blockchain.sourceReader
      .simulateContract({
        ...base,
        functionName: 'supersedeDocumentBySig',
        args: [
          intent.old_document_id!,
          intent.content_digest!,
          intent.document_cid!,
          intent.metadata_commitment!,
          intent.issuer,
          deadline,
          intent.signature,
        ],
      })
      .then(
        ({ request }) =>
          () =>
            this.blockchain.relayerSubmission.writeContract(request),
      );
  }

  private async markBroadcast(
    client: PoolClient,
    intentId: string,
    transactionId: string,
    transactionHash: Hex,
  ): Promise<void> {
    await client.query('BEGIN');
    try {
      await client.query(
        `
          UPDATE source_transaction
          SET
            state = 'BROADCAST',
            transaction_hash = $2,
            submitted_at = now(),
            updated_at = now()
          WHERE id = $1 AND state = 'PREPARED'
        `,
        [transactionId, transactionHash],
      );
      await client.query(
        `
          UPDATE document_intent
          SET status = 'SOURCE_PENDING', updated_at = now()
          WHERE id = $1
        `,
        [intentId],
      );
      await client.query(
        `
          INSERT INTO outbox_job(
            deduplication_key, job_type, intent_id, payload
          )
          VALUES ($1, 'CONFIRM_SOURCE', $2, $3)
          ON CONFLICT (deduplication_key) DO NOTHING
        `,
        [`intent:${intentId}:confirm-source`, intentId, { intentId }],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  private async markPreBroadcastFailure(
    client: PoolClient,
    intentId: string,
    transactionId: string,
    error: unknown,
    disposition: SourceFailureDisposition,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    await client.query('BEGIN');
    try {
      await client.query(
        `
          UPDATE source_transaction
          SET state = 'FAILED', failure_code = $2, failure_detail = $3, updated_at = now()
          WHERE id = $1
        `,
        [transactionId, disposition, detail],
      );
      await client.query(
        `
          UPDATE document_intent
          SET status = $2, failure_code = $3, failure_detail = $4, updated_at = now()
          WHERE id = $1
        `,
        [
          intentId,
          disposition === 'TERMINAL' ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE',
          `SOURCE_SIMULATION_${disposition}`,
          detail,
        ],
      );
      await client.query('COMMIT');
    } catch (transactionError) {
      await client.query('ROLLBACK');
      throw transactionError;
    }
  }

  private async markUncertainBroadcast(
    client: PoolClient,
    intentId: string,
    transactionId: string,
    nonce: number,
    error: unknown,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    await client.query('BEGIN');
    try {
      await client.query(
        `
          UPDATE source_transaction
          SET
            state = 'UNKNOWN',
            failure_code = 'BROADCAST_OUTCOME_UNKNOWN',
            failure_detail = $2,
            updated_at = now()
          WHERE id = $1
        `,
        [transactionId, detail],
      );
      await client.query(
        `
          UPDATE document_intent
          SET
            status = 'FAILED_RETRYABLE',
            failure_code = 'BROADCAST_OUTCOME_UNKNOWN',
            failure_detail = $2,
            updated_at = now()
          WHERE id = $1
        `,
        [intentId, `Reserved signer nonce ${nonce}: ${detail}`],
      );
      await this.enqueueReconciliation(client, intentId, transactionId);
      await client.query('COMMIT');
    } catch (transactionError) {
      await client.query('ROLLBACK');
      throw transactionError;
    }
  }

  private enqueueReconciliation(
    client: PoolClient,
    intentId: string,
    transactionId: string,
  ) {
    return client.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, intent_id, payload
        )
        VALUES ($1, 'RECONCILE', $2, $3)
        ON CONFLICT (deduplication_key) DO NOTHING
      `,
      [
        `intent:${intentId}:reconcile-source:${transactionId}`,
        intentId,
        { intentId, transactionId },
      ],
    );
  }

  private assertCanonicalEvents(
    intent: SubmissionIntent,
    receipt: TransactionReceipt,
  ): void {
    const events = receipt.logs
      .filter(
        (log) =>
          getAddress(log.address) ===
          this.runtime.blockchain.source.contractAddress,
      )
      .flatMap((log) => {
        try {
          return [
            decodeEventLog({
              abi: this.senderAbi,
              data: log.data,
              topics: log.topics,
            }),
          ];
        } catch {
          return [];
        }
      });
    const registered = events.some(
      (event) =>
        event.eventName === 'DocumentRegistered' &&
        'documentId' in event.args &&
        event.args.documentId === intent.document_id,
    );
    const statusChanged = events.some(
      (event) =>
        event.eventName === 'DocumentStatusChanged' &&
        'documentId' in event.args &&
        event.args.documentId ===
          (intent.operation === 'SUPERSEDE'
            ? intent.old_document_id
            : intent.document_id),
    );
    if (
      (intent.operation === 'REGISTER' && !registered) ||
      (intent.operation === 'REVOKE' && !statusChanged) ||
      (intent.operation === 'SUPERSEDE' && (!registered || !statusChanged))
    ) {
      throw new TerminalJobError(
        'Source receipt is missing the canonical lifecycle event',
      );
    }
  }

  private async readDocument(documentId: Hex): Promise<ChainDocumentRecord> {
    const document = await this.blockchain.sourceReader.readContract({
      abi: this.senderAbi,
      address: this.runtime.blockchain.source.contractAddress,
      functionName: 'getDocument',
      args: [documentId],
    });
    return document;
  }

  private async upsertProjection(
    client: PoolClient,
    document: ChainDocumentRecord,
    receipt: TransactionReceipt,
  ): Promise<void> {
    const lifecycle = ['UNKNOWN', 'ACTIVE', 'REVOKED', 'SUPERSEDED'][
      document.status
    ];
    if (!lifecycle || lifecycle === 'UNKNOWN') {
      throw new TerminalJobError('Source returned an invalid lifecycle status');
    }
    await client.query(
      `
        INSERT INTO document_projection(
          document_id, content_digest, metadata_commitment, document_cid,
          cid_codec, cid_digest, issuer, source_chain_id, registered_at,
          updated_at, document_version, schema_version, lifecycle_status,
          supersedes, superseded_by, source_tx_hash, source_block_number,
          source_block_hash, projected_at
        )
        VALUES(
          $1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9),to_timestamp($10),$11,$12,
          $13,NULLIF($14,$19),NULLIF($15,$19),$16,$17,$18,now()
        )
        ON CONFLICT (document_id) DO UPDATE SET
          metadata_commitment = EXCLUDED.metadata_commitment,
          document_cid = EXCLUDED.document_cid,
          cid_codec = EXCLUDED.cid_codec,
          cid_digest = EXCLUDED.cid_digest,
          updated_at = EXCLUDED.updated_at,
          document_version = EXCLUDED.document_version,
          schema_version = EXCLUDED.schema_version,
          lifecycle_status = EXCLUDED.lifecycle_status,
          supersedes = EXCLUDED.supersedes,
          superseded_by = EXCLUDED.superseded_by,
          source_tx_hash = EXCLUDED.source_tx_hash,
          source_block_number = EXCLUDED.source_block_number,
          source_block_hash = EXCLUDED.source_block_hash,
          projected_at = now()
        WHERE document_projection.document_version <= EXCLUDED.document_version
      `,
      [
        document.documentId,
        document.contentDigest,
        document.metadataCommitment,
        document.documentCID,
        document.cidCodec,
        document.cidDigest,
        document.issuer,
        document.sourceChainId.toString(),
        document.registeredAt.toString(),
        document.updatedAt.toString(),
        document.version.toString(),
        document.schemaVersion,
        lifecycle,
        document.supersedes,
        document.supersededBy,
        receipt.transactionHash,
        receipt.blockNumber.toString(),
        receipt.blockHash,
        `0x${'0'.repeat(64)}`,
      ],
    );
  }

  private async enqueueDispatch(
    client: PoolClient,
    document: ChainDocumentRecord,
  ): Promise<void> {
    const destination = this.runtime.blockchain.destination;
    const result = await client.query<{ id: string }>(
      `
        INSERT INTO dispatch(
          document_id, document_version, destination_selector, receiver,
          status, gas_limit, content_digest, document_status, issuer
        )
        VALUES($1,$2,$3,$4,'PENDING',$5,$6,$7,$8)
        ON CONFLICT (document_id, document_version, destination_selector)
        DO UPDATE SET updated_at = dispatch.updated_at
        RETURNING id
      `,
      [
        document.documentId,
        document.version.toString(),
        destination.chainSelector.toString(),
        destination.contractAddress,
        etherdocContractArtifacts.networks.mantleSepolia.gasLimit,
        document.contentDigest,
        requireDocumentLifecycleStatus(document.status),
        document.issuer,
      ],
    );
    const dispatchId = requireQueryRow(result.rows, 'dispatch upsert').id;
    await client.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, dispatch_id, payload
        )
        VALUES($1, 'DISPATCH_DESTINATION', $2, $3)
        ON CONFLICT (deduplication_key) DO NOTHING
      `,
      [
        `dispatch:${document.documentId}:${document.version}:${destination.chainSelector}`,
        dispatchId,
        { dispatchId },
      ],
    );
  }

  private async markReceiptFailure(
    intent: SubmissionIntent & { source_transaction_id: string },
    receipt: TransactionReceipt,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `
          UPDATE source_transaction
          SET
            state = 'FAILED',
            receipt_status = 0,
            block_number = $2,
            block_hash = $3,
            failure_code = 'RECEIPT_REVERTED',
            updated_at = now()
          WHERE id = $1
        `,
        [
          intent.source_transaction_id,
          receipt.blockNumber.toString(),
          receipt.blockHash,
        ],
      );
      await client.query(
        `
          UPDATE document_intent
          SET
            status = 'FAILED_TERMINAL',
            failure_code = 'SOURCE_TRANSACTION_REVERTED',
            updated_at = now()
          WHERE id = $1
        `,
        [intent.id],
      );
    });
  }
}
