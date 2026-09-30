import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  type MessageEvent,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  concatMap,
  filter,
  from,
  interval,
  map,
  merge,
  of,
  type Observable,
} from 'rxjs';

import { type CapacityResponse } from './dto/capacity.response';
import { CreateProgramDto } from './dto/create-program.dto';
import {
  type EventPageResponse,
  type EventResponse,
} from './dto/event.response';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { ListReservationsQueryDto } from './dto/list-reservations-query.dto';
import { type ProgramResponse } from './dto/program.response';
import { ReleaseReservationDto } from './dto/release-reservation.dto';
import {
  type ReservationPageResponse,
  type ReservationResponse,
} from './dto/reservation.response';
import { ReserveInvoiceDto } from './dto/reserve-invoice.dto';
import { CapacityChangeBroadcaster } from '../../application/capacity-change-broadcaster';
import {
  CapacityQueryService,
  type CapacitySnapshot,
} from '../../application/capacity-query.service';
import { CreateProgramUseCase } from '../../application/create-program.use-case';
import { type CapacityEventEntry } from '../../application/ports/capacity-event.log';
import { ReleaseReservationUseCase } from '../../application/release-reservation.use-case';
import { ReserveInvoiceUseCase } from '../../application/reserve-invoice.use-case';
import { type CurrencyCode } from '../../domain/currency';
import { Money } from '../../domain/money';
import { type Program } from '../../domain/program';
import { type Reservation } from '../../domain/reservation';
import { type AuthenticatedUser } from '../../../auth/claims';
import { ProgramOwnershipGuard } from '../../../auth/program-ownership.guard';
import { Scopes } from '../../../auth/scopes.decorator';
import { MetricsService } from '../../../shared/observability/metrics.service';

/** Reservation/event listings default to this page size when the caller states none. */
const DEFAULT_PAGE_LIMIT = 50;

/** Short enough to survive a proxy's idle timeout, long enough not to be traffic (docs/PLAN.md 2.8). */
const HEARTBEAT_INTERVAL_MS = 15_000;

interface RequestWithUser {
  readonly user: AuthenticatedUser;
}

/** The one thing a handler needs of the response to vary a status after the fact. */
interface ResponseWithStatus {
  status(code: number): this;
}

function toCapacityResponse(snapshot: CapacitySnapshot): CapacityResponse {
  return {
    limit: snapshot.limit,
    reserved: snapshot.reserved,
    available: snapshot.available,
    currency: snapshot.currency,
    lastReconciledAt: snapshot.lastReconciledAt?.toISOString() ?? null,
    overUtilized: snapshot.overUtilized,
  };
}

function toProgramResponse(program: Program): ProgramResponse {
  return {
    id: program.id,
    ownerOrgId: program.ownerOrgId,
    currency: program.currency,
    creditLimit: program.creditLimit.toDecimalString(),
  };
}

function toReservationResponse(reservation: Reservation): ReservationResponse {
  return {
    invoiceId: reservation.invoiceId,
    status: reservation.status,
    originalAmount: reservation.originalAmount.toDecimalString(),
    originalCurrency: reservation.originalAmount.currency,
    reservedAmount: reservation.reservedAmount.toDecimalString(),
    reservedCurrency: reservation.reservedAmount.currency,
    releasedAmount: reservation.releasedAmount.toDecimalString(),
    releasedCurrency: reservation.releasedAmount.currency,
    reservedAt: reservation.reservedAt.toISOString(),
    releasedAt: reservation.releasedAt?.toISOString() ?? null,
    releaseReason: reservation.releaseReason,
  };
}

function toEventResponse(entry: CapacityEventEntry): EventResponse {
  const { event } = entry;

  return {
    id: entry.id.toString(),
    type: event.type,
    invoiceId: event.invoiceId,
    delta: event.delta.toDecimalString(),
    deltaCurrency: event.delta.currency,
    resultingReserved: event.resultingReserved.toDecimalString(),
    resultingReservedCurrency: event.resultingReserved.currency,
    actor: event.actor,
    source: event.source,
    correlationId: event.correlationId,
    occurredAt: event.occurredAt.toISOString(),
    recordedAt: entry.recordedAt.toISOString(),
  };
}

/**
 * `/programs` and everything nested under `/programs/:id` (docs/PLAN.md 2.7):
 * one resource, one controller, rather than scattering its routes across
 * files. `@UseGuards(ProgramOwnershipGuard)` on every handler except `create`,
 * which has no `:id` yet to own. `actor` always comes from `request.user.sub`,
 * never the body; `correlationId` from `X-Correlation-Id`, `null` if absent.
 */
@ApiTags('programs')
@ApiBearerAuth()
@Controller('programs')
export class ProgramsController {
  constructor(
    private readonly createProgramUseCase: CreateProgramUseCase,
    private readonly reserveInvoiceUseCase: ReserveInvoiceUseCase,
    private readonly releaseReservationUseCase: ReleaseReservationUseCase,
    private readonly queries: CapacityQueryService,
    private readonly broadcaster: CapacityChangeBroadcaster,
    private readonly metrics: MetricsService,
  ) {}

  @Post()
  @Scopes('programs:admin')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateProgramDto): Promise<ProgramResponse> {
    const program = await this.createProgramUseCase.execute({
      id: dto.id,
      ownerOrgId: dto.ownerOrgId,
      currency: dto.currency,
      creditLimit: dto.creditLimit,
    });

    return toProgramResponse(program);
  }

  @Get(':id/capacity')
  @UseGuards(ProgramOwnershipGuard)
  async getCapacity(@Param('id') id: string): Promise<CapacityResponse> {
    const snapshot = await this.queries.getCapacity(id);

    if (snapshot === null) {
      throw new NotFoundException('Program not found.');
    }

    return toCapacityResponse(snapshot);
  }

  /**
   * The same figure as `GET :id/capacity`, pushed whenever it moves
   * (docs/PLAN.md 2.8): the current value first, so a client does not wait for
   * the next change, then one event per change, plus a heartbeat so an idle
   * stream survives a proxy's read timeout. Authorized exactly like the `GET`
   * — `ProgramOwnershipGuard` runs before the stream opens.
   */
  @Sse(':id/capacity/stream')
  @UseGuards(ProgramOwnershipGuard)
  streamCapacity(@Param('id') id: string): Observable<MessageEvent> {
    const capacity = merge(of(null), this.broadcaster.forProgram(id)).pipe(
      concatMap(() => from(this.queries.getCapacity(id))),
      // A program deleted mid-stream would read as `null`; nothing deletes one
      // today, and sending the last known figure would be a lie.
      filter((snapshot) => snapshot !== null),
      map((snapshot) => ({
        type: 'capacity',
        data: toCapacityResponse(snapshot),
      })),
    );
    const heartbeat = interval(HEARTBEAT_INTERVAL_MS).pipe(
      map(() => ({ type: 'heartbeat', data: '' })),
    );

    return merge(capacity, heartbeat);
  }

  @Post(':id/reservations')
  @UseGuards(ProgramOwnershipGuard)
  @Scopes('capacity:write')
  async reserve(
    @Param('id') id: string,
    @Body() dto: ReserveInvoiceDto,
    @Req() request: RequestWithUser,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: ResponseWithStatus,
  ): Promise<ReservationResponse> {
    const result = await this.reserveInvoiceUseCase
      .execute({
        programId: id,
        invoiceId: dto.invoiceId,
        amount: dto.amount,
        currency: dto.currency,
        actor: request.user.sub,
        correlationId: correlationId ?? null,
      })
      .catch((error: unknown) => {
        // Counted here rather than in a filter: this is the one place that
        // knows the attempt was a reservation rather than any other 4xx.
        this.metrics.reservation('rejected');

        throw error;
      });

    this.metrics.reservation(
      result.status === 'CREATED' ? 'created' : 'replayed',
    );

    // Only a genuinely new hold moved capacity; a replay reports the figure
    // that was already there.
    if (result.status === 'CREATED') {
      this.broadcaster.publish({ programId: id, occurredAt: new Date() });
      await this.recordUtilization(id);
    }

    response.status(
      result.status === 'CREATED' ? HttpStatus.CREATED : HttpStatus.OK,
    );

    return toReservationResponse(result.reservation);
  }

  @Get(':id/reservations')
  @UseGuards(ProgramOwnershipGuard)
  async listReservations(
    @Param('id') id: string,
    @Query() query: ListReservationsQueryDto,
  ): Promise<ReservationPageResponse> {
    const page = await this.queries.listReservations(id, {
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
      after: query.after,
      status: query.status,
    });

    return {
      reservations: page.reservations.map(toReservationResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Post(':id/reservations/:invoiceId/release')
  @UseGuards(ProgramOwnershipGuard)
  @Scopes('capacity:write')
  @HttpCode(HttpStatus.OK)
  async release(
    @Param('id') id: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: ReleaseReservationDto,
    @Req() request: RequestWithUser,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<ReservationResponse> {
    const result = await this.releaseReservationUseCase.execute({
      programId: id,
      invoiceId,
      reason: dto.reason,
      actor: request.user.sub,
      correlationId: correlationId ?? null,
    });

    // Unconditional: the result does not say whether this call was the one
    // that released it, and a repeated release simply re-sends the figure that
    // is already there — a redundant event, not a wrong one.
    this.broadcaster.publish({ programId: id, occurredAt: new Date() });
    await this.recordUtilization(id);

    return toReservationResponse(result.reservation);
  }

  /** Utilisation is read back rather than derived here, so one figure has one source. */
  private async recordUtilization(programId: string): Promise<void> {
    const snapshot = await this.queries.getCapacity(programId);

    if (snapshot === null) {
      return;
    }

    // The snapshot's currency is a wire-shaped `string`; the cast is the usual
    // boundary, since `fromDecimalString` validates it regardless.
    const currency = snapshot.currency as CurrencyCode;

    this.metrics.observeUtilization(
      programId,
      Money.fromDecimalString(snapshot.reserved, currency).minorUnits,
      Money.fromDecimalString(snapshot.limit, currency).minorUnits,
    );
  }

  @Get(':id/events')
  @UseGuards(ProgramOwnershipGuard)
  async listEvents(
    @Param('id') id: string,
    @Query() query: ListEventsQueryDto,
  ): Promise<EventPageResponse> {
    const page = await this.queries.listEvents(id, {
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
      after: query.after === undefined ? undefined : BigInt(query.after),
    });

    return {
      events: page.entries.map(toEventResponse),
      nextCursor: page.nextCursor === null ? null : page.nextCursor.toString(),
    };
  }
}
