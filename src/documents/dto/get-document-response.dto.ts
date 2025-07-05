import { IsString, IsNumber, IsBoolean, IsObject, IsOptional, IsDateString } from 'class-validator';

/**
 * Response DTO for getting document by CID
 * Contains document metadata and blockchain existence status
 */
export class GetDocumentResponseDto {
  /** Unique identifier of the document */
  @IsString()
  id: string;

  /** Name of the document */
  @IsString()
  name: string;

  /** Content Identifier (CID) on IPFS */
  @IsString()
  cid: string;

  /** File size in bytes */
  @IsNumber()
  size: number;

  /** Number of files (always 1 for single file uploads) */
  @IsNumber()
  number_of_files: number;

  /** MIME type of the file */
  @IsString()
  mime_type: string;

  /** Group ID if the document belongs to a group, null otherwise */
  @IsOptional()
  @IsString()
  group_id: string | null;

  /** Key-value pairs for metadata */
  @IsObject()
  keyvalues: Record<string, any>;

  /** ISO timestamp of when the document was created */
  @IsDateString()
  created_at: string;

  /** Whether the document exists on the Ethereum (Holesky) network */
  @IsBoolean()
  isExistEthereum: boolean;

  /** Whether the document exists on the Base Sepolia network */
  @IsBoolean()
  isExistBase: boolean;
}