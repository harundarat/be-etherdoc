import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { StorageNetwork } from '../../storage/storage-network';

export class GetListFilesDto {
  @IsEnum(StorageNetwork, {
    message: 'Network must be either public or private',
  })
  network!: StorageNetwork;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  groupId?: string;
}
