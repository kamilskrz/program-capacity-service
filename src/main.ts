import 'reflect-metadata';

import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { AppConfigService } from './shared/config/app-config.service';
import { EnvValidationError } from './shared/config/env.schema';

/** Probes stay outside `/api/v1`; everything else is versioned. */
const UNPREFIXED_ROUTES = ['health', 'health/ready'];

async function bootstrap(): Promise<void> {
  // abortOnError: false so a configuration problem reaches the catch below
  // instead of aborting the process inside Nest; bufferLogs so that a failed
  // bootstrap prints one readable message rather than a stack trace followed
  // by the same message.
  const app = await NestFactory.create(AppModule, {
    abortOnError: false,
    bufferLogs: true,
    autoFlushLogs: false,
  });

  app.setGlobalPrefix('api', { exclude: UNPREFIXED_ROUTES });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Lets MikroORM close its pool and, from cycle 7, the Kafka consumer stop
  // cleanly on SIGTERM.
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);

  app.flushLogs();
  await app.listen(config.port, '0.0.0.0');

  Logger.log(
    `Listening on port ${config.port} (${config.nodeEnv}); API at /api/v1, probes at /health`,
    'Bootstrap',
  );
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    // Fail fast, and say exactly what is missing. No stack trace: the stack is
    // noise when the answer is "set DATABASE_URL".
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  Logger.flush();
  Logger.error(
    error instanceof Error ? error.stack : String(error),
    'Bootstrap',
  );
  process.exit(1);
});
