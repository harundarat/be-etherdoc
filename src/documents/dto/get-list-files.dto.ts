import { IsEnum, IsOptional, IsString } from 'class-validator';

enum Network {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

export class GetListFilesDto {
  @IsEnum(Network, { message: 'Network must be either public or private' })
  network: Network;

  @IsOptional()
  @IsString()
  groupId?: string;
}
