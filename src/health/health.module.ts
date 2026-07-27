import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { OperationalStatusService } from './operational-status.service';
import { OperationsAuthGuard } from './operations-auth.guard';

@Module({
  controllers: [HealthController],
  providers: [HealthService, OperationalStatusService, OperationsAuthGuard],
})
export class HealthModule {}
