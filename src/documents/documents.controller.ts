import { Controller, Get, Query } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { GetListFilesDto } from './dto';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  async getListFiles(@Query() getListFilesDto: GetListFilesDto) {
    return await this.documentsService.getListFiles(getListFilesDto.network);
  }
}
