import { Module } from '@nestjs/common';
import { DestinationWorker } from './destination.worker';
import { DispatchWorker } from './dispatch.worker';
import { OutboxWorkerService } from './outbox-worker.service';
import { ReconciliationWorker } from './reconciliation.worker';
import { SourceTransactionWorker } from './source-transaction.worker';

@Module({
  providers: [
    DestinationWorker,
    DispatchWorker,
    OutboxWorkerService,
    ReconciliationWorker,
    SourceTransactionWorker,
  ],
})
export class WorkersModule {}
