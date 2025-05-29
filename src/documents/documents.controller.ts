import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { GetListFilesDto } from './dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async getListFiles(@Query() getListFilesDto: GetListFilesDto) {
    return await this.documentsService.getListFiles(getListFilesDto.network);
  }
}
