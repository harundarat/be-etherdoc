import {
  Body,
  BadRequestException,
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
  PDF_UPLOAD_MAX_BYTES,
  PDF_UPLOAD_MULTER_OPTIONS,
  PdfMagicBytesValidator,
} from './document-upload.config';
import {
  CreateGroupDto,
  GetListFilesDto,
  GetListGroupsDto,
  RegisterIntentDto,
  RevokeIntentDto,
  SearchDocumentDto,
  SubmitIntentSignatureDto,
  SupersedeIntentDto,
} from './dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

const filePipe = () =>
  new ParseFilePipeBuilder()
    .addValidator(new PdfMagicBytesValidator())
    // MaxFileSizeValidator uses an exclusive comparison. Adding one keeps the
    // public 5 MiB limit inclusive while Multer enforces it before buffering.
    .addMaxSizeValidator({ maxSize: PDF_UPLOAD_MAX_BYTES + 1 })
    .build({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY });

const optionalFilePipe = () =>
  new ParseFilePipeBuilder()
    .addValidator(new PdfMagicBytesValidator())
    .addMaxSizeValidator({ maxSize: PDF_UPLOAD_MAX_BYTES + 1 })
    .build({
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      fileIsRequired: false,
    });

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly intentsService: DocumentIntentsService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('intents/register')
  @UseInterceptors(FileInterceptor('file', PDF_UPLOAD_MULTER_OPTIONS))
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
  @UseInterceptors(FileInterceptor('file', PDF_UPLOAD_MULTER_OPTIONS))
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

  @Post('search')
  @UseInterceptors(FileInterceptor('file', PDF_UPLOAD_MULTER_OPTIONS))
  search(
    @UploadedFile(optionalFilePipe()) file: Express.Multer.File | undefined,
    @Body() body: SearchDocumentDto,
  ) {
    if (!file && !body.documentId) {
      throw new BadRequestException(
        'Provide an explicit documentId or a PDF file with issuer',
      );
    }
    return this.documentsService.search(body, file);
  }

  @Get(':documentId')
  getDocument(@Param('documentId') documentId: string) {
    return this.documentsService.getDocument(documentId);
  }
}
