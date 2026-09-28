import { Migration } from '@mikro-orm/migrations';

/**
 * The initial schema: programs, reservations, the append-only capacity event log,
 * the treasury discrepancy table and the seeded FX rate table.
 *
 * ## Hand-written and reviewable (docs/PLAN.md 2.6)
 *
 * `schema:update` is never run, in any environment, and there is no `synchronize`:
 * the schema is owned by migrations, which means a human reads every statement
 * before it reaches a database. The statements below were generated from the
 * `EntitySchema` mappings and then ordered, split and commented by hand, so that
 * what the ORM believes and what the database contains are the same thing by
 * construction — `test/integration/persistence/schema.spec.ts` asserts exactly
 * that, and a divergence between this file and a mapping is the bug it catches.
 *
 * Statements are one per `addSql` call rather than one long string, because
 * `allOrNothing` wraps the whole migration in a transaction and a failure should
 * name the statement that failed. Postgres runs DDL transactionally, so a failed
 * migration leaves no half-created schema behind.
 *
 * ## Table order
 *
 * `programs` first, then everything that references it. The foreign keys are added
 * at the end, as separate statements, so the tables can be read on their own and so
 * a future migration that needs to drop one has an obvious counterpart to reverse.
 *
 * ## What is here that no mapping could state
 *
 * The append-only trigger on `capacity_events` (docs/PLAN.md 2.8). MikroORM does not
 * introspect triggers, so it is invisible to the schema diff — which is why it lives
 * in a migration and is covered by a test of its own instead
 * (`capacity-event-log.spec.ts`: an `update` and a `delete` both fail).
 */
export class Migration20260928120000 extends Migration {
  override up(): void {
    // --- programs ----------------------------------------------------------
    // One currency per row: the limit, the reserved total and every hold against
    // the program are stated in it. `reserved_amount` is the denormalized counter
    // of docs/PLAN.md 2.4, which is what makes availability an O(1) read of one
    // locked row.
    //
    // `CHECK (reserved_amount >= 0)` is required by docs/PLAN.md 2.4. There is
    // deliberately **no** constraint asserting `credit_limit >= reserved_amount`,
    // in any spelling: reconciliation may legitimately push availability negative
    // (a reduced limit, an upward correction) and the program then has to store,
    // load, report and release. A constraint here would fail the very transaction
    // that was recording the truth.
    this.addSql(`create table "programs" (
      "id" varchar(64) not null,
      "owner_org_id" varchar(64) not null,
      "currency" varchar(3) not null,
      "credit_limit" bigint not null,
      "reserved_amount" bigint not null,
      "last_snapshot_sequence" bigint null,
      "last_reconciled_at" timestamptz null,
      constraint "programs_pkey" primary key ("id"),
      constraint programs_reserved_amount_non_negative check (reserved_amount >= 0),
      constraint programs_credit_limit_non_negative check (credit_limit >= 0)
    );`);
    // Tenancy: every program of one organisation (docs/PLAN.md 2.7).
    this.addSql(
      `create index "programs_owner_org_id_index" on "programs" ("owner_org_id");`,
    );

    // --- reservations ------------------------------------------------------
    // `(program_id, invoice_id)` is the natural key and therefore the primary key:
    // the idempotency key of docs/PLAN.md 2.5, unique within a program and not
    // globally (2.9). A second reservation for the same invoice fails here, at
    // `flush()`, which is the backstop for the race a row lock on the program
    // cannot cover.
    //
    // Two currencies, because a reservation states an amount in the invoice's
    // currency and holds an amount in the program's; `released_amount` shares
    // `held_currency`, being part of the same held sum.
    //
    // The six `fx_*` columns are the frozen evidence of docs/PLAN.md 2.3,
    // nullable **together** — `num_nulls(...) = any(array[0, 6])` — because an
    // invoice already in the program's currency has no rate and an identity rate
    // would record a quote nobody made. `fx_scale` is stored next to the value so
    // that a row written under a different precision is detectable rather than
    // silently reinterpreted by a factor of ten.
    //
    // The lifecycle check encodes the two shapes this service can produce
    // (docs/PLAN.md 2.5): active and holding everything, or released and having
    // given back exactly what it held. The half-released row partial releases
    // would introduce is unstorable, which keeps that scope boundary a property of
    // the schema and not a habit of its callers.
    this.addSql(`create table "reservations" (
      "program_id" varchar(64) not null,
      "invoice_id" varchar(128) not null,
      "status" text check ("status" in ('ACTIVE', 'RELEASED')) not null,
      "original_amount" bigint not null,
      "original_currency" varchar(3) not null,
      "reserved_amount" bigint not null,
      "released_amount" bigint not null,
      "held_currency" varchar(3) not null,
      "fx_base" varchar(3) null,
      "fx_quote" varchar(3) null,
      "fx_scaled_value" bigint null,
      "fx_scale" smallint null,
      "fx_source" varchar(64) null,
      "fx_as_of" timestamptz null,
      "reserved_at" timestamptz not null,
      "released_at" timestamptz null,
      "release_reason" text check ("release_reason" in ('REPAID', 'CANCELLED')) null,
      constraint "reservations_pkey" primary key ("program_id", "invoice_id"),
      constraint reservations_reserved_amount_positive check (reserved_amount > 0),
      constraint reservations_released_amount_non_negative check (released_amount >= 0),
      constraint reservations_fx_evidence_complete check (num_nulls(fx_base, fx_quote, fx_scaled_value, fx_scale, fx_source, fx_as_of) = any(array[0, 6])),
      constraint reservations_fx_scaled_value_positive check (fx_scaled_value is null or fx_scaled_value > 0),
      constraint reservations_lifecycle check ((status = 'ACTIVE' and released_amount = 0 and released_at is null and release_reason is null) or (status = 'RELEASED' and released_amount = reserved_amount and released_at is not null and release_reason is not null)),
      constraint reservations_released_after_reserved check (released_at is null or released_at >= reserved_at)
    );`);
    // The active holds of one program: the drift check of docs/PLAN.md 2.4 and the
    // list endpoint's status filter (2.7). Lookup by invoice is the primary key.
    this.addSql(
      `create index "reservations_program_id_status_index" on "reservations" ("program_id", "status");`,
    );

    // --- capacity_events ---------------------------------------------------
    // The append-only audit log of docs/PLAN.md 2.8, written in the same
    // transaction as the change it records.
    //
    // `delta` means one thing only — the change to the reserved total — so it is
    // zero for `LIMIT_CHANGED`, whose two limits travel in `metadata`. That is what
    // keeps `SUM(delta) = reserved_amount` (docs/PLAN.md 2.4) a checkable
    // invariant. `resulting_reserved` is recorded beside it so the log can be
    // verified row by row instead of only in aggregate.
    //
    // `id bigserial` is the pagination cursor of docs/PLAN.md 2.7: two events
    // written in one transaction share `occurred_at` to the microsecond, so a
    // timestamp cannot page deterministically.
    this.addSql(`create table "capacity_events" (
      "id" bigserial primary key,
      "type" text check ("type" in ('RESERVED', 'RELEASED', 'LIMIT_CHANGED', 'RECONCILIATION_APPLIED', 'RECONCILIATION_ADJUSTMENT', 'DISCREPANCY_FLAGGED')) not null,
      "program_id" varchar(64) not null,
      "invoice_id" varchar(128) null,
      "delta" bigint not null,
      "resulting_reserved" bigint not null,
      "currency" varchar(3) not null,
      "actor" varchar(255) not null,
      "source" text check ("source" in ('API', 'TREASURY_SNAPSHOT', 'TREASURY_EVENT')) not null,
      "correlation_id" varchar(128) null,
      "occurred_at" timestamptz not null,
      "recorded_at" timestamptz not null default now(),
      "metadata" jsonb not null default '{}',
      constraint capacity_events_resulting_reserved_non_negative check (resulting_reserved >= 0),
      constraint capacity_events_invoice_id_presence check ((type = any(array['LIMIT_CHANGED', 'RECONCILIATION_APPLIED'])) = (invoice_id is null))
    );`);
    this.addSql(
      `create index "capacity_events_program_id_id_index" on "capacity_events" ("program_id", "id");`,
    );
    this.addSql(
      `create index "capacity_events_program_id_occurred_at_index" on "capacity_events" ("program_id", "occurred_at");`,
    );
    this.addSql(
      `create index "capacity_events_invoice_id_index" on "capacity_events" ("invoice_id");`,
    );

    // Append-only, enforced for every role including the owner. A `REVOKE` would
    // not constrain the owner the local stack and the test harness connect as, so
    // the guarantee would hold in production and be untestable — the kind of safety
    // net that is discovered to be missing during an incident.
    //
    // `TRUNCATE` is deliberately not guarded: it cannot rewrite a single row, it is
    // not granted in production, and it is how the integration suite isolates tests
    // (docs/PLAN.md 2.10).
    this.addSql(`create or replace function capacity_events_append_only()
      returns trigger
      language plpgsql as $$
      begin
        raise exception 'capacity_events is append-only, % is not permitted', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;`);
    this.addSql(`create trigger capacity_events_append_only
      before update or delete on "capacity_events"
      for each row execute function capacity_events_append_only();`);

    // --- treasury_discrepancies -------------------------------------------
    // Upserted, one row per `(program, invoice, reason)` with `first_seen` and
    // `last_seen` (docs/PLAN.md 2.8). Appending instead would write a row a minute
    // per unresolved invoice and leave the discrepancy metric measuring snapshot
    // cadence rather than the number of problems.
    //
    // Cycle 8 writes this table. It is created now because the upsert key is the
    // part of the schema a later cycle could not change without a data migration.
    this.addSql(`create table "treasury_discrepancies" (
      "program_id" varchar(64) not null,
      "invoice_id" varchar(128) not null,
      "reason" text check ("reason" in ('HELD_BUT_NOT_REPORTED', 'REPORTED_AGAINST_RELEASED_HOLD', 'MISSING_FX_EVIDENCE', 'INCONSISTENT_FX_EVIDENCE', 'UNUSABLE_AMOUNT')) not null,
      "detail" text not null,
      "held_amount" bigint null,
      "reported_amount" bigint null,
      "currency" varchar(3) not null,
      "local_status" text check ("local_status" in ('ACTIVE', 'RELEASED')) null,
      "reported_status" text check ("reported_status" in ('OUTSTANDING', 'REPAID')) null,
      "first_seen" timestamptz not null,
      "last_seen" timestamptz not null,
      "resolved_at" timestamptz null,
      constraint "treasury_discrepancies_pkey" primary key ("program_id", "invoice_id", "reason"),
      constraint treasury_discrepancies_has_an_amount check (held_amount is not null or reported_amount is not null),
      constraint treasury_discrepancies_last_seen_after_first_seen check (last_seen >= first_seen)
    );`);
    this.addSql(
      `create index "treasury_discrepancies_program_id_resolved_at_index" on "treasury_discrepancies" ("program_id", "resolved_at");`,
    );

    // --- fx_rates ----------------------------------------------------------
    // One row per **direction** of a pair (docs/PLAN.md 2.3): rates are never
    // inverted, so `(EUR, USD)` and `(USD, EUR)` are two rows and a pair seeded in
    // one direction only answers exactly one question. `as_of` is a column rather
    // than part of the key — "the current rate" is all the `FxRateProvider` port
    // asks for, and the figure that matters historically is the one frozen on the
    // reservation.
    this.addSql(`create table "fx_rates" (
      "base" varchar(3) not null,
      "quote" varchar(3) not null,
      "scaled_value" bigint not null,
      "scale" smallint not null,
      "source" varchar(64) not null,
      "as_of" timestamptz not null,
      constraint "fx_rates_pkey" primary key ("base", "quote"),
      constraint fx_rates_scaled_value_positive check (scaled_value > 0),
      constraint fx_rates_base_differs_from_quote check (base <> quote)
    );`);

    // --- foreign keys ------------------------------------------------------
    // `on delete restrict`: a program with history cannot be deleted, and nothing
    // in the service deletes one. `on update cascade` is MikroORM's default for a
    // mapped relation and is kept so this file and the mapping agree exactly.
    this.addSql(
      `alter table "reservations" add constraint "reservations_program_id_foreign" foreign key ("program_id") references "programs" ("id") on update cascade on delete restrict;`,
    );
    this.addSql(
      `alter table "capacity_events" add constraint "capacity_events_program_id_foreign" foreign key ("program_id") references "programs" ("id") on update cascade on delete restrict;`,
    );
    this.addSql(
      `alter table "treasury_discrepancies" add constraint "treasury_discrepancies_program_id_foreign" foreign key ("program_id") references "programs" ("id") on update cascade on delete restrict;`,
    );
  }

  /**
   * Drops everything, in reverse dependency order.
   *
   *
   * Written even though nothing in this service's deployment runs it: a migration
   * whose `down` was never written is a migration nobody can undo on the one
   * occasion it matters, and a developer iterating locally reaches for it daily.
   * The trigger's function is dropped after the table that uses it.
   */
  override down(): void {
    this.addSql(`drop table if exists "reservations" cascade;`);
    this.addSql(`drop table if exists "capacity_events" cascade;`);
    this.addSql(`drop function if exists capacity_events_append_only();`);
    this.addSql(`drop table if exists "treasury_discrepancies" cascade;`);
    this.addSql(`drop table if exists "fx_rates" cascade;`);
    this.addSql(`drop table if exists "programs" cascade;`);
  }
}
