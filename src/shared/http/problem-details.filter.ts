import {
  type ArgumentsHost,
  Catch,
  HttpException,
  type ExceptionFilter,
} from '@nestjs/common';

import { ERROR_STATUS_MAP } from './error-status.map';
import { type ProblemDetails } from './problem-details';
import { DomainError } from '../../capacity/domain/errors';

interface RequestWithId {
  readonly id?: string;
}

interface ResponseLike {
  status(code: number): this;
  type(contentType: string): this;
  json(body: ProblemDetails): this;
}

const GENERIC_DETAIL = 'An unexpected error occurred.';

/**
 * Maps every thrown error to the RFC 7807 body of docs/PLAN.md 2.7: a mapped
 * `DomainError` keeps its status from `ERROR_STATUS_MAP`, an unmapped one is
 * `500` with a generic `detail`, a Nest `HttpException` keeps its own status,
 * and anything else is `500` with `code: 'INTERNAL_ERROR'`. `traceId` comes
 * from `request.id` (see `RequestIdMiddleware`).
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<ResponseLike>();
    const request = ctx.getRequest<RequestWithId>();
    const traceId = request.id ?? '';

    const { status, code, detail } = this.describe(exception);

    response
      .status(status)
      .type('application/problem+json')
      .json({
        type: 'about:blank',
        title: this.titleFor(status),
        status,
        detail,
        code,
        traceId,
      });
  }

  private describe(exception: unknown): {
    status: number;
    code: string;
    detail: string;
  } {
    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        code: exception.name,
        detail: exception.message,
      };
    }

    if (exception instanceof DomainError) {
      const status = ERROR_STATUS_MAP[exception.code];

      if (status !== undefined) {
        return { status, code: exception.code, detail: exception.message };
      }

      return { status: 500, code: exception.code, detail: GENERIC_DETAIL };
    }

    return { status: 500, code: 'INTERNAL_ERROR', detail: GENERIC_DETAIL };
  }

  private titleFor(status: number): string {
    return status >= 500 ? 'Internal Server Error' : 'Request Error';
  }
}
