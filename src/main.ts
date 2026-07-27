import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from './config/runtime-config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttpApplication } from './http/configure-http';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  const runtime = app.get(ConfigService).getOrThrow<RuntimeConfig>('runtime');

  configureHttpApplication(app, runtime);

  await app.listen(runtime.port);
}
void bootstrap();
