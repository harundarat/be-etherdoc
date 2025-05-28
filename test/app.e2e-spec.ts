import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { Wallet } from 'ethers';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  describe('Auth Service', () => {
    it('Should successfully get nonce from server', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/nonce')
        .expect(200);

      const { messageObject, messageString } = response.body;

      expect(messageObject).toBeDefined();
      expect(messageObject.nonce).toBeDefined();
      expect(messageObject.message).toBe('auth-login');
      expect(messageObject.address).toBeDefined();
      expect(messageString).toBeDefined();
    });

    it('Should successfully login and get jwt token', async () => {
      const nonceResponse = await request(app.getHttpServer())
        .get('/auth/nonce')
        .expect(200);

      const { messageString } = nonceResponse.body;

      expect(messageString).toBeDefined();

      // Sign message string with admin wallet
      const wallet = new Wallet(process.env.EVM_WALLET_PRIVATE_KEY!);
      const signature = await wallet.signMessage(messageString);

      // Login
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ signature });

      expect(loginResponse.headers['set-cookie']).toBeDefined();
      expect(loginResponse.headers['set-cookie'][0]).toContain(
        'etherdoc-auth=',
      );
      expect(loginResponse.body).toBeDefined();

      console.info(loginResponse.headers['set-cookie'][0]);
      console.info(`login response body: ${loginResponse.body}`);
    });
  });

  describe('Documents Service', () => {});
});
