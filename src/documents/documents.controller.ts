import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { CreateGroupDto, GetListFilesDto, GetListGroupsDto } from './dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async getListFiles(@Query() getListFilesDto: GetListFilesDto) {
    return await this.documentsService.getListFiles(getListFilesDto.network);
  }

  @UseGuards(JwtAuthGuard)
  @Get('/groups')
  async getListGroups(@Query() getListGroupsDto: GetListGroupsDto) {
    return await this.documentsService.getListGroups(getListGroupsDto.network);
  }

  @UseGuards(JwtAuthGuard)
  @Post('/groups')
  async createGroup(@Body() createGroupDto: CreateGroupDto) {
    return await this.documentsService.createGroup(
      createGroupDto.network,
      createGroupDto.groupName,
    );
  }
}
