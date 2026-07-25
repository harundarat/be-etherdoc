import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { DocumentIntentsService } from './document-intents.service';

@Module({
  controllers: [DocumentsController],
  providers: [DocumentIntentsService, DocumentsService],
})
export class DocumentsModule {}
