import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseFilePipeBuilder,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Hex } from 'viem';
import { DocumentsService } from './documents.service';
import { DocumentIntentsService } from './document-intents.service';
import {
  CreateGroupDto,
  GetListFilesDto,
  GetListGroupsDto,
  RegisterIntentDto,
  RevokeIntentDto,
  SubmitIntentSignatureDto,
  SupersedeIntentDto,
} from './dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

const filePipe = () =>
  new ParseFilePipeBuilder()
    .addFileTypeValidator({ fileType: 'application/pdf' })
    .addMaxSizeValidator({ maxSize: 5 * 1024 * 1024 })
    .build({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY });

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly intentsService: DocumentIntentsService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('intents/register')
  @UseInterceptors(FileInterceptor('file'))
  prepareRegister(
    @Req() request: AuthenticatedRequest,
    @UploadedFile(filePipe()) file: Express.Multer.File,
    @Body() body: RegisterIntentDto,
  ) {
    return this.intentsService.prepareRegister(
      request.user.address,
      file,
      body,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('intents/revoke')
  prepareRevoke(
    @Req() request: AuthenticatedRequest,
    @Body() body: RevokeIntentDto,
  ) {
    return this.intentsService.prepareRevoke(request.user.address, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('intents/supersede')
  @UseInterceptors(FileInterceptor('file'))
  prepareSupersede(
    @Req() request: AuthenticatedRequest,
    @UploadedFile(filePipe()) file: Express.Multer.File,
    @Body() body: SupersedeIntentDto,
  ) {
    return this.intentsService.prepareSupersede(
      request.user.address,
      file,
      body,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('intents/:intentId/signature')
  @HttpCode(HttpStatus.ACCEPTED)
  submitSignature(
    @Req() request: AuthenticatedRequest,
    @Param('intentId') intentId: string,
    @Body() body: SubmitIntentSignatureDto,
  ) {
    return this.intentsService.submitSignature(
      request.user.address,
      intentId,
      body.signature as Hex,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('intents/:intentId')
  getIntent(
    @Req() request: AuthenticatedRequest,
    @Param('intentId') intentId: string,
  ) {
    return this.intentsService.getIntent(request.user.address, intentId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('groups')
  getListGroups(@Query() query: GetListGroupsDto) {
    return this.documentsService.getListGroups(query.network);
  }

  @UseGuards(JwtAuthGuard)
  @Post('groups')
  createGroup(@Body() body: CreateGroupDto) {
    return this.documentsService.createGroup(body.network, body.groupName);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  getListFiles(@Query() query: GetListFilesDto) {
    return this.documentsService.getListFiles(query.network, query.groupId);
  }
}
