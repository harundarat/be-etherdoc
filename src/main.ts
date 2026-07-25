import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as cookieParser from 'cookie-parser';
import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from './config/runtime-config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const runtime = app.get(ConfigService).getOrThrow<RuntimeConfig>('runtime');

  app.use(cookieParser());

  app.enableCors({
    origin: runtime.corsOrigin,
    credentials: true,
  });

  // Activate validation pipe globally
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(runtime.port);
}
void bootstrap();
