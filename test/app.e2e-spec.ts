import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { Wallet } from 'ethers';
import * as cookieParser from 'cookie-parser';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // mimicking main.ts setup for consistent testing environment
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close(); // clean up application instance
    }
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

    it('Should successfully login and get jwt token in cookie and body', async () => {
      const agent = request.agent(app.getHttpServer());

      const nonceResponse = await agent.get('/auth/nonce').expect(200);

      const { messageString } = nonceResponse.body;
      expect(messageString).toBeDefined();

      // Sign message string with admin wallet
      const wallet = new Wallet(process.env.EVM_WALLET_PRIVATE_KEY!);
      const signature = await wallet.signMessage(messageString);

      // Login
      const loginResponse = await agent
        .post('/auth/login')
        .send({ signature })
        .expect(201);

      // Check if cookie is set
      const rawCookies = loginResponse.headers['set-cookie'];
      expect(rawCookies).toBeDefined();

      const cookiesArray = Array.isArray(rawCookies)
        ? rawCookies
        : [rawCookies];
      expect(
        cookiesArray.some((cookie: string) =>
          cookie.startsWith('etherdoc-auth='),
        ),
      ).toBe(true);

      // Check response body for accessToken
      expect(loginResponse.body).toBeDefined();
      expect(loginResponse.body.accessToken).toBeDefined();
    });
  });

  describe('Documents Service', () => {
    let agent: ReturnType<typeof request.agent>;

    beforeEach(() => {
      // create a new agent for each test to ensure cookie isolation
      agent = request.agent(app.getHttpServer());
    });

    it('Should return 401 when trying to get documents without authentication', async () => {
      const response = await agent.get('/documents?network=public').expect(401);

      expect(response.body.message).toEqual('Unauthorized');
    });

    it('Should get list of public files after successful login', async () => {
      // 1. Get nonce
      const nonceResponse = await agent.get('/auth/nonce').expect(200);
      const { messageString } = nonceResponse.body;

      // 2. Sign message
      if (!process.env.EVM_WALLET_PRIVATE_KEY) {
        throw new Error('EVM_WALLET_PRIVATE_KEY is not set for testing');
      }
      const wallet = new Wallet(process.env.EVM_WALLET_PRIVATE_KEY);
      const signature = await wallet.signMessage(messageString);

      // 3. Login (agent automatically store the cookie "etherdoc-auth")
      await agent.post('/auth/login').send({ signature }).expect(201);

      // 4. Access protected route (agent will send the stored cookie)
      const documentsResponse = await agent
        .get('/documents?network=public')
        .expect(200);

      // 5. Assertions
      expect(documentsResponse.body).toBeDefined();
      expect(documentsResponse.body.data).toBeDefined();
      expect(Array.isArray(documentsResponse.body.data.files)).toBe(true);
    });

    it('Should return 401 when trying to get groups without authentication', async () => {
      const response = await agent
        .get('/documents/groups?network=public')
        .expect(401);

      expect(response.body.message).toEqual('Unauthorized');
    });

    it('Should get list of public groups after successful login', async () => {
      // 1. Get nonce
      const nonceResponse = await agent.get('/auth/nonce').expect(200);
      const { messageString } = nonceResponse.body;

      // 2. Sign message
      if (!process.env.EVM_WALLET_PRIVATE_KEY) {
        throw new Error('EVM_WALLET_PRIVATE_KEY is not set for testing');
      }
      const wallet = new Wallet(process.env.EVM_WALLET_PRIVATE_KEY);
      const signature = await wallet.signMessage(messageString);

      // 3. Login (agent automatically store the cookie "etherdoc-auth")
      await agent.post('/auth/login').send({ signature }).expect(201);

      // 4. Access protected route (agent will send the stored cookie)
      const documentsResponse = await agent
        .get('/documents/groups?network=public')
        .expect(200);

      // 5. Assertions
      expect(documentsResponse.body).toBeDefined();
      expect(documentsResponse.body.data).toBeDefined();
      expect(Array.isArray(documentsResponse.body.data.groups)).toBe(true);
    });
  });
});
