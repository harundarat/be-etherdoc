import { Global, Module } from '@nestjs/common';
import { PinataStorageService } from './pinata-storage.service';

@Global()
@Module({
  exports: [PinataStorageService],
  providers: [PinataStorageService],
})
export class StorageModule {}
