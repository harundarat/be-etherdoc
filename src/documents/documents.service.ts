import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from '../config/runtime-config';

@Injectable()
export class DocumentsService {
  private readonly runtime: RuntimeConfig;

  constructor(configService: ConfigService) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
  }

  createGroup(network: string, groupName: string): Promise<unknown> {
    return this.pinataRequest(`/groups/${network}`, {
      body: JSON.stringify({ name: groupName }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  }

  getListFiles(network: string, groupId?: string): Promise<unknown> {
    const url = new URL(`${this.runtime.pinata.apiUrl}/files/${network}`);
    if (groupId) {
      url.searchParams.set('group', groupId);
    }
    return this.pinataRequest(url);
  }

  getListGroups(network: string): Promise<unknown> {
    return this.pinataRequest(`/groups/${network}`);
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
      throw new HttpException(
        {
          error: 'STORAGE_METADATA_REQUEST_FAILED',
          message: `Pinata metadata API returned HTTP ${response.status}`,
        },
        response.status,
      );
    }
    return response.json() as Promise<unknown>;
  }
}
