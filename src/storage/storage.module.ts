import { Global, Module } from '@nestjs/common';
import { PinataStorageService } from './pinata-storage.service';
import { PinataMetadataService } from './pinata-metadata.service';

@Global()
@Module({
  exports: [PinataMetadataService, PinataStorageService],
  providers: [PinataMetadataService, PinataStorageService],
})
export class StorageModule {}
