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

// Loading a row the domain would never have written. MikroORM hydrates
// without calling the constructor, so `DomainHydrator` runs the domain's
// `rehydrate` factories as a gate instead. The consequence these tests pin:
// a corrupt row makes its whole program unreadable rather than costing one
// invoice a discrepancy — deliberate, since a nonsense exposure kept
// answering GET /capacity is worse. Rows are written with raw SQL because
// every path through the mappings refuses these shapes. CHECK constraints
// are covered in the repository specs, not retested here.
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
      // The column is a plain varchar(3), so adding a currency stays a
      // one-line change plus a seeded rate rather than a migration.
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
      // Looks corrupt and isn't: a correction restates the amount but keeps
      // the frozen quote, so `rehydrate` deliberately doesn't re-derive it —
      // checking would make every corrected reservation unloadable.
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
      // The deliberate trade: one bad row fails the whole read rather than
      // flagging one invoice, so no exposure figure includes an unvouched hold.
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
      // Deliberately survives a corrupt row: this partial select skips hydration entirely.
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
