import {
  Body,
  Controller,
  Get,
  type INestApplication,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import * as request from 'supertest';
import type { App } from 'supertest/types';
import type { RuntimeConfig } from '../src/config/runtime-config';
import { configureHttpApplication } from '../src/http/configure-http';
import { HttpSecurityModule } from '../src/http/http-security.module';

const allowedOrigin = 'https://app.etherdoc.example';
const wallet = '0x0000000000000000000000000000000000000001';

@Controller('auth')
class TestAuthController {
  @Post('nonce')
  nonce(@Body() body: unknown) {
    return body;
  }
}

@Controller('documents')
class TestDocumentsController {
  @Get('client-ip')
  clientIp(@Req() requestContext: Request) {
    return { ip: requestContext.ip };
  }

  @Post('mutate')
  mutate() {
    return { accepted: true };
  }

  @Post('search')
  search() {
    return { found: false };
  }
}

function runtime(): RuntimeConfig {
  return {
    corsOrigin: allowedOrigin,
    http: {
      cookieSecure: true,
      replicaCount: 1,
      trustProxyHops: 0,
    },
    rateLimit: {
      apiLimit: 100,
      authLimit: 5,
      searchLimit: 30,
      uploadLimit: 8,
      windowMs: 60_000,
    },
  } as RuntimeConfig;
}

describe('HTTP security (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          load: [() => ({ runtime: runtime() })],
        }),
        HttpSecurityModule,
      ],
      controllers: [TestAuthController, TestDocumentsController],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureHttpApplication(
      app as unknown as NestExpressApplication,
      runtime(),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets security headers, restricts CORS, and ignores forwarded IPs by default', async () => {
    const response = await request(app.getHttpServer())
      .get('/documents/client-ip')
      .set('Origin', allowedOrigin)
      .set('X-Forwarded-For', '203.0.113.10')
      .expect(200);

    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.body).not.toMatchObject({ ip: '203.0.113.10' });

    const rejectedOrigin = await request(app.getHttpServer())
      .options('/documents/search')
      .set('Origin', 'https://attacker.example')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(rejectedOrigin.headers['access-control-allow-origin']).toBe(
      allowedOrigin,
    );
    expect(rejectedOrigin.headers['access-control-allow-origin']).not.toBe(
      'https://attacker.example',
    );
  });

  it('returns a stable 429 after the strict authentication limit', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer())
        .post('/auth/nonce')
        .send({ address: wallet })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post('/auth/nonce')
      .send({ address: wallet })
      .expect(429)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          message: 'RATE_LIMIT_EXCEEDED',
          statusCode: 429,
        });
      });
  });

  it('applies the separate multipart upload limit', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await request(app.getHttpServer())
        .post('/documents/search')
        .field('issuer', wallet)
        .expect(201);
    }

    await request(app.getHttpServer())
      .post('/documents/search')
      .field('issuer', wallet)
      .expect(429)
      .expect(({ body }) => {
        expect(body).toMatchObject({ message: 'RATE_LIMIT_EXCEEDED' });
      });
  });

  it('requires the configured Origin for cookie mutations but exempts bearer requests', async () => {
    await request(app.getHttpServer())
      .post('/documents/mutate')
      .set('Cookie', 'etherdoc-auth=cookie.jwt')
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ error: 'CSRF_ORIGIN_REJECTED' });
      });

    await request(app.getHttpServer())
      .post('/documents/mutate')
      .set('Cookie', 'etherdoc-auth=cookie.jwt')
      .set('Origin', allowedOrigin)
      .expect(201);

    await request(app.getHttpServer())
      .post('/documents/mutate')
      .set('Authorization', 'Bearer explicit.jwt')
      .set('Cookie', 'etherdoc-auth=cookie.jwt')
      .expect(201);
  });
});
