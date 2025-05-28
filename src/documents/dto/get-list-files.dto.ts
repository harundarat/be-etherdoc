import { IsEnum, IsString } from 'class-validator';

enum Network {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

export class GetListFilesDto {
  @IsString()
  @IsEnum(Network, { message: 'Network must be either public or private' })
  network: Network;
}
