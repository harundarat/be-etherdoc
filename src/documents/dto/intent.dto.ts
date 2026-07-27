import {
  IsEthereumAddress,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { StorageNetwork } from '../../storage/storage-network';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;

export class BaseIntentDto {
  @IsEthereumAddress()
  issuer!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;
}

export class RegisterIntentDto extends BaseIntentDto {
  @IsIn(Object.values(StorageNetwork))
  storageNetwork!: StorageNetwork;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{0,63}$/i)
  documentType?: string;
}

export class RevokeIntentDto extends BaseIntentDto {
  @Matches(bytes32Pattern)
  documentId!: string;
}

export class SupersedeIntentDto extends RegisterIntentDto {
  @Matches(bytes32Pattern)
  oldDocumentId!: string;
}

export class SubmitIntentSignatureDto {
  @IsString()
  @Matches(/^0x[0-9a-fA-F]+$/)
  @MaxLength(132_000)
  signature!: string;
}
