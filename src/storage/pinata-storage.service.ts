import {
  Injectable,
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

interface PinataUploadResponse {
  data?: {
    cid?: string;
    id?: string;
  };
}

export interface VerifiedPinnedArtifact extends ParsedCanonicalCid {
  contentDigest: Hex;
  providerId: string | null;
  retrievedBytes: number;
}

@Injectable()
export class PinataStorageService {
  private readonly runtime: RuntimeConfig;

  constructor(configService: ConfigService) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  async pinAndVerify(
    file: Express.Multer.File,
    storageNetwork: 'private' | 'public',
    metadata: CanonicalMetadata,
  ): Promise<VerifiedPinnedArtifact> {
    const contentDigest = sha256Digest(file.buffer);
    const form = new FormData();
    form.append(
      'file',
      new Blob([file.buffer], { type: file.mimetype }),
      file.originalname,
    );
    form.append('network', storageNetwork);
    form.append('keyvalues', metadata.json);

    let response: Response;
    try {
      response = await fetch(this.runtime.pinata.uploadUrl, {
        body: form,
        headers: { Authorization: `Bearer ${this.runtime.pinata.jwt}` },
        method: 'POST',
        signal: AbortSignal.timeout(
          this.runtime.blockchain.requestTimeoutMs,
        ),
      });
    } catch (error) {
      throw new ServiceUnavailableException({
        error: 'STORAGE_UNAVAILABLE',
        message: 'Pinata upload request failed',
      });
    }
    if (!response.ok) {
      throw new ServiceUnavailableException({
        error: 'STORAGE_UPLOAD_FAILED',
        message: `Pinata upload failed with HTTP ${response.status}`,
      });
    }

    const upload = (await response.json()) as PinataUploadResponse;
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

    const retrievalUrl =
      `${this.runtime.pinata.gatewayUrl}/ipfs/${encodeURIComponent(actualCid)}`;
    let retrieval: Response;
    try {
      retrieval = await fetch(retrievalUrl, {
        headers: { Authorization: `Bearer ${this.runtime.pinata.jwt}` },
        signal: AbortSignal.timeout(
          this.runtime.blockchain.requestTimeoutMs,
        ),
      });
    } catch {
      throw new ServiceUnavailableException({
        error: 'STORAGE_RETRIEVAL_FAILED',
        message: 'Pinned bytes could not be retrieved for verification',
      });
    }
    if (!retrieval.ok) {
      throw new ServiceUnavailableException({
        error: 'STORAGE_RETRIEVAL_FAILED',
        message: `Pinned bytes returned HTTP ${retrieval.status}`,
      });
    }
    const retrievedBytes = new Uint8Array(await retrieval.arrayBuffer());
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
    };
  }
}
