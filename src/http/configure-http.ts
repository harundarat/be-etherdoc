import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { RuntimeConfig } from '../config/runtime-config';

export function configureHttpApplication(
  app: NestExpressApplication,
  runtime: RuntimeConfig,
): void {
  app.use(helmet());
  app.use(cookieParser());

  if (runtime.http.trustProxyHops > 0) {
    app.set('trust proxy', runtime.http.trustProxyHops);
  }

  app.enableCors({
    credentials: true,
    origin: runtime.corsOrigin,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
}
