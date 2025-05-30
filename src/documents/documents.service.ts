import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadFileDto, UploadFileResponseDto } from './dto';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(private configService: ConfigService) {}

  async uploadDocument(
    file: Express.Multer.File,
    uploadFileDto: UploadFileDto,
  ): Promise<UploadFileResponseDto> {
    // Check if file exists
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const pinataUploadUrl =
      this.configService.getOrThrow<string>('PINATA_UPLOAD_URL');
    const pinataJwtToken =
      this.configService.getOrThrow<string>('PINATA_JWT_TOKEN');

    try {
      // Create form
      const formData = new FormData();

      // Add file as Blob
      const blob = new Blob([file.buffer], { type: file.mimetype });
      formData.append('file', blob, file.originalname);

      // Add network
      formData.append('network', uploadFileDto.network);

      // Add optional fields
      if (uploadFileDto.name) {
        formData.append('name', uploadFileDto.name);
      }
      if (uploadFileDto.group_id) {
        formData.append('group_id', uploadFileDto.group_id);
      }
      if (uploadFileDto.keyvalues) {
        formData.append('keyvalues', JSON.stringify(uploadFileDto.keyvalues));
      }

      // Upload the document
      const response = await fetch(pinataUploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pinataJwtToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Pinata upload error: ${response.status} - ${errorText}`,
        );
        throw new HttpException(
          'Error uploading file to Pinata',
          response.status,
        );
      }

      const data = response.json();
      return data;
    } catch (error) {
      this.logger.error('Failed to upload file', error.stack);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException(
        'Could not upload file due to an unexpected error.',
      );
    }
  }

  async createGroup(network: string, groupName: string) {
    const pinataApiUrl =
      this.configService.getOrThrow<string>('PINATA_API_URL');
    const pinataJwtToken =
      this.configService.getOrThrow<string>('PINATA_JWT_TOKEN');

    try {
      const options = {
        method: 'POST',
        headers: { Authorization: `Bearer ${pinataJwtToken}` },
        'Content-Type': 'application/json',
        body: `{"name":"${groupName}"}`,
      };

      const rawResponse = await fetch(
        `${pinataApiUrl}/groups/${network}`,
        options,
      );

      if (!rawResponse.ok) {
        this.logger.error(`Pinata API error: ${rawResponse.status}`);
        throw new HttpException(
          'Error create a new group to pinata',
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
        'Could not create a new group due to an unexpected error.',
      );
    }
  }

  async getListFiles(network: string, groupId?: string) {
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

      const baseUrl = `${pinataApiUrl}/files/${network}`;
      const url = new URL(baseUrl);

      if (groupId) {
        url.searchParams.append('group', groupId);
      }

      const rawResponse = await fetch(url.toString(), options);

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
