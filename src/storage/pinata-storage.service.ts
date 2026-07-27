import {
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Hex } from 'viem';
import type { RuntimeConfig } from '../config/runtime-config';
import {
  parseCanonicalCid,
  sha256Digest,
  type CanonicalMetadata,
  type ParsedCanonicalCid,
} from '../documents/canonical-document';
import {
  cancelResponseBody,
  InvalidJsonResponseError,
  PINATA_JSON_RESPONSE_MAX_BYTES,
  PINATA_RETRIEVAL_MAX_BYTES,
  readBoundedJsonResponse,
  readBoundedResponseBody,
  ResponseBodyTooLargeError,
} from './bounded-response';
import { StorageNetwork } from './storage-network';
import { ExternalRequestObserver } from '../observability/external-request-observer.service';
import { parsePinataUploadResponse } from './pinata-response';

export interface VerifiedPinnedArtifact extends ParsedCanonicalCid {
  contentDigest: Hex;
  providerId: string | null;
  retrievedBytes: number;
  storageFilename: string;
}

export interface StorageAvailability {
  available: boolean;
  checkedAt: string;
  status: 'AVAILABLE' | 'NOT_FOUND' | 'UNAVAILABLE';
}

@Injectable()
export class PinataStorageService {
  private readonly runtime: RuntimeConfig;

  constructor(
    configService: ConfigService,
    @Optional() private readonly externalRequests?: ExternalRequestObserver,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  async pinAndVerify(
    file: Express.Multer.File,
    storageNetwork: StorageNetwork,
    metadata: CanonicalMetadata,
  ): Promise<VerifiedPinnedArtifact> {
    const contentDigest = sha256Digest(file.buffer);
    const storageFilename =
      file.mimetype === 'application/pdf' ? 'document.pdf' : 'document.bin';
    const form = new FormData();
    form.append(
      'file',
      new Blob([Uint8Array.from(file.buffer)], { type: file.mimetype }),
      storageFilename,
    );
    form.append('network', storageNetwork);
    form.append('keyvalues', metadata.json);

    let response: Response;
    try {
      response = await this.observedFetch(
        'upload',
        this.runtime.pinata.uploadUrl,
        {
          body: form,
          headers: { Authorization: `Bearer ${this.runtime.pinata.jwt}` },
          method: 'POST',
          signal: AbortSignal.timeout(this.runtime.blockchain.requestTimeoutMs),
        },
      );
    } catch {
      throw new ServiceUnavailableException({
        error: 'STORAGE_UNAVAILABLE',
        message: 'Pinata upload request failed',
      });
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new ServiceUnavailableException({
        error: 'STORAGE_UPLOAD_FAILED',
        message: `Pinata upload failed with HTTP ${response.status}`,
      });
    }

    let upload;
    try {
      upload = parsePinataUploadResponse(
        await readBoundedJsonResponse(response, PINATA_JSON_RESPONSE_MAX_BYTES),
      );
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new ServiceUnavailableException({
          error: 'STORAGE_UPLOAD_RESPONSE_TOO_LARGE',
          message: 'Pinata upload response exceeded the JSON response limit',
        });
      }
      throw new ServiceUnavailableException({
        error:
          error instanceof InvalidJsonResponseError
            ? 'STORAGE_UPLOAD_RESPONSE_INVALID'
            : 'STORAGE_UPLOAD_RESPONSE_FAILED',
        message: 'Pinata upload response could not be parsed',
      });
    }
    const actualCid = upload.data?.cid;
    if (!actualCid) {
      throw new UnprocessableEntityException({
        error: 'STORAGE_CID_MISSING',
        message: 'Pinata did not return a CID',
      });
    }
    let parsedCid: ParsedCanonicalCid;
    try {
      parsedCid = parseCanonicalCid(actualCid, contentDigest);
    } catch (error) {
      throw new UnprocessableEntityException({
        error: 'STORAGE_CID_INVALID',
        message: error instanceof Error ? error.message : 'Invalid CID',
      });
    }

    const retrievalUrl = `${this.runtime.pinata.gatewayUrl}/ipfs/${encodeURIComponent(actualCid)}`;
    let retrieval: Response;
    try {
      retrieval = await this.observedFetch('retrieval', retrievalUrl, {
        headers: { Authorization: `Bearer ${this.runtime.pinata.jwt}` },
        signal: AbortSignal.timeout(this.runtime.blockchain.requestTimeoutMs),
      });
    } catch {
      throw new ServiceUnavailableException({
        error: 'STORAGE_RETRIEVAL_FAILED',
        message: 'Pinned bytes could not be retrieved for verification',
      });
    }
    if (!retrieval.ok) {
      await cancelResponseBody(retrieval);
      throw new ServiceUnavailableException({
        error: 'STORAGE_RETRIEVAL_FAILED',
        message: `Pinned bytes returned HTTP ${retrieval.status}`,
      });
    }
    let retrievedBytes: Uint8Array;
    try {
      retrievedBytes = await readBoundedResponseBody(
        retrieval,
        PINATA_RETRIEVAL_MAX_BYTES,
      );
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new ServiceUnavailableException({
          error: 'STORAGE_RETRIEVAL_TOO_LARGE',
          message: 'Retrieved Pinata bytes exceeded the verification limit',
        });
      }
      throw new ServiceUnavailableException({
        error: 'STORAGE_RETRIEVAL_FAILED',
        message: 'Pinned bytes could not be read for verification',
      });
    }
    const retrievedDigest = sha256Digest(retrievedBytes);
    if (retrievedDigest !== contentDigest) {
      throw new UnprocessableEntityException({
        error: 'STORAGE_DIGEST_MISMATCH',
        message: 'Retrieved Pinata bytes do not match the uploaded file',
      });
    }

    return {
      ...parsedCid,
      contentDigest,
      providerId: upload.data?.id ?? null,
      retrievedBytes: retrievedBytes.byteLength,
      storageFilename,
    };
  }

  async checkAvailability(cid: string): Promise<StorageAvailability> {
    const checkedAt = new Date().toISOString();
    let response: Response;
    try {
      response = await this.observedFetch(
        'availability',
        `${this.runtime.pinata.gatewayUrl}/ipfs/${encodeURIComponent(cid)}`,
        {
          headers: { Authorization: `Bearer ${this.runtime.pinata.jwt}` },
          method: 'HEAD',
          signal: AbortSignal.timeout(this.runtime.blockchain.requestTimeoutMs),
        },
      );
    } catch {
      return { available: false, checkedAt, status: 'UNAVAILABLE' };
    }
    if (response.ok) {
      return { available: true, checkedAt, status: 'AVAILABLE' };
    }
    return {
      available: false,
      checkedAt,
      status: response.status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE',
    };
  }

  private observedFetch(
    operation: string,
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    return this.externalRequests
      ? this.externalRequests.fetch('pinata', operation, input, init)
      : fetch(input, init);
  }
}
