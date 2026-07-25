import { IsString, Matches, MaxLength } from 'class-validator';

export class VerifyAuthDto {
  @IsString()
  @MaxLength(4096)
  message: string;

  @IsString()
  @Matches(/^0x[0-9a-fA-F]+$/)
  @MaxLength(132_000)
  signature: string;
}
