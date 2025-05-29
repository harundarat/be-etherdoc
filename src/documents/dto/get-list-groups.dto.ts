import { IsEnum } from 'class-validator';

enum Network {
  PUBLIC = 'public',
  PRIVATE = 'private',
}
export class GetListGroupsDto {
  @IsEnum(Network, { message: 'Network must be either public or private' })
  network: string;
}
