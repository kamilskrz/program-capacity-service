import { Injectable } from '@nestjs/common';
// A value import, not `type`: Nest reads this constructor parameter's
// `design:paramtypes` metadata to resolve the DI token at runtime (the same
// reason `ProgramOwnershipGuard` imports it the same way), and a type-only
// import erases the reference the emitted metadata would otherwise carry.
import { EntityManager } from '@mikro-orm/postgresql';

import {
  type CapacityEventPage,
  type CapacityEventPageRequest,
} from './ports/capacity-event.log';
import {
  type ReservationPage,
  type ReservationPageRequest,
} from './ports/reservation.repository';
import { MikroOrmCapacityEventLog } from '../infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../infrastructure/persistence/mikro-orm-reservation.repository';

/**
 * `GET /programs/:id/capacity`'s read model: `findById` plus `findWatermark`,
 * mapped to what a client needs (docs/PLAN.md 2.7). `overUtilized` is
 * `reserved > limit`; `lastReconciledAt` is the watermark's `reconciledAt`,
 * `null` if the program has never been reconciled.
 */
export interface CapacitySnapshot {
  readonly limit: string;
  readonly reserved: string;
  readonly available: string;
  readonly currency: string;
  readonly overUtilized: boolean;
  readonly lastReconciledAt: Date | null;
}

/**
 * The read side of `/programs/:id/...`: constructed off the injected,
 * request-scoped `EntityManager` directly, the same binding
 * `ProgramOwnershipGuard` uses — a plain unlocked read needs no
 * `TransactionRunner` (docs/PLAN.md 2.7).
 */
@Injectable()
export class CapacityQueryService {
  constructor(private readonly em: EntityManager) {}

  async getCapacity(programId: string): Promise<CapacitySnapshot | null> {
    const programs = new MikroOrmProgramRepository(this.em);
    const program = await programs.findById(programId);

    if (program === null) {
      return null;
    }

    const watermark = await programs.findWatermark(programId);

    return {
      limit: program.creditLimit.toDecimalString(),
      reserved: program.reserved.toDecimalString(),
      available: program.available.toDecimalString(),
      currency: program.currency,
      overUtilized: program.overUtilized,
      lastReconciledAt: watermark?.reconciledAt ?? null,
    };
  }

  listReservations(
    programId: string,
    options: ReservationPageRequest,
  ): Promise<ReservationPage> {
    return new MikroOrmReservationRepository(this.em).listByProgram(
      programId,
      options,
    );
  }

  listEvents(
    programId: string,
    options: CapacityEventPageRequest,
  ): Promise<CapacityEventPage> {
    return new MikroOrmCapacityEventLog(this.em).findByProgram(
      programId,
      options,
    );
  }
}
