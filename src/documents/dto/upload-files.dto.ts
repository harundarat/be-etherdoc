import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

enum Network {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

export class UploadFileDto {
  @IsEnum(Network, { message: 'Network must be either public or private' })
  network: Network;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  group_id?: string;

  @IsOptional()
  @IsObject()
  @Transform(({ value }): Record<string, string> => {
    if (typeof value === 'string') {
      return JSON.parse(value);
    }
    return value;
  })
  keyvalues?: Record<string, string>;
}
