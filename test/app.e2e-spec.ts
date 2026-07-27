import {
  type ExecutionContext,
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { DocumentIntentsService } from '../src/documents/document-intents.service';
import { PDF_UPLOAD_MAX_BYTES } from '../src/documents/document-upload.config';
import { DocumentsController } from '../src/documents/documents.controller';
import { DocumentsService } from '../src/documents/documents.service';

const documentId = `0x${'11'.repeat(32)}`;
const issuer = '0x0000000000000000000000000000000000000001';

function pdf(byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength);
  bytes.write('%PDF-1.7\n');
  bytes.write('\n%%EOF', byteLength - 6);
  return bytes;
}

describe('Documents API (e2e)', () => {
  let app: INestApplication<App>;
  const documents = {
    createGroup: jest.fn(),
    getDocument: jest.fn(),
    getListFiles: jest.fn(),
    getListGroups: jest.fn(),
    search: jest.fn(),
  };
  const intents = {
    getIntent: jest.fn(),
    prepareRegister: jest.fn(),
    prepareRevoke: jest.fn(),
    prepareSupersede: jest.fn(),
    submitSignature: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [
        { provide: DocumentsService, useValue: documents },
        { provide: DocumentIntentsService, useValue: intents },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext): boolean {
          const requestContext = context.switchToHttp().getRequest<{
            user?: { address: string };
          }>();
          requestContext.user = { address: issuer };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    documents.getDocument.mockResolvedValue({
      canonicalSource: true,
      document: { documentId },
    });
    documents.getListGroups.mockResolvedValue({ data: { groups: [] } });
    documents.search.mockResolvedValue({
      canonicalSource: true,
      document: { documentId },
    });
  });

  it('resolves static groups before the dynamic document route', async () => {
    await request(app.getHttpServer())
      .get('/documents/groups?network=public')
      .expect(200)
      .expect({ data: { groups: [] } });

    expect(documents.getListGroups).toHaveBeenCalledWith('public');
    expect(documents.getDocument).not.toHaveBeenCalled();
  });

  it('gets the canonical document by bytes32 identity', async () => {
    await request(app.getHttpServer())
      .get(`/documents/${documentId}`)
      .expect(200)
      .expect({
        canonicalSource: true,
        document: { documentId },
      });

    expect(documents.getDocument).toHaveBeenCalledWith(documentId);
  });

  it('rejects an invalid intent UUID before querying the intent service', async () => {
    await request(app.getHttpServer())
      .get('/documents/intents/not-a-uuid')
      .expect(400);

    expect(intents.getIntent).not.toHaveBeenCalled();
  });

  it('bounds Pinata group names and identifiers', async () => {
    await request(app.getHttpServer())
      .post('/documents/groups')
      .send({ groupName: 'x'.repeat(129), network: 'private' })
      .expect(400);
    await request(app.getHttpServer())
      .get(`/documents?network=private&groupId=${'x'.repeat(129)}`)
      .expect(400);

    expect(documents.createGroup).not.toHaveBeenCalled();
    expect(documents.getListFiles).not.toHaveBeenCalled();
  });

  it('searches by explicit document identity', async () => {
    await request(app.getHttpServer())
      .post('/documents/search')
      .send({ documentId })
      .expect(201);

    expect(documents.search).toHaveBeenCalledWith({ documentId }, undefined);
  });

  it('rejects search without either supported identity form', async () => {
    await request(app.getHttpServer())
      .post('/documents/search')
      .send({})
      .expect(400);

    expect(documents.search).not.toHaveBeenCalled();
  });

  it('accepts a PDF exactly at the 5 MiB upload limit', async () => {
    intents.prepareRegister.mockResolvedValue({ status: 'PREPARED' });

    await request(app.getHttpServer())
      .post('/documents/intents/register')
      .field('issuer', issuer)
      .field('idempotencyKey', 'register-exact-limit')
      .field('storageNetwork', 'private')
      .attach('file', pdf(PDF_UPLOAD_MAX_BYTES), {
        contentType: 'application/pdf',
        filename: 'document.pdf',
      })
      .expect(201)
      .expect({ status: 'PREPARED' });

    expect(intents.prepareRegister).toHaveBeenCalledWith(
      issuer,
      expect.objectContaining({ size: PDF_UPLOAD_MAX_BYTES }),
      expect.objectContaining({ idempotencyKey: 'register-exact-limit' }),
    );
  });

  it('rejects an oversized upload before the intent service receives it', async () => {
    await request(app.getHttpServer())
      .post('/documents/intents/register')
      .field('issuer', issuer)
      .field('idempotencyKey', 'register-over-limit')
      .field('storageNetwork', 'private')
      .attach('file', pdf(PDF_UPLOAD_MAX_BYTES + 1), {
        contentType: 'application/pdf',
        filename: 'document.pdf',
      })
      .expect(413)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          error: 'Payload Too Large',
          message: 'File too large',
          statusCode: 413,
        });
      });

    expect(intents.prepareRegister).not.toHaveBeenCalled();
  });

  it('rejects multipart requests with too many fields or parts', async () => {
    let upload = request(app.getHttpServer()).post('/documents/search');
    for (let index = 0; index < 9; index += 1) {
      upload = upload.field(`field${index}`, 'value');
    }

    await upload.expect(400);

    expect(documents.search).not.toHaveBeenCalled();
  });

  it('rejects content that claims to be a PDF without PDF magic bytes', async () => {
    await request(app.getHttpServer())
      .post('/documents/search')
      .field('issuer', issuer)
      .attach('file', Buffer.from('not a PDF'), {
        contentType: 'application/pdf',
        filename: 'document.pdf',
      })
      .expect(422);

    expect(documents.search).not.toHaveBeenCalled();
  });
});
