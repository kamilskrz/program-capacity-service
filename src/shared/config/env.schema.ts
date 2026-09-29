import { plainToInstance, Transform } from 'class-transformer';
import { config as loadDotenvFile } from 'dotenv';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
  type ValidationError,
} from 'class-validator';
import { Type } from '@nestjs/common';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** What the MikroORM CLI needs, and nothing else. {@link Env} extends this. */
export class DatabaseEnv {
  @IsIn(NODE_ENVS)
  NODE_ENV!: NodeEnv;

  /** Postgres connection string, e.g. postgresql://user:pass@host:5432/db */
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'must be a postgres:// or postgresql:// connection string',
  })
  @IsNotEmpty()
  DATABASE_URL!: string;
}

/** {@link DatabaseEnv} plus the seed's opt-in (docs/PLAN.md 2.9). */
export class SeedEnv extends DatabaseEnv {
  @IsOptional()
  @IsString()
  SEED_ALLOW?: string;
}

/** The single place in the code base that describes the process environment. */
export class Env extends DatabaseEnv {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  /** Comma-separated broker list, e.g. localhost:19092,localhost:19093 */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((broker) => broker.trim())
          .filter((broker) => broker.length > 0)
      : value,
  )
  @IsArray()
  @ArrayNotEmpty({ message: 'must list at least one broker' })
  @IsString({ each: true })
  KAFKA_BROKERS!: string[];

  /** HS256 signing secret. RS256/JWKS is the production answer (see docs/PLAN.md 2.7). */
  @MinLength(32, { message: 'must be at least 32 characters long' })
  JWT_SECRET!: string;
}

/** Thrown when the environment does not satisfy {@link Env}. */
export class EnvValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      [
        'Invalid environment configuration:',
        ...issues.map((issue) => `  - ${issue}`),
        '',
        'Copy .env.example to .env and fill in the missing values.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

function describe(
  error: ValidationError,
  source: Record<string, unknown>,
): string {
  const raw = source[error.property];

  if (raw === undefined || raw === '') {
    return `${error.property}: is required but was not set`;
  }

  const constraints = Object.values(error.constraints ?? {});

  return `${error.property}: ${constraints.join('; ') || 'is invalid'}`;
}

function parseWith<T extends object>(
  cls: Type<T>,
  source: Record<string, unknown>,
): T {
  const instance = plainToInstance(cls, source);
  const errors = validateSync(instance, {
    whitelist: true,
    forbidUnknownValues: false,
    stopAtFirstError: true,
  });

  if (errors.length > 0) {
    throw new EnvValidationError(
      errors.map((error) => describe(error, source)),
    );
  }

  return instance;
}

/** The `validate` hook of `@nestjs/config`, so this runs once, at startup. */
export function parseEnv(source: Record<string, unknown>): Env {
  return parseWith(Env, source);
}

/**
 * `process.env` is read in this file and nowhere else. Serves entry points
 * that run outside the Nest container, where `@nestjs/config` is not there
 * to read `.env`.
 */
export function loadDatabaseEnv(): DatabaseEnv {
  loadDotenvFile({ path: '.env', quiet: true });

  return parseWith(DatabaseEnv, process.env);
}

/** {@link loadDatabaseEnv} for `npm run seed`, which also reads `SEED_ALLOW`. */
export function loadSeedEnv(): SeedEnv {
  loadDotenvFile({ path: '.env', quiet: true });

  return parseWith(SeedEnv, process.env);
}
