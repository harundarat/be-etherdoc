import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseFilePipeBuilder,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { DocumentsService } from './documents.service';
import {
  CreateGroupDto,
  GetListFilesDto,
  GetListGroupsDto,
  UploadFileDto,
} from './dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('/search')
  @UseInterceptors(FileInterceptor('file'))
  async getDocumentByFile(
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addFileTypeValidator({ fileType: 'application/pdf' })
        .addMaxSizeValidator({ maxSize: 5 * 1024 * 1024 })
        .build({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY }),
    )
    file: Express.Multer.File,
  ) {
    return await this.documentsService.getDocumentByFile(file);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addFileTypeValidator({
          fileType: 'application/pdf',
        })
        .addMaxSizeValidator({ maxSize: 5 * 1024 * 1024 })
        .build({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY }),
    )
    file: Express.Multer.File,
    @Body() uploadFileDto: UploadFileDto,
  ) {
    return await this.documentsService.uploadDocument(file, uploadFileDto);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async getListFiles(@Query() getListFilesDto: GetListFilesDto) {
    return await this.documentsService.getListFiles(
      getListFilesDto.network,
      getListFilesDto.groupId,
    );
  }

  @Get('/:id')
  async getDocumentById(
    @Param('id') id: string,
    @Query('network') network: 'public' | 'private',
  ) {
    return this.documentsService.getDocumentById(network, id);
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
