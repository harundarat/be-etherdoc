import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress, type Address, type Hex } from 'viem';
import { BlockchainService } from '../blockchain/blockchain.service';
import { classifyBlockchainError } from '../blockchain/blockchain.errors';
import type { RuntimeConfig } from '../config/runtime-config';
import { etherdocContractArtifacts } from '../contracts/generated';
import { DatabaseService } from '../database/database.service';
import { PinataStorageService } from '../storage/pinata-storage.service';
import {
  cancelResponseBody,
  InvalidJsonResponseError,
  PINATA_JSON_RESPONSE_MAX_BYTES,
  readBoundedJsonResponse,
  ResponseBodyTooLargeError,
} from '../storage/bounded-response';
import { computeDocumentId, sha256Digest } from './canonical-document';
import type { SearchDocumentDto } from './dto';
import { StorageNetwork } from '../storage/storage-network';

const zeroHash = `0x${'0'.repeat(64)}` as const;

interface CanonicalDocumentRecord {
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

interface DispatchEvidenceRow {
  destination_block_hash: Hex | null;
  destination_block_number: string | null;
  destination_confirmed_at: Date | null;
  destination_selector: string;
  destination_transaction_hash: Hex | null;
  document_version: string;
  failure_code: string | null;
  failure_detail: string | null;
  fee_amount: string | null;
  fee_token: Address | null;
  gas_limit: number;
  message_id: Hex | null;
  receiver: Address;
  source_block_hash: Hex | null;
  source_block_number: string | null;
  source_transaction_hash: Hex | null;
  status:
    | 'DESTINATION_CONFIRMED'
    | 'DESTINATION_IGNORED'
    | 'PENDING'
    | 'RECOVERY_REQUIRED'
    | 'SOURCE_ACCEPTED';
}

interface ProjectionEvidenceRow {
  content_digest: Hex;
  document_version: string;
  issuer: Address;
  lifecycle_status: 'ACTIVE' | 'REVOKED' | 'SUPERSEDED';
  source_block_hash: Hex;
  source_block_number: string;
  source_tx_hash: Hex;
}

interface ReceiverDocumentRecord {
  contentDigest: Hex;
  documentId: Hex;
  issuer: Address;
  status: number;
  version: bigint;
}

interface ReceiverReceipt {
  document: ReceiverDocumentRecord;
  messageId: Hex;
  sender: Address;
  sourceChainSelector: bigint;
  status: number;
}

@Injectable()
export class DocumentsService {
  private readonly runtime: RuntimeConfig;
  private readonly receiverAbi =
    etherdocContractArtifacts.contracts.receiver.abi;
  private readonly senderAbi = etherdocContractArtifacts.contracts.sender.abi;

  constructor(
    private readonly blockchain: BlockchainService,
    configService: ConfigService,
    private readonly database: DatabaseService,
    private readonly storage: PinataStorageService,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  createGroup(network: StorageNetwork, groupName: string): Promise<unknown> {
    return this.pinataRequest(`/groups/${network}`, {
      body: JSON.stringify({ name: groupName }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  }

  getListFiles(network: StorageNetwork, groupId?: string): Promise<unknown> {
    const url = new URL(`${this.runtime.pinata.apiUrl}/files/${network}`);
    if (groupId) {
      url.searchParams.set('group', groupId);
    }
    return this.pinataRequest(url);
  }

  getListGroups(network: StorageNetwork): Promise<unknown> {
    return this.pinataRequest(`/groups/${network}`);
  }

  async search(
    request: SearchDocumentDto,
    file?: Express.Multer.File,
  ): Promise<unknown> {
    let documentId = request.documentId
      ? this.parseDocumentId(request.documentId)
      : undefined;
    let contentDigest: Hex | undefined;
    let issuer: Address | undefined;

    if (file) {
      if (!request.issuer) {
        throw new BadRequestException(
          'issuer is required when searching by file',
        );
      }
      issuer = getAddress(request.issuer);
      contentDigest = sha256Digest(file.buffer);
      const computedDocumentId = computeDocumentId(issuer, contentDigest);
      if (documentId && documentId !== computedDocumentId) {
        throw new UnprocessableEntityException({
          error: 'DOCUMENT_ID_MISMATCH',
          message:
            'Explicit documentId does not match the uploaded bytes and issuer',
        });
      }
      documentId = computedDocumentId;
    } else if (request.issuer) {
      issuer = getAddress(request.issuer);
    }
    if (!documentId) {
      throw new BadRequestException(
        'Provide an explicit documentId or a PDF file with issuer',
      );
    }
    return this.getDocument(documentId, contentDigest, issuer);
  }

  async getDocument(
    requestedDocumentId: string,
    requestedContentDigest?: Hex,
    requestedIssuer?: Address,
  ): Promise<unknown> {
    const documentId = this.parseDocumentId(requestedDocumentId);
    let document: CanonicalDocumentRecord;
    try {
      document = await this.blockchain.sourceReader.readContract({
        abi: this.senderAbi,
        address: this.runtime.blockchain.source.contractAddress,
        args: [documentId],
        functionName: 'getDocument',
      });
    } catch (error) {
      const classified = classifyBlockchainError(
        error,
        'Canonical source document read failed',
      );
      throw new ServiceUnavailableException({
        error: 'SOURCE_READ_UNAVAILABLE',
        kind: classified.kind,
        message: classified.message,
      });
    }
    if (document.documentId === zeroHash) {
      throw new NotFoundException({
        error: 'DOCUMENT_NOT_FOUND',
        message: 'Document is not registered on the canonical source chain',
      });
    }

    const expectedDigest = requestedContentDigest ?? document.contentDigest;
    const expectedIssuer = requestedIssuer ?? getAddress(document.issuer);
    const [sourceVerification, projection, dispatches, storage] =
      await Promise.all([
        this.verifySource(documentId, expectedDigest),
        this.readProjection(documentId),
        this.readDispatches(documentId),
        this.storage.checkAvailability(document.documentCID),
      ]);
    const issuerMatches =
      getAddress(document.issuer) === getAddress(expectedIssuer);
    const contentMatches = document.contentDigest === expectedDigest;
    const integrityMatches =
      sourceVerification.integrityMatches &&
      sourceVerification.document.documentId === document.documentId &&
      sourceVerification.document.contentDigest === document.contentDigest &&
      getAddress(sourceVerification.document.issuer) ===
        getAddress(document.issuer) &&
      contentMatches &&
      issuerMatches;
    const [sourceEvidence, destinationEvidence] = await Promise.all([
      this.sourceEvidence(document, projection),
      Promise.all(
        dispatches.map((dispatch) =>
          this.destinationEvidence(document, dispatch),
        ),
      ),
    ]);
    const status = ['UNKNOWN', 'ACTIVE', 'REVOKED', 'SUPERSEDED'][
      document.status
    ];
    if (!status || status === 'UNKNOWN') {
      throw new ServiceUnavailableException({
        error: 'SOURCE_STATE_INVALID',
        message: 'Canonical source returned an invalid lifecycle state',
      });
    }

    return {
      canonicalSource: true,
      document: {
        cid: document.documentCID,
        cidCodec: document.cidCodec,
        cidDigest: document.cidDigest,
        contentDigest: document.contentDigest,
        documentId: document.documentId,
        issuer: getAddress(document.issuer),
        metadataCommitment: document.metadataCommitment,
        registeredAt: this.timestamp(document.registeredAt),
        schemaVersion: document.schemaVersion,
        sourceChainId: document.sourceChainId.toString(),
        status,
        supersededBy:
          document.supersededBy === zeroHash ? null : document.supersededBy,
        supersedes:
          document.supersedes === zeroHash ? null : document.supersedes,
        updatedAt: this.timestamp(document.updatedAt),
        version: document.version.toString(),
      },
      integrity: {
        active: sourceVerification.isActive,
        contentMatches,
        issuerMatches,
        matches: integrityMatches,
      },
      source: sourceEvidence,
      storage: {
        ...storage,
        authenticity: 'NOT_INFERRED_FROM_AVAILABILITY',
      },
      destinations: destinationEvidence,
    };
  }

  private async verifySource(
    documentId: Hex,
    contentDigest: Hex,
  ): Promise<{
    document: CanonicalDocumentRecord;
    integrityMatches: boolean;
    isActive: boolean;
  }> {
    try {
      const [document, integrityMatches, isActive] =
        await this.blockchain.sourceReader.readContract({
          abi: this.senderAbi,
          address: this.runtime.blockchain.source.contractAddress,
          args: [documentId, contentDigest],
          functionName: 'verifyDocument',
        });
      return {
        document,
        integrityMatches,
        isActive,
      };
    } catch (error) {
      const classified = classifyBlockchainError(
        error,
        'Canonical source verification failed',
      );
      throw new ServiceUnavailableException({
        error: 'SOURCE_VERIFICATION_UNAVAILABLE',
        kind: classified.kind,
        message: classified.message,
      });
    }
  }

  private async readProjection(
    documentId: Hex,
  ): Promise<ProjectionEvidenceRow | null> {
    const result = await this.database.query<ProjectionEvidenceRow>(
      `
        SELECT
          content_digest, document_version, issuer, lifecycle_status,
          source_tx_hash, source_block_number, source_block_hash
        FROM document_projection
        WHERE document_id = $1
      `,
      [documentId],
    );
    return result.rows[0] ?? null;
  }

  private async readDispatches(
    documentId: Hex,
  ): Promise<DispatchEvidenceRow[]> {
    const result = await this.database.query<DispatchEvidenceRow>(
      `
        SELECT
          destination_block_hash, destination_block_number,
          destination_confirmed_at, destination_selector,
          destination_transaction_hash, document_version,
          failure_code, failure_detail,
          fee_amount, fee_token, gas_limit, message_id, receiver,
          source_block_hash, source_block_number, source_transaction_hash,
          status
        FROM dispatch
        WHERE document_id = $1
        ORDER BY document_version DESC, destination_selector
      `,
      [documentId],
    );
    return result.rows;
  }

  private async sourceEvidence(
    document: CanonicalDocumentRecord,
    projection: ProjectionEvidenceRow | null,
  ): Promise<Record<string, unknown>> {
    const base = {
      chainId: this.runtime.blockchain.source.chainId,
      chainSelector: this.runtime.blockchain.source.chainSelector.toString(),
      confirmationDepth: this.runtime.blockchain.source.confirmations,
      contractAddress: this.runtime.blockchain.source.contractAddress,
    };
    if (!projection) {
      return {
        ...base,
        blockHash: null,
        blockNumber: null,
        confirmationStatus: 'UNINDEXED',
        transactionHash: null,
      };
    }
    const blockNumber = BigInt(projection.source_block_number);
    try {
      const [block, head] = await Promise.all([
        this.blockchain.sourceReader.getBlock({ blockNumber }),
        this.blockchain.sourceReader.getBlockNumber(),
      ]);
      const confirmations = head >= blockNumber ? head - blockNumber + 1n : 0n;
      const canonical = block.hash === projection.source_block_hash;
      const lifecycle = ['UNKNOWN', 'ACTIVE', 'REVOKED', 'SUPERSEDED'][
        document.status
      ];
      const projectionMatches =
        projection.content_digest === document.contentDigest &&
        projection.document_version === document.version.toString() &&
        getAddress(projection.issuer) === getAddress(document.issuer) &&
        projection.lifecycle_status === lifecycle;
      const deepEnough =
        confirmations >= BigInt(this.runtime.blockchain.source.confirmations);
      return {
        ...base,
        blockHash: projection.source_block_hash,
        blockNumber: projection.source_block_number,
        canonical,
        confirmations: confirmations.toString(),
        confirmationStatus:
          canonical && deepEnough && projectionMatches
            ? 'CONFIRMED'
            : 'MISMATCH',
        projectionMatches,
        transactionHash: projection.source_tx_hash,
      };
    } catch (error) {
      const classified = classifyBlockchainError(error);
      return {
        ...base,
        blockHash: projection.source_block_hash,
        blockNumber: projection.source_block_number,
        confirmationStatus: 'UNAVAILABLE',
        errorKind: classified.kind,
        transactionHash: projection.source_tx_hash,
      };
    }
  }

  private async destinationEvidence(
    document: CanonicalDocumentRecord,
    dispatch: DispatchEvidenceRow,
  ): Promise<Record<string, unknown>> {
    const evidence = {
      blockHash: dispatch.destination_block_hash,
      blockNumber: dispatch.destination_block_number,
      confirmedAt: dispatch.destination_confirmed_at?.toISOString() ?? null,
      transactionHash: dispatch.destination_transaction_hash,
    };
    const base = {
      chainId: this.runtime.blockchain.destination.chainId,
      chainSelector: dispatch.destination_selector,
      contractAddress: getAddress(dispatch.receiver),
      destinationEvidence: evidence,
      effectiveStatus: dispatch.status,
      failure: dispatch.failure_code
        ? { code: dispatch.failure_code, detail: dispatch.failure_detail }
        : null,
      fee: {
        amount: dispatch.fee_amount,
        gasLimit: dispatch.gas_limit,
        token: dispatch.fee_token ? getAddress(dispatch.fee_token) : null,
      },
      messageId: dispatch.message_id,
      version: dispatch.document_version,
      sourceEvidence: {
        blockHash: dispatch.source_block_hash,
        blockNumber: dispatch.source_block_number,
        transactionHash: dispatch.source_transaction_hash,
      },
      status: dispatch.status,
    };
    if (!dispatch.message_id) {
      return { ...base, receiver: { readStatus: 'NOT_SUBMITTED' } };
    }
    try {
      const [processedRaw, receiptRaw, verification] = await Promise.all([
        this.blockchain.destinationReader.readContract({
          abi: this.receiverAbi,
          address: this.runtime.blockchain.destination.contractAddress,
          args: [dispatch.message_id],
          functionName: 'getProcessedMessage',
        }),
        this.blockchain.destinationReader.readContract({
          abi: this.receiverAbi,
          address: this.runtime.blockchain.destination.contractAddress,
          args: [document.documentId],
          functionName: 'getReceipt',
        }),
        this.blockchain.destinationReader.readContract({
          abi: this.receiverAbi,
          address: this.runtime.blockchain.destination.contractAddress,
          args: [document.documentId, document.contentDigest],
          functionName: 'verifyDocument',
        }),
      ]);
      const processed = processedRaw;
      const receipt = receiptRaw as ReceiverReceipt;
      const [receiverDocument, integrityMatches, isActive] = verification;
      const dispatchVersion = BigInt(dispatch.document_version);
      const provenanceMatches =
        processed.documentId === document.documentId &&
        processed.documentVersion === dispatchVersion &&
        (receipt.document.version > dispatchVersion ||
          receipt.messageId === dispatch.message_id) &&
        receipt.sourceChainSelector ===
          this.runtime.blockchain.source.chainSelector &&
        getAddress(receipt.sender) ===
          this.runtime.blockchain.source.contractAddress &&
        receiverDocument.documentId === document.documentId &&
        receiverDocument.contentDigest === document.contentDigest &&
        getAddress(receiverDocument.issuer) === getAddress(document.issuer) &&
        receiverDocument.version >= dispatchVersion;
      const replicated =
        processed.processed && integrityMatches && provenanceMatches;
      return {
        ...base,
        effectiveStatus:
          dispatch.status === 'DESTINATION_CONFIRMED' && !replicated
            ? 'EVIDENCE_MISMATCH'
            : dispatch.status,
        receiver: {
          active: isActive,
          integrityMatches,
          processed: processed.processed,
          provenanceMatches,
          readStatus: 'AVAILABLE',
          receiptStatus: receipt.status,
          replicated,
          version: receiverDocument.version.toString(),
        },
      };
    } catch (error) {
      const classified = classifyBlockchainError(error);
      return {
        ...base,
        effectiveStatus:
          dispatch.status === 'DESTINATION_CONFIRMED'
            ? 'EVIDENCE_UNAVAILABLE'
            : dispatch.status,
        receiver: {
          errorKind: classified.kind,
          readStatus: 'UNAVAILABLE',
        },
      };
    }
  }

  private parseDocumentId(value: string): Hex {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new BadRequestException({
        error: 'INVALID_DOCUMENT_ID',
        message: 'documentId must be a 32-byte 0x-prefixed hex value',
      });
    }
    return value.toLowerCase() as Hex;
  }

  private timestamp(value: bigint): string {
    return new Date(Number(value) * 1_000).toISOString();
  }

  private async pinataRequest(
    pathOrUrl: string | URL,
    init: RequestInit = {},
  ): Promise<unknown> {
    const url =
      pathOrUrl instanceof URL
        ? pathOrUrl
        : new URL(pathOrUrl, `${this.runtime.pinata.apiUrl}/`);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.runtime.pinata.jwt}`,
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.runtime.blockchain.requestTimeoutMs),
      });
    } catch {
      throw new ServiceUnavailableException({
        error: 'STORAGE_UNAVAILABLE',
        message: 'Pinata metadata API is unavailable',
      });
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new HttpException(
        {
          error: 'STORAGE_METADATA_REQUEST_FAILED',
          message: `Pinata metadata API returned HTTP ${response.status}`,
        },
        response.status,
      );
    }
    try {
      return await readBoundedJsonResponse(
        response,
        PINATA_JSON_RESPONSE_MAX_BYTES,
      );
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new ServiceUnavailableException({
          error: 'STORAGE_METADATA_RESPONSE_TOO_LARGE',
          message: 'Pinata metadata response exceeded the JSON response limit',
        });
      }
      throw new ServiceUnavailableException({
        error:
          error instanceof InvalidJsonResponseError
            ? 'STORAGE_METADATA_RESPONSE_INVALID'
            : 'STORAGE_METADATA_RESPONSE_FAILED',
        message: 'Pinata metadata response could not be parsed',
      });
    }
  }
}
