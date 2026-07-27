import { Module } from '@nestjs/common';
import { DocumentsModule } from './documents/documents.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { loadRuntimeConfiguration } from './config/runtime-config';
import { BlockchainModule } from './blockchain/blockchain.module';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { WorkersModule } from './workers/workers.module';
import { HttpSecurityModule } from './http/http-security.module';
import { ObservabilityModule } from './observability/observability.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadRuntimeConfiguration],
    }),
    ObservabilityModule,
    HttpSecurityModule,
    HealthModule,
    BlockchainModule,
    DatabaseModule,
    StorageModule,
    WorkersModule,
    DocumentsModule,
    AuthModule,
  ],
})
export class AppModule {}
