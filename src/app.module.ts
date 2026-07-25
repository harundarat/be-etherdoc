import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DocumentsModule } from './documents/documents.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { loadRuntimeConfiguration } from './config/runtime-config';
import { BlockchainModule } from './blockchain/blockchain.module';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadRuntimeConfiguration],
    }),
    BlockchainModule,
    DatabaseModule,
    StorageModule,
    DocumentsModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
