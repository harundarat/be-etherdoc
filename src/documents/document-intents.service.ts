import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress, type Address, type Hex, zeroHash } from 'viem';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../config/runtime-config';
import { BlockchainService } from '../blockchain/blockchain.service';
import { DatabaseService } from '../database/database.service';
import { etherdocContractArtifacts } from '../contracts/generated';
import { PinataStorageService } from '../storage/pinata-storage.service';
import {
  canonicalizeMetadata,
  computeDocumentId,
  sha256Digest,
} from './canonical-document';
import {
  jsonTypedData,
  registerTypedData,
  revokeTypedData,
  supersedeTypedData,
  typedDataDigest,
  type RegisterAuthorization,
  type RevokeAuthorization,
  type SupersedeAuthorization,
} from './intent-typed-data';
import type {
  RegisterIntentDto,
  RevokeIntentDto,
  SupersedeIntentDto,
} from './dto';
import { CorrelationContextService } from '../observability/correlation-context.service';

type IntentOperation = 'REGISTER' | 'REVOKE' | 'SUPERSEDE';
type IntentStatus =
  | 'PREPARED'
  | 'SIGNED'
  | 'SOURCE_PENDING'
  | 'SOURCE_CONFIRMED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_TERMINAL';

interface IntentRow {
  canonical_metadata: Record<string, unknown>;
  chain_nonce: string;
  content_digest: Hex | null;
  created_at: Date;
  deadline: Date;
  document_id: Hex | null;
  failure_code: string | null;
  failure_detail: string | null;
  id: string;
  idempotency_key: string;
  issuer: Address;
  metadata_commitment: Hex | null;
  old_document_id: Hex | null;
  operation: IntentOperation;
  status: IntentStatus;
  typed_data: Record<string, unknown>;
  typed_data_digest: Hex;
  updated_at: Date;
}

interface CanonicalDocumentRecord {
  issuer: Address;
  status: number;
  version: bigint;
}

export interface IntentView {
  chainNonce: string;
  createdAt: string;
  deadline: string;
  documentId: Hex | null;
  failure: { code: string; detail: string | null } | null;
  id: string;
  idempotencyKey: string;
  issuer: Address;
  oldDocumentId: Hex | null;
  operation: IntentOperation;
  status: IntentStatus;
  typedData: Record<string, unknown>;
  typedDataDigest: Hex;
  updatedAt: string;
}

@Injectable()
export class DocumentIntentsService {
  private readonly logger = new Logger(DocumentIntentsService.name);
  private readonly runtime: RuntimeConfig;
  private readonly senderAbi = etherdocContractArtifacts.contracts.sender.abi;

  constructor(
    private readonly blockchain: BlockchainService,
    configService: ConfigService,
    private readonly database: DatabaseService,
    private readonly storage: PinataStorageService,
    @Optional() private readonly correlation?: CorrelationContextService,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  async prepareRegister(
    subject: Address,
    file: Express.Multer.File,
    request: RegisterIntentDto,
  ): Promise<IntentView> {
    const issuer = this.assertSubject(subject, request.issuer);
    const metadata = canonicalizeMetadata({
      byteLength: file.buffer.length,
      documentType: request.documentType,
      mimeType: file.mimetype,
      storageNetwork: request.storageNetwork,
    });
    const localContentDigest = sha256Digest(file.buffer);
    const documentId = computeDocumentId(issuer, localContentDigest);
    const existing = await this.findIdempotent(
      request.idempotencyKey,
      issuer,
      'REGISTER',
      {
        canonicalMetadata: metadata.preimage,
        contentDigest: localContentDigest,
        documentId,
        metadataCommitment: metadata.commitment,
        oldDocumentId: null,
      },
    );
    if (existing) {
      return this.view(existing);
    }
    const nonce = await this.authorizedIssuerNonce(issuer);
    const pinned = await this.storage.pinAndVerify(
      file,
      request.storageNetwork,
      metadata,
    );
    if (pinned.contentDigest !== localContentDigest) {
      throw new UnprocessableEntityException(
        'Pinned content digest does not match the local request digest',
      );
    }
    const deadline = this.deadline();
    const authorization: RegisterAuthorization = {
      cidCodec: pinned.cidCodec,
      cidDigest: pinned.cidDigest,
      contentDigest: pinned.contentDigest,
      deadline,
      documentId,
      issuer,
      metadataCommitment: metadata.commitment,
      nonce,
    };
    const typedData = registerTypedData(this.domain(), authorization);
    const digest = typedDataDigest(typedData);
    const contractDigest = await this.blockchain.sourceReader.readContract({
      abi: this.senderAbi,
      address: this.runtime.blockchain.source.contractAddress,
      functionName: 'getRegisterDocumentDigest',
      args: [
        issuer,
        pinned.contentDigest,
        pinned.cid,
        metadata.commitment,
        nonce,
        deadline,
      ],
    });
    this.assertDigest(digest, contractDigest);

    return this.database.transaction(async (client) => {
      const row = await this.insertIntent(client, {
        canonicalMetadata: metadata.preimage,
        chainNonce: nonce,
        cidCodec: pinned.cidCodec,
        cidDigest: pinned.cidDigest,
        contentDigest: pinned.contentDigest,
        deadline,
        documentCid: pinned.cid,
        documentId,
        idempotencyKey: request.idempotencyKey,
        issuer,
        metadataCommitment: metadata.commitment,
        oldDocumentId: null,
        operation: 'REGISTER',
        typedData: jsonTypedData(typedData),
        typedDataDigest: digest,
      });
      await client.query(
        `
          INSERT INTO pinned_artifact(
            intent_id,
            storage_provider_id,
            storage_network,
            document_cid,
            cid_codec,
            cid_digest,
            content_digest,
            exact_byte_size,
            mime_type,
            original_filename,
            metadata_preimage,
            retrieval_verified_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
        `,
        [
          row.id,
          pinned.providerId,
          request.storageNetwork,
          pinned.cid,
          pinned.cidCodec,
          pinned.cidDigest,
          pinned.contentDigest,
          file.buffer.length,
          file.mimetype,
          pinned.storageFilename,
          metadata.preimage,
        ],
      );
      return this.view(row);
    });
  }

  async prepareRevoke(
    subject: Address,
    request: RevokeIntentDto,
  ): Promise<IntentView> {
    const issuer = this.assertSubject(subject, request.issuer);
    const documentId = request.documentId.toLowerCase() as Hex;
    const existing = await this.findIdempotent(
      request.idempotencyKey,
      issuer,
      'REVOKE',
      {
        canonicalMetadata: {},
        contentDigest: null,
        documentId,
        metadataCommitment: null,
        oldDocumentId: null,
      },
    );
    if (existing) {
      return this.view(existing);
    }
    const [nonce, document] = await Promise.all([
      this.authorizedIssuerNonce(issuer),
      this.readActiveDocument(documentId, issuer),
    ]);
    const deadline = this.deadline();
    const authorization: RevokeAuthorization = {
      currentVersion: document.version,
      deadline,
      documentId,
      issuer,
      nonce,
    };
    const typedData = revokeTypedData(this.domain(), authorization);
    const digest = typedDataDigest(typedData);
    const contractDigest = await this.blockchain.sourceReader.readContract({
      abi: this.senderAbi,
      address: this.runtime.blockchain.source.contractAddress,
      functionName: 'getRevokeDocumentDigest',
      args: [issuer, documentId, document.version, nonce, deadline],
    });
    this.assertDigest(digest, contractDigest);
    const row = await this.database.transaction((client) =>
      this.insertIntent(client, {
        canonicalMetadata: {},
        chainNonce: nonce,
        cidCodec: null,
        cidDigest: null,
        contentDigest: null,
        currentVersion: document.version,
        deadline,
        documentCid: null,
        documentId,
        idempotencyKey: request.idempotencyKey,
        issuer,
        metadataCommitment: null,
        oldDocumentId: null,
        operation: 'REVOKE',
        typedData: jsonTypedData(typedData),
        typedDataDigest: digest,
      }),
    );
    return this.view(row);
  }

  async prepareSupersede(
    subject: Address,
    file: Express.Multer.File,
    request: SupersedeIntentDto,
  ): Promise<IntentView> {
    const issuer = this.assertSubject(subject, request.issuer);
    const oldDocumentId = request.oldDocumentId.toLowerCase() as Hex;
    const metadata = canonicalizeMetadata({
      byteLength: file.buffer.length,
      documentType: request.documentType,
      mimeType: file.mimetype,
      storageNetwork: request.storageNetwork,
    });
    const localContentDigest = sha256Digest(file.buffer);
    const newDocumentId = computeDocumentId(issuer, localContentDigest);
    const existing = await this.findIdempotent(
      request.idempotencyKey,
      issuer,
      'SUPERSEDE',
      {
        canonicalMetadata: metadata.preimage,
        contentDigest: localContentDigest,
        documentId: newDocumentId,
        metadataCommitment: metadata.commitment,
        oldDocumentId,
      },
    );
    if (existing) {
      return this.view(existing);
    }
    const [nonce, oldDocument] = await Promise.all([
      this.authorizedIssuerNonce(issuer),
      this.readActiveDocument(oldDocumentId, issuer),
    ]);
    const pinned = await this.storage.pinAndVerify(
      file,
      request.storageNetwork,
      metadata,
    );
    if (pinned.contentDigest !== localContentDigest) {
      throw new UnprocessableEntityException(
        'Pinned content digest does not match the local request digest',
      );
    }
    const deadline = this.deadline();
    const authorization: SupersedeAuthorization = {
      currentVersion: oldDocument.version,
      deadline,
      issuer,
      metadataCommitment: metadata.commitment,
      newCidCodec: pinned.cidCodec,
      newCidDigest: pinned.cidDigest,
      newContentDigest: pinned.contentDigest,
      newDocumentId,
      nonce,
      oldDocumentId,
    };
    const typedData = supersedeTypedData(this.domain(), authorization);
    const digest = typedDataDigest(typedData);
    const contractDigest = await this.blockchain.sourceReader.readContract({
      abi: this.senderAbi,
      address: this.runtime.blockchain.source.contractAddress,
      functionName: 'getSupersedeDocumentDigest',
      args: [
        issuer,
        oldDocumentId,
        oldDocument.version,
        pinned.contentDigest,
        pinned.cid,
        metadata.commitment,
        nonce,
        deadline,
      ],
    });
    this.assertDigest(digest, contractDigest);

    return this.database.transaction(async (client) => {
      const row = await this.insertIntent(client, {
        canonicalMetadata: metadata.preimage,
        chainNonce: nonce,
        cidCodec: pinned.cidCodec,
        cidDigest: pinned.cidDigest,
        contentDigest: pinned.contentDigest,
        currentVersion: oldDocument.version,
        deadline,
        documentCid: pinned.cid,
        documentId: newDocumentId,
        idempotencyKey: request.idempotencyKey,
        issuer,
        metadataCommitment: metadata.commitment,
        oldDocumentId,
        operation: 'SUPERSEDE',
        typedData: jsonTypedData(typedData),
        typedDataDigest: digest,
      });
      await client.query(
        `
          INSERT INTO pinned_artifact(
            intent_id, storage_provider_id, storage_network, document_cid,
            cid_codec, cid_digest, content_digest, exact_byte_size, mime_type,
            original_filename, metadata_preimage, retrieval_verified_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
        `,
        [
          row.id,
          pinned.providerId,
          request.storageNetwork,
          pinned.cid,
          pinned.cidCodec,
          pinned.cidDigest,
          pinned.contentDigest,
          file.buffer.length,
          file.mimetype,
          pinned.storageFilename,
          metadata.preimage,
        ],
      );
      return this.view(row);
    });
  }

  async submitSignature(
    subject: Address,
    intentId: string,
    signature: Hex,
  ): Promise<IntentView> {
    const intent = await this.getIntentRow(intentId);
    this.assertSubject(subject, intent.issuer);
    if (intent.status !== 'PREPARED') {
      throw new ConflictException(`Intent is already ${intent.status}`);
    }
    if (intent.deadline.getTime() <= Date.now()) {
      throw new ConflictException('Intent signature deadline has expired');
    }
    const currentNonce = await this.blockchain.sourceReader.readContract({
      abi: this.senderAbi,
      address: this.runtime.blockchain.source.contractAddress,
      functionName: 'issuerNonce',
      args: [intent.issuer],
    });
    if (currentNonce.toString() !== intent.chain_nonce) {
      throw new ConflictException('Issuer nonce is stale');
    }

    const typedData = this.hydrateTypedData(intent);
    const valid = await this.blockchain.sourceReader.verifyTypedData({
      address: intent.issuer,
      ...typedData,
      signature,
    });
    if (!valid) {
      throw new UnprocessableEntityException('Invalid intent signature');
    }
    const issuerCode = await this.blockchain.sourceReader.getBytecode({
      address: intent.issuer,
    });
    const signatureKind = issuerCode && issuerCode !== '0x' ? 'ERC1271' : 'EOA';

    const updated = await this.database.transaction(async (client) => {
      const locked = await client.query<IntentRow>(
        `SELECT * FROM document_intent WHERE id = $1 FOR UPDATE`,
        [intentId],
      );
      if (locked.rows[0]?.status !== 'PREPARED') {
        throw new ConflictException('Intent was processed concurrently');
      }
      await client.query(
        `
          INSERT INTO document_signature(
            intent_id, signer, signature, signature_kind, verified_digest
          )
          VALUES ($1,$2,$3,$4,$5)
        `,
        [
          intentId,
          intent.issuer,
          signature,
          signatureKind,
          intent.typed_data_digest,
        ],
      );
      const result = await client.query<IntentRow>(
        `
          UPDATE document_intent
          SET status = 'SIGNED', signed_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [intentId],
      );
      await client.query(
        `
          INSERT INTO outbox_job(
            deduplication_key, job_type, intent_id, payload
          )
          VALUES ($1, 'SUBMIT_SOURCE', $2, $3)
        `,
        [
          `intent:${intentId}:submit-source`,
          intentId,
          this.correlatedPayload('intentId', intentId),
        ],
      );
      return result.rows[0];
    });
    this.logger.log({
      correlationId: this.correlation?.currentId() ?? null,
      event: 'intent_signature_accepted',
      intentId,
      operation: intent.operation,
      status: updated.status,
    });
    return this.view(updated);
  }

  async getIntent(subject: Address, intentId: string): Promise<IntentView> {
    const intent = await this.getIntentRow(intentId);
    this.assertSubject(subject, intent.issuer);
    return this.view(intent);
  }

  private domain() {
    return {
      chainId: this.runtime.blockchain.source.chainId,
      verifyingContract: this.runtime.blockchain.source.contractAddress,
    };
  }

  private deadline(): bigint {
    return BigInt(
      Math.floor(Date.now() / 1_000) + this.runtime.intent.signatureTtlSeconds,
    );
  }

  private correlatedPayload(
    key: 'dispatchId' | 'intentId',
    value: string,
  ): Record<string, string> {
    const correlationId = this.correlation?.currentId();
    return correlationId ? { [key]: value, correlationId } : { [key]: value };
  }

  private async authorizedIssuerNonce(issuer: Address): Promise<bigint> {
    const [authorized, nonce] = await Promise.all([
      this.blockchain.sourceReader.readContract({
        abi: this.senderAbi,
        address: this.runtime.blockchain.source.contractAddress,
        functionName: 'isIssuerAuthorized',
        args: [issuer],
      }),
      this.blockchain.sourceReader.readContract({
        abi: this.senderAbi,
        address: this.runtime.blockchain.source.contractAddress,
        functionName: 'issuerNonce',
        args: [issuer],
      }),
    ]);
    if (!authorized) {
      throw new ForbiddenException(
        'Issuer is not authorized by the source contract',
      );
    }
    return nonce;
  }

  private async readActiveDocument(
    documentId: Hex,
    issuer: Address,
  ): Promise<CanonicalDocumentRecord> {
    const document = await this.blockchain.sourceReader.readContract({
      abi: this.senderAbi,
      address: this.runtime.blockchain.source.contractAddress,
      functionName: 'getDocument',
      args: [documentId],
    });
    if (document.documentId === zeroHash) {
      throw new NotFoundException('Document is not registered');
    }
    if (getAddress(document.issuer) !== issuer) {
      throw new ForbiddenException('JWT subject is not the document issuer');
    }
    if (document.status !== 1) {
      throw new ConflictException('Document is not active');
    }
    return document;
  }

  private assertDigest(localDigest: Hex, contractDigest: Hex): void {
    if (localDigest !== contractDigest) {
      throw new UnprocessableEntityException(
        'Backend typed-data digest does not match the source contract',
      );
    }
  }

  private assertSubject(subject: Address, claimedIssuer: string): Address {
    let issuer: Address;
    try {
      issuer = getAddress(claimedIssuer);
    } catch {
      throw new UnauthorizedException('Invalid issuer');
    }
    if (getAddress(subject) !== issuer) {
      throw new ForbiddenException('JWT subject must equal intent issuer');
    }
    return issuer;
  }

  private async findIdempotent(
    idempotencyKey: string,
    issuer: Address,
    operation: IntentOperation,
    expected: {
      canonicalMetadata: Record<string, unknown>;
      contentDigest: Hex | null;
      documentId: Hex;
      metadataCommitment: Hex | null;
      oldDocumentId: Hex | null;
    },
  ): Promise<IntentRow | null> {
    const result = await this.database.query<IntentRow>(
      `SELECT * FROM document_intent WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const existing = result.rows[0];
    if (
      existing &&
      (getAddress(existing.issuer) !== issuer ||
        existing.operation !== operation ||
        existing.document_id?.toLowerCase() !==
          expected.documentId.toLowerCase() ||
        existing.old_document_id?.toLowerCase() !==
          expected.oldDocumentId?.toLowerCase() ||
        existing.content_digest?.toLowerCase() !==
          expected.contentDigest?.toLowerCase() ||
        existing.metadata_commitment?.toLowerCase() !==
          expected.metadataCommitment?.toLowerCase() ||
        JSON.stringify(existing.canonical_metadata) !==
          JSON.stringify(expected.canonicalMetadata))
    ) {
      throw new ConflictException(
        'Idempotency key belongs to different canonical intent input',
      );
    }
    return existing ?? null;
  }

  private async getIntentRow(intentId: string): Promise<IntentRow> {
    const result = await this.database.query<IntentRow>(
      `SELECT * FROM document_intent WHERE id = $1`,
      [intentId],
    );
    if (!result.rows[0]) {
      throw new NotFoundException('Intent not found');
    }
    return result.rows[0];
  }

  private async insertIntent(
    client: PoolClient,
    input: {
      canonicalMetadata: Record<string, unknown>;
      chainNonce: bigint;
      cidCodec: number | null;
      cidDigest: Hex | null;
      contentDigest: Hex | null;
      currentVersion?: bigint;
      deadline: bigint;
      documentCid: string | null;
      documentId: Hex;
      idempotencyKey: string;
      issuer: Address;
      metadataCommitment: Hex | null;
      oldDocumentId: Hex | null;
      operation: IntentOperation;
      typedData: Record<string, unknown>;
      typedDataDigest: Hex;
    },
  ): Promise<IntentRow> {
    try {
      const result = await client.query<IntentRow>(
        `
          INSERT INTO document_intent(
            idempotency_key, operation, status, issuer, chain_nonce, deadline,
            document_id, old_document_id, content_digest, metadata_commitment,
            canonical_metadata, document_cid, cid_codec, cid_digest,
            current_version, typed_data, typed_data_digest
          )
          VALUES (
            $1,$2,'PREPARED',$3,$4,to_timestamp($5),$6,$7,$8,$9,$10,$11,$12,
            $13,$14,$15,$16
          )
          RETURNING *
        `,
        [
          input.idempotencyKey,
          input.operation,
          input.issuer,
          input.chainNonce.toString(),
          input.deadline.toString(),
          input.documentId,
          input.oldDocumentId,
          input.contentDigest,
          input.metadataCommitment,
          input.canonicalMetadata,
          input.documentCid,
          input.cidCodec,
          input.cidDigest,
          input.currentVersion?.toString() ?? null,
          input.typedData,
          input.typedDataDigest,
        ],
      );
      return result.rows[0];
    } catch (error) {
      const errorCode = (error as { code?: unknown } | null)?.code;
      if (typeof errorCode === 'string' && errorCode === '23505') {
        throw new ConflictException(
          'Issuer nonce or idempotency key already has a pending intent',
        );
      }
      throw error;
    }
  }

  private hydrateTypedData(intent: IntentRow) {
    const message = intent.typed_data.message as Record<
      string,
      string | number
    >;
    if (intent.operation === 'REGISTER') {
      return registerTypedData(this.domain(), {
        cidCodec: Number(message.cidCodec),
        cidDigest: message.cidDigest as Hex,
        contentDigest: message.contentDigest as Hex,
        deadline: BigInt(message.deadline),
        documentId: message.documentId as Hex,
        issuer: intent.issuer,
        metadataCommitment: message.metadataCommitment as Hex,
        nonce: BigInt(message.nonce),
      });
    }
    if (intent.operation === 'REVOKE') {
      return revokeTypedData(this.domain(), {
        currentVersion: BigInt(message.currentVersion),
        deadline: BigInt(message.deadline),
        documentId: message.documentId as Hex,
        issuer: intent.issuer,
        nonce: BigInt(message.nonce),
      });
    }
    return supersedeTypedData(this.domain(), {
      currentVersion: BigInt(message.currentVersion),
      deadline: BigInt(message.deadline),
      issuer: intent.issuer,
      metadataCommitment: message.metadataCommitment as Hex,
      newCidCodec: Number(message.newCidCodec),
      newCidDigest: message.newCidDigest as Hex,
      newContentDigest: message.newContentDigest as Hex,
      newDocumentId: message.newDocumentId as Hex,
      nonce: BigInt(message.nonce),
      oldDocumentId: message.oldDocumentId as Hex,
    });
  }

  private view(row: IntentRow): IntentView {
    return {
      chainNonce: row.chain_nonce,
      createdAt: row.created_at.toISOString(),
      deadline: row.deadline.toISOString(),
      documentId: row.document_id,
      failure: row.failure_code
        ? { code: row.failure_code, detail: row.failure_detail }
        : null,
      id: row.id,
      idempotencyKey: row.idempotency_key,
      issuer: getAddress(row.issuer),
      oldDocumentId: row.old_document_id,
      operation: row.operation,
      status: row.status,
      typedData: row.typed_data,
      typedDataDigest: row.typed_data_digest,
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
