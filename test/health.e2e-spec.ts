import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import type { App } from 'supertest/types';
import type { RuntimeConfig } from '../src/config/runtime-config';
import { DatabaseService } from '../src/database/database.service';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';
import { OperationalStatusService } from '../src/health/operational-status.service';
import { OperationsAuthGuard } from '../src/health/operations-auth.guard';
import { OperationalStateService } from '../src/observability/operational-state.service';

interface TestContext {
  app: INestApplication;
  databaseReadiness: jest.Mock;
  state: OperationalStateService;
}

async function application(): Promise<TestContext> {
  const databaseReadiness = jest.fn().mockResolvedValue(true);
  const state = new OperationalStateService();
  const runtime = {
    health: { readinessCacheMs: 5_000 },
    operations: {
      token: 'an-operations-token-with-more-than-32-characters',
    },
  } as RuntimeConfig;
  const module = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      HealthService,
      OperationsAuthGuard,
      {
        provide: OperationalStatusService,
        useValue: {
          status: jest.fn().mockResolvedValue({ status: 'operational' }),
        },
      },
      { provide: ConfigService, useValue: new ConfigService({ runtime }) },
      {
        provide: DatabaseService,
        useValue: { readiness: databaseReadiness },
      },
      { provide: OperationalStateService, useValue: state },
    ],
  }).compile();
  const app = module.createNestApplication();
  await app.init();
  return { app, databaseReadiness, state };
}

function server(app: INestApplication): App {
  return app.getHttpServer() as App;
}

describe('Health API (e2e)', () => {
  const applications: INestApplication[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it('reports liveness without calling external dependencies', async () => {
    const context = await application();
    applications.push(context.app);

    await request(server(context.app))
      .get('/health/live')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ status: 'live' });
        expect(body).toHaveProperty('checkedAt');
      });

    expect(context.databaseReadiness).not.toHaveBeenCalled();
  });

  it('reports ready after startup checks and caches the schema probe', async () => {
    const context = await application();
    applications.push(context.app);
    context.state.markBlockchainReady();

    await request(server(context.app))
      .get('/health/ready')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          checks: {
            blockchainStartup: 'ready',
            database: 'ready',
            schema: 'ready',
          },
          status: 'ready',
        });
      });
    await request(server(context.app)).get('/health/ready').expect(200);

    expect(context.databaseReadiness).toHaveBeenCalledTimes(1);
  });

  it('reports degraded when a dependency probe fails', async () => {
    const context = await application();
    applications.push(context.app);
    context.state.markBlockchainReady();
    context.databaseReadiness.mockRejectedValue(new Error('database secret'));

    await request(server(context.app))
      .get('/health/ready')
      .expect(503)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          checks: {
            blockchainStartup: 'ready',
            database: 'unavailable',
            schema: 'unknown',
          },
          status: 'degraded',
        });
        expect(JSON.stringify(body)).not.toContain('database secret');
      });
  });

  it('reports shutting down without starting a new dependency probe', async () => {
    const context = await application();
    applications.push(context.app);
    context.state.markBlockchainReady();
    context.state.beforeApplicationShutdown('SIGTERM');

    await request(server(context.app))
      .get('/health/ready')
      .expect(503)
      .expect(({ body }) => {
        expect(body).toMatchObject({ status: 'shutting_down' });
      });

    expect(context.databaseReadiness).not.toHaveBeenCalled();
  });

  it('protects detailed operational status with a separate bearer token', async () => {
    const context = await application();
    applications.push(context.app);

    await request(server(context.app)).get('/health/status').expect(401);
    await request(server(context.app))
      .get('/health/status')
      .set(
        'Authorization',
        'Bearer an-operations-token-with-more-than-32-characters',
      )
      .expect(200)
      .expect({ status: 'operational' });
  });
});
