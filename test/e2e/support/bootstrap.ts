import { type Server } from 'node:http';

import {
  type INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../src/app.module';
import { TreasuryKafkaConsumer } from '../../../src/treasury-sync/infrastructure/kafka/treasury-kafka-consumer';

/** Mirrors `main.ts`'s `UNPREFIXED_ROUTES`, which this suite cannot import without `main.ts` running `bootstrap()`. */
const UNPREFIXED_ROUTES = ['health', 'health/ready', 'metrics'];

/**
 * Stands in for the real consumer in the HTTP suites. `AppModule` genuinely
 * imports `TreasurySyncModule` — one process serves the API and consumes
 * treasury messages — but joining and leaving a consumer group costs seconds
 * per spec file and tests nothing these suites assert. The consumer's own
 * behaviour is covered against real Redpanda in
 * `test/integration/kafka/treasury-consumer.spec.ts`.
 */
const noKafkaConsumer = {
  onModuleInit: () => Promise.resolve(),
  onModuleDestroy: () => Promise.resolve(),
};

/**
 * `AppModule` now imports `AuthModule`/`CapacityModule` and registers its own
 * `APP_GUARD`/`APP_FILTER` providers (docs/PLAN.md 2.7's second half), so this
 * harness only has to add what `main.ts` adds outside the module graph
 * itself: the versioned prefix, the validation pipe. The rest of `Env`
 * (`PORT`/`KAFKA_BROKERS`/`JWT_SECRET`) is filled in by
 * `test/e2e/support/env-setup.ts`, a Jest `setupFiles` entry — `AppModule`'s
 * `import` below resolves `ConfigModule.forRoot({ validate })` synchronously,
 * before any code in this function runs, so setting them here would already
 * be too late.
 */
export async function createE2eApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(TreasuryKafkaConsumer)
    .useValue(noKafkaConsumer)
    .compile();

  const app = moduleRef.createNestApplication();

  app.setGlobalPrefix('api', { exclude: UNPREFIXED_ROUTES });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.init();

  return app;
}

/** `INestApplication.getHttpServer()` is typed `any`; this is the one cast, for every caller to share. */
export function httpServer(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}
