import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

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
import { CapacityQueryService } from '../../application/capacity-query.service';
import { CreateProgramUseCase } from '../../application/create-program.use-case';
import { type CapacityEventEntry } from '../../application/ports/capacity-event.log';
import { ReleaseReservationUseCase } from '../../application/release-reservation.use-case';
import { ReserveInvoiceUseCase } from '../../application/reserve-invoice.use-case';
import { type Program } from '../../domain/program';
import { type Reservation } from '../../domain/reservation';
import { type AuthenticatedUser } from '../../../auth/claims';
import { ProgramOwnershipGuard } from '../../../auth/program-ownership.guard';
import { Scopes } from '../../../auth/scopes.decorator';

/** Reservation/event listings default to this page size when the caller states none. */
const DEFAULT_PAGE_LIMIT = 50;

interface RequestWithUser {
  readonly user: AuthenticatedUser;
}

/** The one thing a handler needs of the response to vary a status after the fact. */
interface ResponseWithStatus {
  status(code: number): this;
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

    return {
      limit: snapshot.limit,
      reserved: snapshot.reserved,
      available: snapshot.available,
      currency: snapshot.currency,
      lastReconciledAt: snapshot.lastReconciledAt?.toISOString() ?? null,
      overUtilized: snapshot.overUtilized,
    };
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
    const result = await this.reserveInvoiceUseCase.execute({
      programId: id,
      invoiceId: dto.invoiceId,
      amount: dto.amount,
      currency: dto.currency,
      actor: request.user.sub,
      correlationId: correlationId ?? null,
    });

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

    return toReservationResponse(result.reservation);
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
