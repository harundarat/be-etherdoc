import {
  HttpException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from '../config/runtime-config';
import { ExternalRequestObserver } from '../observability/external-request-observer.service';
import {
  cancelResponseBody,
  InvalidJsonResponseError,
  PINATA_JSON_RESPONSE_MAX_BYTES,
  readBoundedJsonResponse,
  ResponseBodyTooLargeError,
} from './bounded-response';
import {
  parsePinataMetadataResponse,
  type PinataMetadataResponse,
} from './pinata-response';
import { StorageNetwork } from './storage-network';

@Injectable()
export class PinataMetadataService {
  private readonly runtime: RuntimeConfig;

  constructor(
    configService: ConfigService,
    @Optional() private readonly externalRequests?: ExternalRequestObserver,
  ) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  createGroup(
    network: StorageNetwork,
    groupName: string,
  ): Promise<PinataMetadataResponse> {
    return this.request(`/groups/${network}`, {
      body: JSON.stringify({ name: groupName }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  }

  listFiles(
    network: StorageNetwork,
    groupId?: string,
  ): Promise<PinataMetadataResponse> {
    const url = new URL(`${this.runtime.pinata.apiUrl}/files/${network}`);
    if (groupId) {
      url.searchParams.set('group', groupId);
    }
    return this.request(url);
  }

  listGroups(network: StorageNetwork): Promise<PinataMetadataResponse> {
    return this.request(`/groups/${network}`);
  }

  private async request(
    pathOrUrl: string | URL,
    init: RequestInit = {},
  ): Promise<PinataMetadataResponse> {
    const url =
      pathOrUrl instanceof URL
        ? pathOrUrl
        : new URL(pathOrUrl, `${this.runtime.pinata.apiUrl}/`);
    let response: Response;
    try {
      response = await this.observedFetch('metadata', url, {
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
      return parsePinataMetadataResponse(
        await readBoundedJsonResponse(response, PINATA_JSON_RESPONSE_MAX_BYTES),
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

  private observedFetch(
    operation: string,
    input: string | URL,
    init: RequestInit,
  ): Promise<Response> {
    return this.externalRequests
      ? this.externalRequests.fetch('pinata', operation, input.toString(), init)
      : fetch(input, init);
  }
}
