import { IsEnum, IsString, Matches, MaxLength } from 'class-validator';
import { StorageNetwork } from '../../storage/storage-network';

export class CreateGroupDto {
  @IsEnum(StorageNetwork, {
    message: 'Network must be either public or private',
  })
  network: StorageNetwork;

  @IsString()
  @MaxLength(128)
  @Matches(/\S/, { message: 'groupName must contain a non-space character' })
  groupName: string;
}
