import { IsEnum, IsString } from 'class-validator';

enum Network {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

export class CreateGroupDto {
  @IsEnum(Network, { message: 'Network must be either public or private' })
  network: string;

  @IsString()
  groupName: string;
}
