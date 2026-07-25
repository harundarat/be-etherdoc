import { IsEthereumAddress, IsOptional, Matches } from 'class-validator';

export class SearchDocumentDto {
  @IsOptional()
  @Matches(/^0x[0-9a-fA-F]{64}$/)
  documentId?: string;

  @IsOptional()
  @IsEthereumAddress()
  issuer?: string;
}
