import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import {
  HealthService,
  type LivenessReport,
  type ReadinessReport,
} from './health.service';
import { OperationalStatusService } from './operational-status.service';
import { OperationsAuthGuard } from './operations-auth.guard';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly operationalStatus: OperationalStatusService,
  ) {}

  @Get('live')
  live(): LivenessReport {
    return this.health.live();
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessReport> {
    const report = await this.health.ready();
    if (report.status !== 'ready') {
      response.status(503);
    }
    return report;
  }

  @Get('status')
  @UseGuards(OperationsAuthGuard)
  status() {
    return this.operationalStatus.status();
  }
}
