import { Module } from '@nestjs/common';
import { DispatchWorker } from './dispatch.worker';
import { OutboxWorkerService } from './outbox-worker.service';
import { SourceTransactionWorker } from './source-transaction.worker';

@Module({
  providers: [DispatchWorker, OutboxWorkerService, SourceTransactionWorker],
})
export class WorkersModule {}
