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
import { DocumentsController } from '../src/documents/documents.controller';
import { DocumentsService } from '../src/documents/documents.service';

const documentId = `0x${'11'.repeat(32)}`;
const issuer = '0x0000000000000000000000000000000000000001';

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
});
