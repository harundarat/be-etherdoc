import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DocumentsService {
  constructor(private configService: ConfigService) {}
  getDocuments(): string {
    return 'This is your document';
  }

  async getListFiles(network: string) {
    const options = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.configService.get<string>('PINATA_JWT_TOKEN')}`,
      },
    };

    const rawResponse = await fetch(
      `${this.configService.get<string>('PINATA_API_URL')}/files/${network}`,
      options,
    );

    const response = rawResponse.json();

    return response;
  }
}
