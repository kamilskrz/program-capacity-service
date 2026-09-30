/**
 * The pure half of `TreasuryKafkaConsumer` (docs/PLAN.md 2.2's second half):
 * parse-then-validate-then-dispatch, and the closed permanent/transient
 * classification. Both are plain functions so they need no Kafka client to
 * test.
 */

import { type Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';

import {
  SnapshotRejectedError,
  UnknownProgramError,
} from '../../application/errors';
import { InvoiceRepaidMessage } from '../messages/invoice-repaid.message';
import { ProgramLimitChangedMessage } from '../messages/program-limit-changed.message';
import { ProgramSnapshotMessage } from '../messages/program-snapshot.message';

export type TreasuryMessage =
  ProgramSnapshotMessage | ProgramLimitChangedMessage | InvoiceRepaidMessage;

/** The `type` field named something other than one of the three known discriminators. */
export class UnrecognisedMessageTypeError extends Error {
  constructor(readonly type: unknown) {
    super(`Unrecognised treasury message type: ${JSON.stringify(type)}`);
    this.name = new.target.name;
  }
}

/** class-validator rejected the body; carries every failing field and constraint for the DLQ envelope. */
export class MessageValidationError extends Error {
  constructor(
    readonly type: string,
    readonly errors: readonly ValidationError[],
  ) {
    super(
      `${type} failed validation: ${flattenValidationErrors(errors).join('; ')}`,
    );
    this.name = new.target.name;
  }
}

function flattenValidationErrors(
  errors: readonly ValidationError[],
  prefix = '',
): string[] {
  return errors.flatMap((error) => {
    const path = prefix === '' ? error.property : `${prefix}.${error.property}`;
    const own = Object.values(error.constraints ?? {}).map(
      (constraint) => `${path}: ${constraint}`,
    );
    const nested =
      error.children !== undefined
        ? flattenValidationErrors(error.children, path)
        : [];

    return [...own, ...nested];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateOrThrow<T extends object>(
  cls: Type<T>,
  parsed: unknown,
  type: string,
): T {
  const dto = plainToInstance(cls, parsed);
  const errors = validateSync(dto, {
    whitelist: true,
    forbidUnknownValues: false,
  });

  if (errors.length > 0) {
    throw new MessageValidationError(type, errors);
  }

  return dto;
}

/**
 * `JSON.parse` then type-dispatch then class-validator, in that order.
 *
 * @throws {SyntaxError} straight from `JSON.parse` for text that is not valid JSON at all — not re-wrapped.
 * @throws {UnrecognisedMessageTypeError} for a missing or unrecognised `type`.
 * @throws {MessageValidationError} for a recognised `type` whose body fails class-validator.
 */
export function parseMessage(raw: unknown): TreasuryMessage {
  const parsed: unknown = JSON.parse(String(raw));
  const type = isRecord(parsed) ? parsed['type'] : undefined;

  switch (type) {
    case 'ProgramSnapshot':
      return validateOrThrow(ProgramSnapshotMessage, parsed, type);
    case 'ProgramLimitChanged':
      return validateOrThrow(ProgramLimitChangedMessage, parsed, type);
    case 'InvoiceRepaid':
      return validateOrThrow(InvoiceRepaidMessage, parsed, type);
    default:
      throw new UnrecognisedMessageTypeError(type);
  }
}

/**
 * The closed permanent set of docs/PLAN.md 2.2: everything else defaults to
 * transient. Order matters only for readability — the checks are disjoint.
 */
export function classifyFailure(error: unknown): 'transient' | 'permanent' {
  if (
    error instanceof SnapshotRejectedError ||
    error instanceof UnknownProgramError ||
    error instanceof MessageValidationError ||
    error instanceof UnrecognisedMessageTypeError ||
    error instanceof SyntaxError
  ) {
    return 'permanent';
  }

  return 'transient';
}
