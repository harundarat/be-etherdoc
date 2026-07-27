import { IsEnum } from 'class-validator';
import { StorageNetwork } from '../../storage/storage-network';

export class GetListGroupsDto {
  @IsEnum(StorageNetwork, {
    message: 'Network must be either public or private',
  })
  network!: StorageNetwork;
}
