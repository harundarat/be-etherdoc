import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(private configService: ConfigService) {}

  async getListFiles(network: string) {
    const pinataApiUrl = this.configService.get<string>('PINATA_API_URL');
    const pinataJwtToken = this.configService.get<string>('PINATA_JWT_TOKEN');

    if (!pinataApiUrl || !pinataJwtToken) {
      throw new InternalServerErrorException(
        'PINATA_API_URL or PINATA_JWT_TOKEN is not configured',
      );
    }

    try {
      const options = {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${pinataJwtToken}`,
        },
      };

      const rawResponse = await fetch(
        `${pinataApiUrl}/files/${network}`,
        options,
      );

      if (!rawResponse.ok) {
        this.logger.error(`Pinata API error: ${rawResponse.status}`);
        throw new HttpException(
          'Error fetching files from pinata',
          rawResponse.status,
        );
      }

      const response = rawResponse.json();

      return response;
    } catch (error) {
      this.logger.error(
        `Failed to get list of files for network ${network}: `,
        error.stack,
      );

      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException(
        'Could not retrieve file list due to an unexpected error.',
      );
    }
  }

  async getListGroups(network: string) {
    const pinataApiUrl =
      this.configService.getOrThrow<string>('PINATA_API_URL');
    const pinataJwtToken =
      this.configService.getOrThrow<string>('PINATA_JWT_TOKEN');

    try {
      const options = {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${pinataJwtToken}`,
        },
      };

      const rawResponse = await fetch(
        `${pinataApiUrl}/groups/${network}`,
        options,
      );

      if (!rawResponse.ok) {
        this.logger.error(`Pinata API error: ${rawResponse.status}`);
        throw new HttpException(
          'Error fetching groups from pinata',
          rawResponse.status,
        );
      }

      const response = rawResponse.json();

      return response;
    } catch (error) {
      this.logger.error(
        `Failed to get list of groups for network ${network}: `,
        error.stack,
      );

      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException(
        'Could not retrieve group list due to an unexpected error.',
      );
    }
  }
}
