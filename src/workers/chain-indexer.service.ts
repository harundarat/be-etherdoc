import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress, type Address, type Hex } from 'viem';
import { BlockchainService } from '../blockchain/blockchain.service';
import type {
  ChainRuntimeConfig,
  RuntimeConfig,
} from '../config/runtime-config';
import { etherdocContractArtifacts } from '../contracts/generated';
import { DatabaseService } from '../database/database.service';

const SOURCE_INDEXER_LOCK = 836_483_623;
const DESTINATION_INDEXER_LOCK = 836_483_624;
const zeroDocumentId = `0x${'0'.repeat(64)}` as const;

interface ChainCursor {
  last_finalized_block: string | null;
  last_finalized_hash: Hex | null;
  next_block: string;
}

interface IndexedLog {
  args: Record<string, unknown>;
  blockHash: Hex;
  blockNumber: bigint;
  eventName:
    | 'DocumentRegistered'
    | 'DocumentStatusChanged'
    | 'MessageIgnored'
    | 'MessageReceived'
    | 'MessageSent';
  logIndex: number;
  transactionHash: Hex;
}

interface SourceDispatchSnapshot {
  feeToken: Address;
  fees: bigint;
  gasLimit: number;
  messageId: Hex;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function normalizedIndexedLog(
  eventName: IndexedLog['eventName'],
  event: {
    args?: unknown;
    blockHash?: Hex | null;
    blockNumber?: bigint | null;
    logIndex?: number | null;
    transactionHash?: Hex | null;
  },
): IndexedLog | null {
  if (
    event.blockHash === null ||
    event.blockHash === undefined ||
    event.blockNumber === null ||
    event.blockNumber === undefined ||
    event.logIndex === null ||
    event.logIndex === undefined ||
    event.transactionHash === null ||
    event.transactionHash === undefined
  ) {
    return null;
  }
  return {
    args: record(event.args),
    blockHash: event.blockHash,
    blockNumber: event.blockNumber,
    eventName,
    logIndex: event.logIndex,
    transactionHash: event.transactionHash,
  };
}

export function cursorRequiresRebuild(
  lastFinalizedBlock: bigint,
  lastFinalizedHash: Hex,
  currentFinalizedBlock: bigint,
  observedHash: Hex,
): boolean {
  return (
    lastFinalizedBlock > currentFinalizedBlock ||
    observedHash !== lastFinalizedHash
  );
}

function hexArgument(log: IndexedLog, name: string): Hex {
  const value = log.args[name];
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${log.eventName} has invalid ${name}`);
  }
  return value as Hex;
}

function bigintArgument(log: IndexedLog, name: string): bigint {
  const value = log.args[name];
  if (typeof value !== 'bigint') {
    throw new Error(`${log.eventName} has invalid ${name}`);
  }
  return value;
}

function numberArgument(log: IndexedLog, name: string): number {
  const value = log.args[name];
  if (typeof value !== 'number') {
    throw new Error(`${log.eventName} has invalid ${name}`);
  }
  return value;
}

function addressArgument(log: IndexedLog, name: string): Address {
  const value = log.args[name];
  if (typeof value !== 'string') {
    throw new Error(`${log.eventName} has invalid ${name}`);
  }
  return getAddress(value);
}

function serializedArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(args, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ) as Record<string, unknown>;
}

@Injectable()
export class ChainIndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChainIndexerService.name);
  private readonly receiverAbi =
    etherdocContractArtifacts.contracts.receiver.abi;
  private readonly runtime: RuntimeConfig;
  private readonly senderAbi = etherdocContractArtifacts.contracts.sender.abi;
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly blockchain: BlockchainService,
    configService: ConfigService,
    private readonly database: DatabaseService,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.tick();
    }, this.runtime.worker.indexIntervalMs);
    this.interval.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.database.withAdvisoryLock(SOURCE_INDEXER_LOCK, () =>
        this.indexSource(),
      );
      await this.database.withAdvisoryLock(DESTINATION_INDEXER_LOCK, () =>
        this.indexDestination(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Chain indexing failed: ${message}`);
    } finally {
      this.running = false;
    }
  }

  private async indexSource(): Promise<void> {
    const chain = this.runtime.blockchain.source;
    const finalizedBlock = await this.finalizedBlock(
      this.blockchain.sourceReader,
      chain,
    );
    let cursor = await this.ensureCursor(chain);
    if (await this.cursorWasReorganized(cursor, finalizedBlock, 'source')) {
      await this.resetSource(chain);
      cursor = await this.ensureCursor(chain);
    }
    await this.scanRanges(cursor, finalizedBlock, chain, (fromBlock, toBlock) =>
      this.indexSourceRange(fromBlock, toBlock),
    );
    await this.enqueuePendingDispatches();
    await this.enqueueSourceAcceptedTracking();
    await this.enqueueRecoveryRequired();
  }

  private async indexDestination(): Promise<void> {
    const chain = this.runtime.blockchain.destination;
    const finalizedBlock = await this.finalizedBlock(
      this.blockchain.destinationReader,
      chain,
    );
    let cursor = await this.ensureCursor(chain);
    if (
      await this.cursorWasReorganized(cursor, finalizedBlock, 'destination')
    ) {
      await this.resetDestination(chain);
      cursor = await this.ensureCursor(chain);
    }
    await this.scanRanges(cursor, finalizedBlock, chain, (fromBlock, toBlock) =>
      this.indexDestinationRange(fromBlock, toBlock),
    );
    await this.enqueueSourceAcceptedTracking();
  }

  private async scanRanges(
    cursor: ChainCursor,
    finalizedBlock: bigint,
    chain: ChainRuntimeConfig,
    scan: (fromBlock: bigint, toBlock: bigint) => Promise<void>,
  ): Promise<void> {
    let fromBlock = BigInt(cursor.next_block);
    const range = BigInt(this.runtime.worker.indexBlockRange);
    while (fromBlock <= finalizedBlock) {
      const toBlock =
        fromBlock + range - 1n < finalizedBlock
          ? fromBlock + range - 1n
          : finalizedBlock;
      await scan(fromBlock, toBlock);
      const block = await this.readerFor(chain).getBlock({
        blockNumber: toBlock,
      });
      await this.database.query(
        `
          UPDATE chain_cursor
          SET
            next_block = $3,
            last_finalized_block = $4,
            last_finalized_hash = $5,
            updated_at = now()
          WHERE chain_id = $1 AND contract_address = $2
        `,
        [
          chain.chainId,
          chain.contractAddress,
          (toBlock + 1n).toString(),
          toBlock.toString(),
          block.hash,
        ],
      );
      fromBlock = toBlock + 1n;
    }
  }

  private async indexSourceRange(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<void> {
    const address = this.runtime.blockchain.source.contractAddress;
    const [registered, statusChanged, sent] = await Promise.all([
      this.blockchain.sourceReader.getContractEvents({
        abi: this.senderAbi,
        address,
        eventName: 'DocumentRegistered',
        fromBlock,
        toBlock,
      }),
      this.blockchain.sourceReader.getContractEvents({
        abi: this.senderAbi,
        address,
        eventName: 'DocumentStatusChanged',
        fromBlock,
        toBlock,
      }),
      this.blockchain.sourceReader.getContractEvents({
        abi: this.senderAbi,
        address,
        eventName: 'MessageSent',
        fromBlock,
        toBlock,
      }),
    ]);
    const logs = [
      ...registered.map((event) =>
        normalizedIndexedLog('DocumentRegistered', event),
      ),
      ...statusChanged.map((event) =>
        normalizedIndexedLog('DocumentStatusChanged', event),
      ),
      ...sent.map((event) => normalizedIndexedLog('MessageSent', event)),
    ]
      .filter((log): log is IndexedLog => log !== null)
      .sort(
        (left, right) =>
          Number(left.blockNumber - right.blockNumber) ||
          left.logIndex - right.logIndex,
      );
    for (const log of logs) {
      await this.persistEvent(this.runtime.blockchain.source, log);
      if (
        log.eventName === 'DocumentRegistered' ||
        log.eventName === 'DocumentStatusChanged'
      ) {
        await this.projectDocument(log);
      } else {
        await this.projectMessageSent(log);
      }
    }
  }

  private async indexDestinationRange(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<void> {
    const address = this.runtime.blockchain.destination.contractAddress;
    const [received, ignored] = await Promise.all([
      this.blockchain.destinationReader.getContractEvents({
        abi: this.receiverAbi,
        address,
        eventName: 'MessageReceived',
        fromBlock,
        toBlock,
      }),
      this.blockchain.destinationReader.getContractEvents({
        abi: this.receiverAbi,
        address,
        eventName: 'MessageIgnored',
        fromBlock,
        toBlock,
      }),
    ]);
    const logs = [
      ...received.map((event) =>
        normalizedIndexedLog('MessageReceived', event),
      ),
      ...ignored.map((event) => normalizedIndexedLog('MessageIgnored', event)),
    ].filter((log): log is IndexedLog => log !== null);
    for (const log of logs) {
      await this.persistEvent(this.runtime.blockchain.destination, log);
    }
  }

  private async projectDocument(log: IndexedLog): Promise<void> {
    const documentId = hexArgument(log, 'documentId');
    const documentRaw = await this.blockchain.sourceReader.readContract({
      abi: this.senderAbi,
      address: this.runtime.blockchain.source.contractAddress,
      args: [documentId],
      blockNumber: log.blockNumber,
      functionName: 'getDocument',
    });
    const document = documentRaw;
    const lifecycle = ['UNKNOWN', 'ACTIVE', 'REVOKED', 'SUPERSEDED'][
      document.status
    ];
    if (!lifecycle || lifecycle === 'UNKNOWN') {
      throw new Error(`Document ${documentId} has an invalid lifecycle state`);
    }
    await this.database.transaction(async (client) => {
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
          log.transactionHash,
          log.blockNumber.toString(),
          log.blockHash,
          zeroDocumentId,
        ],
      );
      await client.query(
        `
          INSERT INTO dispatch(
            document_id, document_version, destination_selector, receiver,
            status, gas_limit, content_digest, document_status, issuer
          )
          VALUES($1,$2,$3,$4,'PENDING',$5,$6,$7,$8)
          ON CONFLICT (document_id, document_version, destination_selector)
          DO UPDATE SET
            content_digest = EXCLUDED.content_digest,
            document_status = EXCLUDED.document_status,
            issuer = EXCLUDED.issuer,
            updated_at = now()
        `,
        [
          document.documentId,
          document.version.toString(),
          this.runtime.blockchain.destination.chainSelector.toString(),
          this.runtime.blockchain.destination.contractAddress,
          etherdocContractArtifacts.networks.mantleSepolia.gasLimit,
          document.contentDigest,
          lifecycle,
          document.issuer,
        ],
      );
    });
  }

  private async projectMessageSent(log: IndexedLog): Promise<void> {
    const documentId = hexArgument(log, 'documentId');
    const documentVersion = bigintArgument(log, 'documentVersion');
    const destinationSelector = bigintArgument(log, 'destinationChainSelector');
    const receiver = addressArgument(log, 'receiver');
    if (
      destinationSelector !==
        this.runtime.blockchain.destination.chainSelector ||
      receiver !== this.runtime.blockchain.destination.contractAddress
    ) {
      return;
    }
    const snapshot: SourceDispatchSnapshot = {
      feeToken: addressArgument(log, 'feeToken'),
      fees: bigintArgument(log, 'fees'),
      gasLimit: numberArgument(log, 'gasLimit'),
      messageId: hexArgument(log, 'messageId'),
    };
    const block = await this.blockchain.sourceReader.getBlock({
      blockNumber: log.blockNumber,
    });
    await this.database.query(
      `
        UPDATE dispatch
        SET
          status = CASE
            WHEN status IN ('DESTINATION_CONFIRMED', 'DESTINATION_IGNORED')
              THEN status
            ELSE 'SOURCE_ACCEPTED'
          END,
          message_id = $4,
          source_transaction_hash = $5,
          source_block_number = $6,
          source_block_hash = $7,
          gas_limit = $8,
          fee_token = $9,
          fee_amount = $10,
          sent_at = to_timestamp($11),
          failure_code = NULL,
          failure_detail = NULL,
          recovery_reason = NULL,
          updated_at = now()
        WHERE
          document_id = $1
          AND document_version = $2
          AND destination_selector = $3
      `,
      [
        documentId,
        documentVersion.toString(),
        destinationSelector.toString(),
        snapshot.messageId,
        log.transactionHash,
        log.blockNumber.toString(),
        log.blockHash,
        snapshot.gasLimit,
        snapshot.feeToken,
        snapshot.fees.toString(),
        block.timestamp.toString(),
      ],
    );
  }

  private async persistEvent(
    chain: ChainRuntimeConfig,
    log: IndexedLog,
  ): Promise<void> {
    await this.database.query(
      `
        INSERT INTO processed_chain_event(
          chain_id, contract_address, transaction_hash, log_index,
          block_number, block_hash, event_name, event_payload, canonical
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)
        ON CONFLICT (chain_id, transaction_hash, log_index)
        DO UPDATE SET
          contract_address = EXCLUDED.contract_address,
          block_number = EXCLUDED.block_number,
          block_hash = EXCLUDED.block_hash,
          event_name = EXCLUDED.event_name,
          event_payload = EXCLUDED.event_payload,
          canonical = true,
          processed_at = now()
      `,
      [
        chain.chainId,
        chain.contractAddress,
        log.transactionHash,
        log.logIndex,
        log.blockNumber.toString(),
        log.blockHash,
        log.eventName,
        serializedArgs(log.args),
      ],
    );
  }

  private async ensureCursor(chain: ChainRuntimeConfig): Promise<ChainCursor> {
    const result = await this.database.query<ChainCursor>(
      `
        INSERT INTO chain_cursor(chain_id, contract_address, next_block)
        VALUES($1,$2,$3)
        ON CONFLICT (chain_id, contract_address) DO UPDATE
          SET contract_address = EXCLUDED.contract_address
        RETURNING next_block, last_finalized_block, last_finalized_hash
      `,
      [chain.chainId, chain.contractAddress, chain.deploymentBlock.toString()],
    );
    return result.rows[0];
  }

  private async cursorWasReorganized(
    cursor: ChainCursor,
    finalizedBlock: bigint,
    side: 'destination' | 'source',
  ): Promise<boolean> {
    if (
      cursor.last_finalized_block === null ||
      cursor.last_finalized_hash === null
    ) {
      return false;
    }
    const lastBlock = BigInt(cursor.last_finalized_block);
    if (lastBlock > finalizedBlock) {
      this.logger.warn(`${side} finalized head moved behind its cursor`);
      return true;
    }
    const block = await (
      side === 'source'
        ? this.blockchain.sourceReader
        : this.blockchain.destinationReader
    ).getBlock({ blockNumber: lastBlock });
    const reorganized = cursorRequiresRebuild(
      lastBlock,
      cursor.last_finalized_hash,
      finalizedBlock,
      block.hash,
    );
    if (reorganized) {
      this.logger.warn(
        `${side} cursor hash changed; rebuilding from deployment`,
      );
    }
    return reorganized;
  }

  private async resetSource(chain: ChainRuntimeConfig): Promise<void> {
    await this.database.transaction(async (client) => {
      const transactions = await client.query<{
        id: string;
        intent_id: string;
      }>(
        `
          UPDATE source_transaction
          SET
            state = 'UNKNOWN',
            block_number = NULL,
            block_hash = NULL,
            receipt_status = NULL,
            confirmation_count = 0,
            canonical_event = NULL,
            failure_code = 'SOURCE_REORG_RECONCILIATION',
            failure_detail = 'Canonical source cursor changed',
            updated_at = now()
          WHERE state = 'CONFIRMED' AND block_number IS NOT NULL
          RETURNING id, intent_id
        `,
      );
      for (const transaction of transactions.rows) {
        await client.query(
          `
            UPDATE document_intent
            SET
              status = 'FAILED_RETRYABLE',
              source_confirmed_at = NULL,
              failure_code = 'SOURCE_REORG_RECONCILIATION',
              failure_detail = 'Canonical source cursor changed',
              updated_at = now()
            WHERE id = $1 AND status = 'SOURCE_CONFIRMED'
          `,
          [transaction.intent_id],
        );
        await client.query(
          `
            INSERT INTO outbox_job(
              deduplication_key, job_type, intent_id, payload
            )
            VALUES($1,'RECONCILE',$2,$3)
            ON CONFLICT (deduplication_key) DO UPDATE SET
              state = 'READY',
              available_at = now(),
              locked_at = NULL,
              locked_by = NULL,
              last_error = NULL,
              updated_at = now()
            WHERE outbox_job.state IN ('COMPLETED', 'FAILED')
          `,
          [
            `intent:${transaction.intent_id}:reconcile-source:${transaction.id}`,
            transaction.intent_id,
            {
              intentId: transaction.intent_id,
              transactionId: transaction.id,
            },
          ],
        );
      }
      await client.query(
        `
          UPDATE processed_chain_event
          SET canonical = false, processed_at = now()
          WHERE chain_id = $1 AND contract_address = $2
        `,
        [chain.chainId, chain.contractAddress],
      );
      await client.query(
        `DELETE FROM document_projection WHERE source_chain_id = $1`,
        [chain.chainId],
      );
      await client.query(
        `
          UPDATE dispatch
          SET
            status = 'RECOVERY_REQUIRED',
            failure_code = 'SOURCE_REORG_RECONCILIATION',
            failure_detail = 'Canonical source cursor changed',
            recovery_reason = 'Canonical source cursor changed',
            updated_at = now()
          WHERE source_block_number IS NOT NULL
        `,
      );
      await client.query(
        `
          UPDATE chain_cursor
          SET
            next_block = $3,
            last_finalized_block = NULL,
            last_finalized_hash = NULL,
            updated_at = now()
          WHERE chain_id = $1 AND contract_address = $2
        `,
        [
          chain.chainId,
          chain.contractAddress,
          chain.deploymentBlock.toString(),
        ],
      );
    });
  }

  private async resetDestination(chain: ChainRuntimeConfig): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `
          UPDATE processed_chain_event
          SET canonical = false, processed_at = now()
          WHERE chain_id = $1 AND contract_address = $2
        `,
        [chain.chainId, chain.contractAddress],
      );
      await client.query(
        `
          UPDATE dispatch
          SET
            status = 'SOURCE_ACCEPTED',
            destination_transaction_hash = NULL,
            destination_block_number = NULL,
            destination_block_hash = NULL,
            destination_confirmed_at = NULL,
            failure_code = 'DESTINATION_REORG_RECONCILIATION',
            failure_detail = 'Canonical destination cursor changed',
            recovery_reason = 'Canonical destination cursor changed',
            updated_at = now()
          WHERE destination_block_number IS NOT NULL
        `,
      );
      await client.query(
        `
          UPDATE chain_cursor
          SET
            next_block = $3,
            last_finalized_block = NULL,
            last_finalized_hash = NULL,
            updated_at = now()
          WHERE chain_id = $1 AND contract_address = $2
        `,
        [
          chain.chainId,
          chain.contractAddress,
          chain.deploymentBlock.toString(),
        ],
      );
    });
  }

  private async enqueuePendingDispatches(): Promise<void> {
    await this.database.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, dispatch_id, payload
        )
        SELECT
          'dispatch:' || document_id || ':' || document_version || ':' ||
            destination_selector,
          'DISPATCH_DESTINATION',
          id,
          jsonb_build_object('dispatchId', id)
        FROM dispatch
        WHERE status = 'PENDING'
        ON CONFLICT (deduplication_key) DO UPDATE SET
          state = 'READY',
          available_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          last_error = NULL,
          updated_at = now()
        WHERE outbox_job.state IN ('COMPLETED', 'FAILED')
      `,
    );
  }

  private async enqueueSourceAcceptedTracking(): Promise<void> {
    await this.database.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, dispatch_id, payload
        )
        SELECT
          'dispatch:' || id || ':track-destination',
          'TRACK_DESTINATION',
          id,
          jsonb_build_object('dispatchId', id)
        FROM dispatch
        WHERE status = 'SOURCE_ACCEPTED' AND message_id IS NOT NULL
        ON CONFLICT (deduplication_key) DO UPDATE SET
          state = 'READY',
          available_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          last_error = NULL,
          updated_at = now()
        WHERE outbox_job.state IN ('COMPLETED', 'FAILED')
      `,
    );
  }

  private async enqueueRecoveryRequired(): Promise<void> {
    await this.database.query(
      `
        INSERT INTO outbox_job(
          deduplication_key, job_type, dispatch_id, payload
        )
        SELECT
          'dispatch:' || id || ':reconcile-reorg',
          'RECONCILE',
          id,
          jsonb_build_object('dispatchId', id)
        FROM dispatch
        WHERE
          status = 'RECOVERY_REQUIRED'
          AND failure_code = 'SOURCE_REORG_RECONCILIATION'
        ON CONFLICT (deduplication_key) DO UPDATE SET
          state = 'READY',
          available_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          last_error = NULL,
          updated_at = now()
        WHERE outbox_job.state IN ('COMPLETED', 'FAILED')
      `,
    );
  }

  private async finalizedBlock(
    reader: BlockchainService['sourceReader'],
    chain: ChainRuntimeConfig,
  ): Promise<bigint> {
    const head = await reader.getBlockNumber();
    const depth = BigInt(chain.confirmations);
    if (depth === 0n) {
      return head;
    }
    return head >= depth ? head - depth + 1n : 0n;
  }

  private readerFor(
    chain: ChainRuntimeConfig,
  ): BlockchainService['sourceReader'] {
    return chain.chainId === this.runtime.blockchain.source.chainId
      ? this.blockchain.sourceReader
      : this.blockchain.destinationReader;
  }
}
