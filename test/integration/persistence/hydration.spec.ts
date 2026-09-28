import { type MikroORM } from '@mikro-orm/postgresql';

import { expectSameMoney } from '../support/expect-domain';
import { OCCURRED_AT, eur, usd } from '../support/factories';
import { initTestOrm, resetDatabase } from '../support/orm';
import { insertProgramRow, insertReservationRow } from '../support/rows';
import {
  InvalidProgramError,
  InvalidReservationError,
} from '../../../src/capacity/domain/capacity-errors';
import { UnknownCurrencyError } from '../../../src/capacity/domain/errors';
import { type Program } from '../../../src/capacity/domain/program';
import { type Reservation } from '../../../src/capacity/domain/reservation';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-reservation.repository';
import { InvalidFxRateError } from '../../../src/fx/errors';

/**
 * Loading a row the domain would never have written.
 *
 * # What this file settles
 *
 * docs/PLAN.md 2.6 records that MikroORM hydrates an entity **without calling its
 * constructor**, so "validated at construction" is not true of a loaded row, and
 * says the persistence cycle has to decide explicitly between
 * `forceEntityConstructor`, a hydrator, or living with it. `DomainHydrator` is that
 * decision: `forceConstructor` is `false` in both schemas because `Program`'s and
 * `Reservation`'s constructors validate nothing, and the hydrator runs the domain's
 * own `rehydrate` factories as a **gate** — validating without adopting, so a clean
 * row does not flush itself back on every read.
 *
 * These tests are the settlement. They pin the consequence the decision accepts,
 * plainly: **a corrupt row makes its program unreadable** rather than costing its
 * own invoice a discrepancy. A program that refuses to load holds all of its
 * capacity and pages somebody; a program that loads a nonsense hold reports a
 * nonsense exposure and keeps answering `GET /capacity` with it (docs/PLAN.md 2.1's
 * governing rule).
 *
 * Every row below is written with raw SQL, because that is the only way to produce
 * one: every path through the mappings refuses these shapes, which is the point of
 * those paths.
 *
 * ## The rules the database already enforces are not retested here
 *
 * The lifecycle pairs, the FX group's all-or-nothing, the positive hold, the
 * ordered instants and the non-negative counter are `CHECK` constraints, asserted
 * in the repository specs. What is left for the hydrator is the handful of rules
 * SQL cannot state — and those are exactly what follows.
 */
describe('loading a corrupt row', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  const loadProgram = async (id = 'prog-northwind'): Promise<Program | null> =>
    new MikroOrmProgramRepository(orm.em.fork()).findById(id);

  const loadReservation = async (
    invoiceId = 'inv-0001',
  ): Promise<Reservation | null> =>
    new MikroOrmReservationRepository(orm.em.fork()).findForInvoice(
      'prog-northwind',
      invoiceId,
    );

  describe('a program', () => {
    it('refuses a currency this build does not support, which is the fault the schema deliberately does not constrain', async () => {
      // The supported set lives in `currency.ts` and adding a currency must stay
      // a one-line change there plus a seeded rate, not a migration
      // (docs/PLAN.md 2.3) — so the column is a plain `varchar(3)` and this is
      // the only place the code can refuse it.
      await insertProgramRow(orm.em, { currency: 'XYZ' });

      await expect(loadProgram()).rejects.toThrow(UnknownCurrencyError);
    });

    it('refuses a blank owning organisation, which no tenancy check could ever match', async () => {
      await insertProgramRow(orm.em, { owner_org_id: '   ' });

      await expect(loadProgram()).rejects.toThrow(InvalidProgramError);
    });

    it('loads an over-utilised program, because that is a state and not a corruption', async () => {
      await insertProgramRow(orm.em, {
        credit_limit: '100',
        reserved_amount: '900',
      });

      const loaded = await loadProgram();

      expect(loaded!.overUtilized).toBe(true);
      expectSameMoney(loaded!.available, usd(-800n));
    });
  });

  describe('a reservation', () => {
    beforeEach(async () => {
      await insertProgramRow(orm.em);
    });

    it('refuses an invoice currency this build does not support', async () => {
      await insertReservationRow(orm.em, {
        original_currency: 'XYZ',
        held_currency: 'XYZ',
      });

      await expect(loadReservation()).rejects.toThrow(UnknownCurrencyError);
    });

    it('refuses a rate stored under a scale this build does not guarantee, rather than reinterpreting it by a factor of ten', async () => {
      // The reason `fx_scale` is a column at all (docs/PLAN.md 2.3): a rate
      // written under a different precision has to be detectable.
      await insertReservationRow(orm.em, {
        original_amount: '10000000',
        original_currency: 'USD',
        reserved_amount: '9235000',
        held_currency: 'EUR',
        fx_base: 'USD',
        fx_quote: 'EUR',
        fx_scaled_value: '923500',
        fx_scale: 6,
        fx_source: 'seed',
        fx_as_of: OCCURRED_AT,
      });

      await expect(loadReservation()).rejects.toThrow(InvalidFxRateError);
    });

    it('refuses a rate whose source is blank, so a quote cannot lose its provenance in storage', async () => {
      await insertReservationRow(orm.em, {
        original_amount: '10000000',
        original_currency: 'USD',
        reserved_amount: '9235000',
        held_currency: 'EUR',
        fx_base: 'USD',
        fx_quote: 'EUR',
        fx_scaled_value: '923500000000',
        fx_scale: 12,
        fx_source: '  ',
        fx_as_of: OCCURRED_AT,
      });

      await expect(loadReservation()).rejects.toThrow(InvalidFxRateError);
    });

    it('refuses a rate recorded although nothing was converted, because an identity quote is one nobody made', async () => {
      await insertReservationRow(orm.em, {
        original_amount: '10000000',
        original_currency: 'USD',
        reserved_amount: '10000000',
        held_currency: 'USD',
        fx_base: 'USD',
        fx_quote: 'EUR',
        fx_scaled_value: '923500000000',
        fx_scale: 12,
        fx_source: 'seed',
        fx_as_of: OCCURRED_AT,
      });

      await expect(loadReservation()).rejects.toThrow(InvalidReservationError);
    });

    it('refuses a foreign-currency hold with no rate to explain it', async () => {
      await insertReservationRow(orm.em, {
        original_amount: '10000000',
        original_currency: 'USD',
        reserved_amount: '9235000',
        held_currency: 'EUR',
      });

      await expect(loadReservation()).rejects.toThrow(InvalidReservationError);
    });

    it('refuses a rate that does not price the invoice into the hold it is attached to', async () => {
      // A GBP/EUR quote does not explain a USD invoice held in EUR, however
      // plausible its value.
      await insertReservationRow(orm.em, {
        original_amount: '10000000',
        original_currency: 'USD',
        reserved_amount: '9235000',
        held_currency: 'EUR',
        fx_base: 'GBP',
        fx_quote: 'EUR',
        fx_scaled_value: '923500000000',
        fx_scale: 12,
        fx_source: 'seed',
        fx_as_of: OCCURRED_AT,
      });

      await expect(loadReservation()).rejects.toThrow(InvalidReservationError);
    });

    it('loads a corrected hold whose stored rate no longer reproduces its amount, because a correction keeps the original quote', async () => {
      // The one shape that looks corrupt and is not (docs/PLAN.md 2.1, 2.3):
      // treasury restated the held amount and the frozen quote stayed put, so
      // `rehydrate` deliberately does not re-derive the conversion. A hydrator
      // that checked it would make every corrected reservation unloadable.
      await insertReservationRow(orm.em, {
        original_amount: '10000000',
        original_currency: 'USD',
        reserved_amount: '9300000',
        held_currency: 'EUR',
        fx_base: 'USD',
        fx_quote: 'EUR',
        fx_scaled_value: '923500000000',
        fx_scale: 12,
        fx_source: 'seed',
        fx_as_of: OCCURRED_AT,
      });

      const loaded = await loadReservation();

      expectSameMoney(loaded!.reservedAmount, eur(9_300_000n));
      expect(loaded!.fxRate?.toDecimalString()).toBe('0.9235');
    });
  });

  describe('the cost the decision accepts', () => {
    it('costs a program its whole reconciliation read when one of its holds is corrupt', async () => {
      // Stated plainly because it is the trade, not an accident: one bad row
      // fails the read rather than flagging one invoice. The alternative is an
      // exposure figure a funder makes credit decisions against that includes a
      // hold nobody can vouch for.
      await insertProgramRow(orm.em);
      await insertReservationRow(orm.em, { invoice_id: 'inv-0001' });
      await insertReservationRow(orm.em, {
        invoice_id: 'inv-0002',
        original_currency: 'XYZ',
        held_currency: 'XYZ',
      });

      const reading = async (): Promise<unknown> =>
        new MikroOrmReservationRepository(orm.em.fork()).findForReconciliation(
          'prog-northwind',
          [],
        );

      await expect(reading()).rejects.toThrow(UnknownCurrencyError);
    });

    it('still answers the watermark question, which is what keeps a stale snapshot decidable', async () => {
      // The one read that deliberately survives a corrupt row: a partial select
      // skips hydration entirely (see `MikroOrmProgramRepository.findWatermark`).
      await insertProgramRow(orm.em, {
        currency: 'XYZ',
        last_snapshot_sequence: '9',
        last_reconciled_at: OCCURRED_AT,
      });

      const watermark = await new MikroOrmProgramRepository(
        orm.em.fork(),
      ).findWatermark('prog-northwind');

      expect(watermark?.appliedSequence).toBe(9n);
    });
  });
});
