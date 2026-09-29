import { Migration } from '@mikro-orm/migrations';

/**
 * The keyset pagination index for `GET /programs/:id/reservations`
 * (docs/PLAN.md 2.7): `reserved_at` is the primary order, `invoice_id` its
 * tie-break, since two holds opened in the same transaction share an instant.
 */
export class Migration20260929120000 extends Migration {
  override up(): void {
    this.addSql(
      `create index "reservations_program_id_reserved_at_invoice_id_index" on "reservations" ("program_id", "reserved_at", "invoice_id");`,
    );
  }

  override down(): void {
    this.addSql(
      `drop index if exists "reservations_program_id_reserved_at_invoice_id_index";`,
    );
  }
}
