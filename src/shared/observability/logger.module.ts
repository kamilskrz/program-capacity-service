import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';

/** Header names that must never reach a log line (docs/PLAN.md 2.7: logs free of tokens and PII). */
const REDACTED = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/** `/metrics` and the probes are scraped constantly; logging each one buries everything else. */
const UNLOGGED_ROUTES = ['/metrics', '/health', '/health/ready'];

/**
 * JSON logs through `nestjs-pino` (docs/PLAN.md 2.8), with the request id
 * `RequestIdMiddleware` already assigns reused as the log correlation id, so a
 * `traceId` in an RFC 7807 body and the log lines for that request join up.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.isProduction ? 'info' : 'debug',
          redact: { paths: REDACTED, censor: '[redacted]' },
          // The same id the middleware puts on the request, so one request's
          // log lines and its error response carry one identifier.
          genReqId: (request: {
            id?: unknown;
            headers: Record<string, unknown>;
          }) =>
            typeof request.id === 'string'
              ? request.id
              : ((request.headers['x-request-id'] as string | undefined) ??
                randomUUID()),
          customProps: (request: { id?: unknown }) => ({
            correlationId: request.id,
          }),
          autoLogging: {
            ignore: (request: { url?: string }) =>
              UNLOGGED_ROUTES.includes(request.url ?? ''),
          },
          // Pretty output is a development convenience; production emits the
          // JSON a log pipeline expects.
          transport: config.isProduction
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
