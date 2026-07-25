import { Global, Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';

@Global()
@Module({
  exports: [BlockchainService],
  providers: [BlockchainService],
})
export class BlockchainModule {}
