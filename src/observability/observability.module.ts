import { Global, Module } from '@nestjs/common';
import { OperationalStateService } from './operational-state.service';

@Global()
@Module({
  exports: [OperationalStateService],
  providers: [OperationalStateService],
})
export class ObservabilityModule {}
