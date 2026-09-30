# Architecture

## The shape

```
src/
  capacity/                       the core: programs, reservations, availability
    domain/                       Money, Program, Reservation, reconcile-program's inputs
    application/                  use cases and the ports they depend on
    infrastructure/persistence/   EntitySchema mappings, repositories, migrations
    infrastructure/http/          controllers, DTOs
  treasury-sync/
    domain/reconcile-program.ts   (program state, snapshot) → plan + discrepancies. Pure.
    application/                  applying that plan; the discrepancy state machine
    infrastructure/kafka/         the consumer, message DTOs, the DLQ, seed:treasury
    infrastructure/persistence/   the discrepancy table and its own transaction runner
  fx/                             the rate port and its database-backed provider
  auth/                           JWT guard, ownership guard, scopes
  shared/                         config, database, health, RFC 7807, logging, metrics
```

Packaging is **feature-first**: a change to one capability touches one folder, instead of being spread
across `controllers/`, `services/` and `entities/`. Layer-first was the alternative, settled against
at the skeleton stage while the change was still cheap.

## The dependency rule

```
infrastructure  →  application  →  domain
```

and never the other way. Concretely:

- **`domain/` imports nothing from NestJS or MikroORM.** It is plain TypeScript, mapped to the
  database through `EntitySchema` so the aggregates carry no decorators. This is what lets the entire
  rule set be tested in milliseconds with no I/O, and what would let the ORM be replaced without the
  rules noticing.
- **`application/` depends on ports**, not adapters: `ProgramRepository`, `ReservationRepository`,
  `CapacityEventLog`, `FxRateProvider`, `TransactionRunner`, `Clock`. It uses NestJS's `@Inject`, and
  nothing else framework-shaped.
- **`treasury-sync` depends on `capacity`, never the reverse.** It calls `capacity`'s ports and domain
  methods; it never writes to `capacity`'s tables directly, so locking and audit stay in one place.
  This is why `treasury-sync` has its own `TreasuryTransactionRunner` — a small, deliberate duplicate
  of `capacity`'s — rather than widening `capacity`'s to know about a treasury-only repository.

## Where a capacity change happens

Every one of them, from any source, takes the same path:

```
TransactionRunner.run(repos => {
  program = repos.programs.findForCapacityChange(id)   // SELECT … FOR UPDATE
  …read what the domain needs…
  change  = program.reserve(…) | release(…) | correctReservation(…) | changeCreditLimit(…)
  repos.reservations.add(…)   // only for a genuinely new hold
  repos.events.append(change.event)   // only when the domain produced one
})                                     // commit
```

The lock is the single serialisation point, and it is per program row — two programs never block each
other. The repositories are constructed **per transaction**, bound to that transaction's
`EntityManager`; one that captured the global manager would read and write outside the transaction its
caller believes it is in, silently, and only under load.

The domain **returns** its audit event rather than writing one, so a call site cannot change capacity
and forget the log. A no-op returns `null` instead, because the log records changes.

## Reconciliation

`reconcile-program.ts` is a pure function: state and a snapshot in, a plan of steps and a list of
discrepancies out. It applies nothing and reads nothing. That is what makes ten pages of rules —
gate order, clock-skew margins in both directions, counter drift, two checksum pairs, per-invoice
diffs — testable as a table rather than as a database fixture.

What it deliberately cannot do is remember. Whether a discrepancy is *new*, *still open* or *just
resolved* depends on what was flagged last time, which is state, so that diff lives in the use case
that applies the plan: it reads the open discrepancies before deciding, and emits a
`DISCREPANCY_FLAGGED` event only on a transition, never on every snapshot that still sees the same
problem.

## Testing

Three levels, weighted towards the middle:

- **Unit** (1096, no I/O, about a second): every domain rule, the reconciliation function, the use
  cases against in-memory fakes of their ports.
- **Integration** (227, real Postgres and Redpanda via Testcontainers): the mappings, the row lock
  under real contention, the migration's reversibility, the consumer's produce → apply → commit round
  trip, the DLQ, and the e2e HTTP suites.
- **e2e** (`supertest` against the real module graph): auth, tenancy isolation, the RFC 7807 shape,
  pagination, and the reserve → release happy path through a real signed token.

Fakes stand in for ports, never for the database — the difficulty lives in the database, so mocking it
would test the wrong thing. Where a fake exists it models the real adapter's *timing* too: the
in-memory repositories stage writes and only commit them on a flush, because the real ones do, and a
test that could not tell the difference would not have caught a partial write.
