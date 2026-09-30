# Program Capacity & Invoice Reservation — Design Decisions and Implementation Plan

Working document: the domain model, the decisions taken (with the reasoning behind them), and the
plan of work. Decisions recorded here are the source for `docs/ASSUMPTIONS.md` and the README.

---

## 1. Business context

Supply chain finance (reverse factoring):

1. A supplier issues an invoice to a buyer on 90-day terms.
2. The buyer approves the invoice.
3. A funder pays the supplier immediately, less a discount (**early payment**).
4. After 90 days the buyer repays the funder (**repayment**).

A **program** is the framing agreement between a funder and a buyer, carrying a **credit limit**
(e.g. USD 10M) — the maximum concurrent exposure. The limit is **revolving**: a reservation consumes
it, a release restores it.

This module answers, in real time: **"can this invoice be funded now without breaching the limit?"**
Breaching the limit means the funder took on risk it never approved, so correctness under
concurrency is the primary requirement.

**Treasury** is an external system that manages the actual money — bank accounts, disbursements,
repayments, funding lines. It knows what really happened.

**Reconciliation** is the alignment of two records of the same reality. This service is fast but can
drift (a missed release, a bug, a limit change); treasury is slower but authoritative and
periodically publishes a program's full state.

---

## 2. Decisions

### 2.1 Source of truth and reconciliation

Treasury and this service observe **the same set of invoices** — not two separate pools. (Modelling
them as separate pools was the first approach considered and rejected: it double-counts exposure.)

- Treasury owns `creditLimit` and the truth about invoice status.
- This service owns reservations accepted through its API.
- A snapshot carries **full state**: `sequence`, `asOf`, `creditLimit`, the list of **outstanding**
  invoices, plus checksums.

Per-invoice diff rules:

| Situation | Action |
|---|---|
| Treasury says REPAID, locally ACTIVE | release |
| Treasury knows the invoice, we do not | create the reservation |
| Amounts differ | treasury wins; adjust and write an audit entry |
| Missing from snapshot, reservation **newer** than `asOf` (with clock-skew margin) | keep (in flight) |
| Missing from snapshot, reservation **older** than `asOf` | flag as a **discrepancy**, do not release |
| Treasury reports an invoice we already released, **released after** `asOf` (same margin) | in flight, say nothing |
| Treasury reports an invoice we already released, **released before** `asOf` | flag as a **discrepancy** |
| `sequence` <= last applied | ignore the snapshot |
| Checksums do not match | reject the whole snapshot |
| Our own counter disagrees with the holds it sums | reject the whole snapshot and alarm |

The clock-skew margin applies to **both** directions of a race, which is the point of having one: a
release this service performed a second after treasury took its picture is as routine as a
reservation taken a second after it, and treating only one of them as in flight means a correctly
behaving system reports a discrepancy on every snapshot — which is how a metric stops being read.

Two of the rejections blame **this service** rather than the producer, and that distinction is carried
on the rejection itself so cycle 8 does not send our own bug to a dead-letter queue as if treasury had
written a bad message. A snapshot for an unknown program is §2.9's DLQ case, caught by the lookup before
reconciliation sees it — so by the time this function can notice a program mismatch, the only way one
can exist is that we loaded program A and handed it a snapshot for program B. That is a routing defect,
not a producer typo.

Related ordering, load-bearing and easy to undo by tidying: the reservations handed in are checked for a
wrong currency **before** the drift total is computed. Reversed, a mismatched hold reaches the money
comparison inside the sentence that is supposed to explain the drift, and the explanation throws instead
of being written.

A counter that disagrees with its own reservations is **not** healed automatically. Reconciliation
refuses the snapshot and alarms instead, because the disagreement is corruption in this service, not
news from treasury: healing it silently would erase the evidence of whatever wrote the wrong figure,
and the alternatives are worse. Applying a plan computed on a drifted counter can take the reserved
total below zero, which §2.4 forbids outright and which makes every subsequent snapshot produce the
same unappliable plan, so the program stops reconciling for good with nothing to explain why. Doing
nothing is worse still: today's code would reconcile such a program **completely clean**, recording
the snapshot as applied while the service keeps reporting an exposure treasury has just contradicted.

**Governing rule: when in doubt, hold the capacity — never release it.** A snapshot may add or
correct a hold, but never releases one based on *absent* data; a treasury-side bug (an empty list)
would otherwise free the entire limit. The cost is that a lost `InvoiceRepaid` keeps capacity held
until someone resolves it — an error in the safe direction.

Because the exposure treasury reports exists whether or not this service has room for it,
reconciliation records a hold through a **separate domain operation** rather than the client path:
the client path refuses a reservation that would breach the limit, which is correct for a client and
wrong here, since refusing would mean reporting less risk than the funder actually carries. The two
are separate named operations rather than one with a flag, so no HTTP handler can end up skipping the
limit by passing the wrong argument.

Reconciliation **may** drive `available` below zero (e.g. a reduced limit). The state is then stored,
the program is marked `overUtilized`, new reservations are rejected and releases still work. The
consumer must not crash on this.

The reconciliation function needs **every active hold, plus every reservation the snapshot names** —
not every reservation the program has ever had. Walking the rules above confirms it is sufficient: the
counter-drift gate sums only active holds, the held-but-not-reported rule skips non-active rows, and
every per-invoice rule needs only the row for an invoice the snapshot mentions. A repaid entry with no
local row is an explicit no-op, identical to the outcome of loading the released row, so the repaid
sub-list costs nothing. Nothing consults a released hold the snapshot is silent about.

One precondition of that narrowing, load-bearing enough to state: the set of reported invoice
identifiers must contain **every outstanding entry's**. Drop one, and the hold it stands against is not
loaded, so an invoice this service has already released reads as "treasury knows the invoice, we do
not" — and reconciliation opens a *fresh hold* for it instead of flagging the discrepancy the table
above requires. That is capacity invented from nothing, which is the one direction the governing rule
does not tolerate.

Passing the repaid entries' identifiers as well costs nothing and is worth doing, but it is insurance
rather than a requirement: a repaid entry whose hold is already released is a no-op, and so is a repaid
entry with no local hold at all, so the two are indistinguishable today. A repaid entry whose hold is
still **active** is loaded regardless, by the active half of the set. The insurance is against a later
cycle giving those two cases different answers.

### 2.2 Kafka messages

One topic, `treasury.program-events`, keyed by `programId` (ordering within a partition), with three
message types:

- `ProgramSnapshot` — full state: `sequence`, `asOf`, `creditLimit`, outstanding invoices (id, amount
  in program currency, the original, **and the rate that relates the two**, status),
  `outstandingTotal`, `invoiceCount`. The rate travels with the entry because the rate a reservation
  stores has to be the one that produced its amount: looking up today's quote instead would attach
  evidence to a figure it did not create. A foreign-currency invoice arriving with no rate is a
  discrepancy, not an invitation to guess. Checksums come in **two pairs**: `outstandingTotal` with
  `invoiceCount` over the outstanding entries, and `repaidTotal` with `repaidCount` over the repaid
  ones. Covering only the outstanding entries would leave the release path — the only path that
  **frees** capacity — with no integrity check at all, so a single fabricated `REPAID` entry could
  free a whole hold while the checksums agreed precisely because they ignored it. That is the one
  place the governing rule can be defeated by arithmetic, so both sub-lists are verified and a
  mismatch in either rejects the whole snapshot.
- Snapshot `asOf` values are assumed to move forward with `sequence`. The watermark enforces the
  sequence half; the clock half is the producer's responsibility, and a snapshot whose `asOf` goes
  backwards would move `lastReconciledAt` backwards with it. Checking it would mean carrying the
  previously applied `asOf` into the decision, which is deliberately not done — noted as a limitation
  rather than papered over
- `ProgramLimitChanged` — new limit
- `InvoiceRepaid` — treasury observed a repayment, so the reservation is released

The applied `sequence` is **stored and read back as a 64-bit integer**. The column is `bigint` because
a producer's counter is, and the watermark is read back exactly, so a figure this service did not write
— another writer, a data migration — is reported as it stands rather than rounded into a different
number.

The domain deliberately keeps a message's `sequence` a JS number, because that is what `JSON.parse`
can carry: a producer publishing past 2^53 loses the value before this service sees it, so accepting
such a message would be pretending to a precision the transport does not have. Reconciliation
therefore **rejects** a sequence that is not a safe integer outright (`UNUSABLE_SEQUENCE`), and that
gate is what bounds the domain side — not the column's width.

So the boundary between the two, stated once because both sides are easy to get backwards: the
watermark comes out of the database as a `bigint` and is narrowed with `Number(...)` before it is
compared against a message's sequence, which is safe **precisely because** `UNUSABLE_SEQUENCE` has
already bounded the other operand; a sequence going back to the database is widened with
`BigInt(...)`. Narrowing is not a shortcut here, it is the direction the gate makes sound.

Incremental events are modelled as **state, not deltas** (`status = REPAID`, not `-100k`), which
makes them idempotent and tolerant of loss — the next snapshot heals the state. A gap in `sequence`
does not halt processing; it produces a log entry and a metric.

A snapshot lists only **outstanding** invoices, so its size is bounded by the program limit
(~200 entries at an average of 50k per invoice). The pathological case of 10,000 small invoices
(~1.5 MB) exceeds Kafka's default 1 MB message limit; chunked snapshots and the claim-check pattern
are documented as the remedy but not implemented.

The message format is defined here (the brief does not specify one) and stated as an assumption.
Messages pass through an **anti-corruption layer** (class-validator → domain command), so a change in
the external format touches only the adapter.

### 2.3 Currencies

- Amounts are integers in **minor units** plus an ISO 4217 code (note: JPY has 0 decimals, KWD 3).
  `BIGINT` in the database, `bigint` in TypeScript, never a float at any stage. A `Money` value
  object carries this.
- Amounts are **strings on the wire**, so no JS client rounds them, but the two directions use
  different strings. **Inside** the service — persistence, audit entries, internal events — an amount
  is its minor units (`"925000000"`), which is the `BIGINT` column verbatim. **On the public API** it
  is a decimal string next to its currency (`"9250000.00"`, `"USD"`), which is how a client states an
  invoice and how a reviewer reads available capacity. `Money.toDecimalString()` and
  `Money.fromDecimalString()` are the boundary, and parsing rejects a figure with more fraction
  digits than the currency has (`"100.001"` in USD), rather than rounding the client's intent.
- A reservation stores the original amount, the FX rate used (with source, scale and timestamp) and
  the amount in program currency, **rounded up**. Those FX fields are nullable **together**: an
  invoice already in the program currency is never converted and has no rate to store, and
  synthesising an identity rate would record a quote nobody made.
- **The rate is frozen at reservation time.** A release frees exactly the stored amount and never
  re-converts; re-converting makes the limit drift over thousands of invoices.
- Drift against the market is corrected by treasury snapshots (effectively their mark-to-market).
  A correction updates the held amount and writes an audit entry; a later release frees the
  corrected amount.
- FX rates come through an `FxRateProvider` port backed by a seeded database table. A missing rate
  for a currency pair yields `422` rather than a guess.
- A rate is a scaled integer (`value / 10^12`), not a float: 1.0987 has no exact double, and a float
  multiply makes the result depend on operation order — a defect that surfaces as one-minor-unit
  drift in a reconciliation report months later. A quote finer than 12 decimal places is rejected,
  not rounded. Rates are **directional and never inverted**: a EUR/USD quote does not answer a
  USD/EUR question, because 1/1.0987 is not exactly representable. The seeded table therefore has to
  carry both directions of every pair it serves.
- **Rounding up has a consequence for reconciliation that is worth stating before it is diagnosed as a
  bug.** Conversion rounds the minor units up, so a producer that rounds *to nearest* will disagree
  with this service by one minor unit on roughly half of its converted invoices — and a snapshot entry
  whose own rate does not reproduce its own amount is flagged `INCONSISTENT_FX_EVIDENCE`. That is the
  check working, not misfiring: the alternative is trusting a figure whose arithmetic we cannot
  reproduce. If it turns out to be routine in practice, the fix is an agreed tolerance of one minor
  unit, negotiated with treasury and applied in one place, not a loosened check.
- **The FX-evidence checks gate a new hold and never restate an existing one.** A snapshot entry for an
  invoice this service does not know is checked for a usable rate that reproduces its amount; an entry
  correcting a hold that already exists is judged solely on the amount in the program's currency. The
  asymmetry is deliberate — the stored rate is frozen evidence of what was actually converted, and a
  correction restates exposure rather than re-deriving it, so re-validating the pair would either
  overwrite frozen evidence or refuse a correction treasury is right about.
- **How `Money` is mapped, and the two mappings rejected.** A `BIGINT` per amount, with the currency
  stored once per row where the domain guarantees one (`programs.currency`, `capacity_events.currency`)
  and once per distinct currency where it does not (`reservations.original_currency` for the invoice,
  `held_currency` for the hold). An *embeddable per amount* was rejected on the schema it produces:
  `programs` would carry three currency columns the domain guarantees are equal, so two of them are only
  ways for a row to contradict itself — and it cannot express `FxRate` at all, whose `asOf` is a
  `#private` field `EntitySchema` cannot see. A *`jsonb` column per amount* was rejected because
  `SUM(delta)` is the invariant §2.4 asserts and `CHECK (reserved_amount >= 0)` is required by it, and
  neither is available over JSON without casting every row.
- `reservations.held_currency` deliberately duplicates the program's currency, so a hold is loadable,
  summable and checkable without joining its program — reconciliation's drift check does exactly that
  over every active hold.
- **What the DDL cannot say, so the domain says it.** That a hold's `held_currency` equals its program's
  `currency` would need a composite foreign key on `(program_id, held_currency)` referencing
  `(id, currency)`, which MikroORM cannot express alongside two separately mapped scalar columns. The
  agreement is enforced in domain code instead. It is the one cross-row rule with no database backstop,
  which is worth knowing before trusting the schema alone.
- `fx_rates` holds the **current** quote only, keyed `(base, quote)` with no `as_of` in the key: a new
  quote replaces the old one. The figure that matters historically is the rate frozen on the
  reservation, not a rate history nobody reads.
- FX haircut/buffer and periodic mark-to-market: documented, not implemented.

Note: FX risk itself belongs to treasury (hedging). This module moves no money; it measures exposure
against a limit.

### 2.4 Concurrency

`SELECT … FOR UPDATE` on the program row (`LockMode.PESSIMISTIC_WRITE`) inside `em.transactional()`:
lock → read → **decide in the pure domain** → write reservation, counter and event → commit.

- One mechanism serializes **every** source of change: REST, snapshots and `InvoiceRepaid`.
- A denormalized `reserved_amount` on the program makes availability reads O(1).
- Invariant: `reserved_amount == SUM(active reservations) == SUM(deltas in capacity_events)`,
  asserted in an integration test.
- `CHECK (reserved_amount >= 0)` in the schema. An `available >= 0` constraint must **not** live in
  the database, because reconciliation can legitimately push it negative.
- Rejected alternatives: conditional UPDATE (business rule moves into SQL), optimistic locking
  (hot row → retry storms), SERIALIZABLE (retry handling required at every call site).

Cost: reservations against one program serialize (hundreds per second at a few ms per transaction);
different programs never block each other.

**Where the transaction is opened.** The use cases own the boundary, but they may not import MikroORM
— §2.6 keeps the ORM out of everything above the adapters, and the repositories are deliberately bound
to one `EntityManager` at construction rather than injected as singletons, because a repository that
captured the global one would read and write outside the transaction its caller believes it is in.
So the application layer depends on a `TransactionRunner` port: it asks for a transaction and is handed
the repositories already bound to it. The MikroORM adapter forks the `EntityManager`, runs
`em.transactional`, and constructs the repositories against that fork.

Two things this buys beyond tidiness. A use case becomes testable without a database — the runner is
the only thing to fake, and a fake that runs the callback once is enough. And "what can change
capacity?" stays answerable by grepping the runner's callers, which is the same property the two
separately named read methods were chosen for.

**The exact shape, so block 3 has one contract rather than several:**

```ts
interface CapacityRepositories {
  readonly programs: ProgramRepository;
  readonly reservations: ReservationRepository;
  readonly events: CapacityEventLog;
  readonly rates: FxRateProvider;       // bound to the same EntityManager — one round trip, one connection
}
interface TransactionRunner {
  run<T>(work: (repos: CapacityRepositories) => Promise<T>): Promise<T>;
}
```

Plus a `Clock` port (`now(): Date`), for the same reason the runner exists: a use case that called
`new Date()` itself could not be tested deterministically and would be reading the wall clock from
inside application logic that is supposed to be a thin, testable orchestrator.

**`ReserveInvoiceUseCase` and `ReleaseReservationUseCase` do almost nothing** — deliberately, because
`Program.reserve`/`release` already contain the whole decision (idempotent replay vs `409`, the state
machine, the audit event). The use case's job is only: acquire the lock, fetch what the domain needs,
call it, persist what it returns.

Reserve, in order:
1. `programs.findForCapacityChange(programId)` — the lock. `null` → `ProgramNotFoundError`.
2. `reservations.findForInvoice(programId, invoiceId)` — **after** the lock, not before, or two
   concurrent reserves for the same new invoice would both read `null` and both proceed.
3. `Money.fromDecimalString(command.amount, command.currency as CurrencyCode)` — the cast is safe
   because the factory itself validates and throws `UnknownCurrencyError`/`InvalidAmountError`.
4. `convert(originalAmount, program.currency, repos.rates)` — may throw `FxRateNotFoundError` (422) or
   `CurrencyMismatchError`.
5. `program.reserve({ invoiceId, amount: conversion }, existing, context)` — this is where
   `DuplicateInvoiceError` (different amount, or the invoice was released) and
   `InsufficientCapacityError` come from. Nothing above catches them; they propagate.
6. If `existing === null`, `reservations.add(change.reservation)` — a brand-new instance, never
   persisted. If `existing !== null`, do nothing: it is already the tracked row `findForInvoice` loaded,
   and the domain's no-op case returns that same instance.
7. If `change.event !== null`, `events.append(change.event)`.
8. Outcome is `existing === null ? 'CREATED' : 'REPLAYED'` — the only way step 5 returns successfully
   with `existing !== null` is the identical-replay case, so this needs no separate check.

Release is the same shape without the branching: load the program (lock) and the reservation (`null` →
new `ReservationNotFoundError`), call `program.release(reservation, reason, context)`, append the event
if one came back, return the reservation. Nothing is ever `.add()`-ed — a release always acts on a
reservation that was already loaded and is already tracked.

**One backstop the use case owns, not the adapter.** `ReservationRepository.add`'s docblock already
promises a `UniqueConstraintViolationException` at flush time maps to `409` — the race the program lock
does not cover, in the event that discipline is ever broken by a second writer that skips the lock. That
exception surfaces from `em.transactional`'s implicit flush, which runs **after** the use case's callback
has returned, so the mapping cannot live inside `work(...)`; `execute()` wraps the whole
`runner.run(...)` call and rethrows it as `DuplicateInvoiceError`. `@mikro-orm/core`'s exception type in
a `catch` clause is the one place the application layer (not the domain) knows the adapter exists — the
port itself stays framework-free.

**Deliberately out of scope for block 3**, so nobody builds it twice: HTTP DTOs and validation, the
`program.ownerOrgId === user.org` tenancy check (both belong to the controller in block 4, which has the
JWT claims the use case never sees), and the Kafka-driven `recordTreasuryHold` path (block 5/8 — a
different use case, over the same ports, calling a different domain method).

**Testing.** Unit tests for both use cases against an in-memory fake `TransactionRunner` (one that just
calls `work` with fakes of the four ports) — every branch above, plus the exception-mapping backstop via
a fake that throws `UniqueConstraintViolationException`. Integration tests on Testcontainers for the real
`MikroOrmTransactionRunner` wiring, an end-to-end reserve → release round trip, and the block's
centerpiece: **50 concurrent `reserve` calls against one program**, sized so a known number succeed
(e.g. a limit that is an exact multiple of the per-invoice amount) and the rest fail with
`InsufficientCapacityError` — asserting the exact success count, `reserved_amount` landing exactly on
the limit, and `capacity_events`/`reservations` row counts matching the successes, never the attempts.

**Delivered and reviewed.** The review ran the concurrency test five times and, separately, broke the
lock on purpose (swapped `findForCapacityChange` for `findById`) to confirm the test actually catches an
oversold limit rather than passing by construction — it does (50/50 succeed with the lock broken, 30/50
with it intact). It also found a real bug, fixed with a regression test: `execute` was calling `convert`
unconditionally, so a replay of a foreign-currency invoice failed with `FxRateNotFoundError` if that pair
had since stopped being quoted — a real scenario, since `fx_rates` holds only the current quote (§2.3).
Fixed by skipping conversion entirely on the replay path and reusing the existing reservation's own
frozen `reservedAmount`/`fxRate`, which `Program.resolveDuplicate` was already provably never comparing
against the freshly-converted amount in the first place.

Verified by hand against real Postgres, not yet automated (a known gap, not a doubt): row counts staying
at zero after a rejected `DuplicateInvoiceError`/`FxRateNotFoundError`/`ReservationNotFoundError`;
`capacity_events.actor`/`source`/`correlation_id`/`occurred_at` matching what was passed in, including a
`null` correlation id; and that a second release with a *different* reason/actor truly changes nothing
(`released_at`/`release_reason` unchanged to the millisecond). The unique-violation backstop is real —
confirmed against real Postgres with two unlocked writers racing the same key — but unreachable through
the code that ships today, since every writer of a reservation currently goes through the program lock.

### 2.5 Idempotency and reservation lifecycle

- The idempotency key is the **natural key** `(program_id, invoice_id)`, enforced by a unique
  constraint. The domain defines what a duplicate is — an invoice is financed exactly once — and the
  same rule applies to Kafka, where HTTP headers do not exist.
- A repeat with an identical payload returns `200` and the existing reservation; a different payload
  returns `409`. "Identical" is judged on the **original** amount the client sent, not the converted
  one: the rate is frozen at reservation time, so a replay hours later converts differently, and
  comparing converted amounts would turn every honest retry into a conflict.
- `release` is idempotent: an already-released reservation returns `200` with current state, so REST
  and Kafka can race safely. That idempotency lives **in the domain, as a no-op** — a repeated
  release changes nothing, produces no audit event, and keeps the first reason and timestamp. The
  alternative, throwing and having the application layer catch it to produce the `200`, would make a
  routine REST-versus-`InvoiceRepaid` race into exception-driven control flow and teach every call
  site to swallow an error that elsewhere signals a real conflict.
- States: `ACTIVE` → `RELEASED` (terminal), enforced by a state machine in the domain. Every illegal
  transition other than the repeated release raises a typed error — including correcting a released
  reservation, which reconciliation must treat as a discrepancy to flag rather than a capacity change.
- `reason: REPAID | CANCELLED` — both free capacity but mean different things for risk and audit.
- The model keeps `reservedAmount` and `releasedAmount` separately, so the **schema** is ready for
  partial releases. The **domain is not**, and says so: an active reservation must have released
  nothing, and a stored row that says otherwise is refused on the way in. Accepting a state the
  service cannot produce would mean guarding behaviour that does not exist and testing a feature
  nobody wrote — the usual way a half-supported feature leaks into production. When partial releases
  are implemented, that rule is loosened deliberately, together with their own tests and their audit
  semantics.
- Re-reserving a released invoice returns `409`.
- **Treasury's path does not replay a duplicate, and that asymmetry is deliberate.** The replay rule
  above exists because a client may legitimately retry one request. A snapshot never resends a single
  invoice: it is re-evaluated in full against current state, so an invoice arriving for a hold that
  already exists is not a retry — it means the plan was computed against a state that has since moved.
  Recording it as a hold would double the exposure, so the operation refuses and the transaction fails,
  which is the visible outcome: the message is redelivered or reaches the DLQ, and the next snapshot
  heals the state. Swallowing it as a replay would be silent.
- A general `Idempotency-Key` header mechanism is documented; implemented only if time allows.

### 2.6 Stack and layering

- NestJS + TypeScript, PostgreSQL, MikroORM, Kafka via `kafkajs`, Redpanda locally and in tests
  (Kafka-protocol compatible, single container, fast startup — swapping in MSK/Confluent is a broker
  address change).
- Versions are pinned to NestJS 11, TypeScript 5 and MikroORM 6 rather than the newest releases.
  MikroORM 7 is ESM-only: consuming it from this CommonJS toolchain fails to typecheck, and going
  full ESM breaks Jest, whose runtime cannot `require()` an ESM module — that would take the
  Testcontainers suite with it. MikroORM 6 is also the version `@mikro-orm/nestjs` targets. Moving to
  MikroORM 7 is an ESM migration, not a version bump. `@nestjs/jwt`'s current major (12.x) has the
  same problem — pinned to 11.0.2, the last CJS release.
- **The domain is plain TypeScript**, with no imports from NestJS or MikroORM. Persistence is mapped
  through `EntitySchema`, so domain classes carry no decorators and the unit of work still tracks
  them without hand-written mappers.
- MikroORM specifics to respect:
  - the Kafka consumer runs outside the HTTP request context → `em.fork()` / `@CreateRequestContext()`,
  - identity map: every capacity-changing operation starts from a fresh fork and reads the program
    with the lock,
  - `BigIntType` for amounts,
  - migrations via `@mikro-orm/migrations`, never `schema:update`. Both `path` and `pathTs` point at the
    same `__dirname`-derived directory rather than the usual `./dist` + `./src` pair: that pair relies on
    MikroORM detecting ts-node, which Jest's module registry does not trigger, so the integration harness
    would silently apply **no** migrations to a database every test assumes is migrated,
  - unique-constraint violations surface at `flush()`, not at entity creation — map them to `409`,
  - MikroORM hydrates an entity **without calling its constructor** unless `forceEntityConstructor`
    is set, so "validated at construction" is not true of a loaded row. Invariants are therefore
    re-checked inside the operations that mutate state. **Resolved in the persistence cycle: a custom
    hydrator**, which pairs each amount with its row's currency and then runs the domain's own
    `rehydrate` factory purely as a gate, discarding the validated instance so a clean row does not
    flush itself back. `forceEntityConstructor` was rejected because the constructors are bare
    assignment lists — every invariant lives in the static factories — so it would add a call and not
    one check. Living with the gap was rejected because `rehydrate` encodes rules SQL cannot state (an
    unsupported currency code, an FX rate stored under a stale `scale`), and loading past them means
    they are enforced on every path except the one production uses. An `EventSubscriber.onLoad` was
    rejected as the vehicle: it is `async`, it runs after the entity is already in the identity map, and
    `em.getReference` skips it, so it is not a funnel. Hydration is the one synchronous point every
    loaded row passes through before anything can see the instance. The hydrator also restates the
    DDL's `CHECK` constraints independently, so loosening one in a migration does not silently loosen
    the domain. The cost is that a *stored* row can no longer be half-trusted — one corrupt row makes
    its program unreadable rather than costing its own invoice a discrepancy — which is the right trade
    for a figure a funder makes credit decisions against; the per-invoice tolerance stays live where it
    was designed for, reservations assembled from a Kafka snapshot, whose data never passed through a
    column,
  - **hydration is not once per row — it is once per *change* to a row.** When an entity is already in
    the identity map, `EntityFactory.mergeData` re-hydrates it with **only the diff**, so a hydrator
    that decides what to assemble by inspecting the incoming `data` assembles nothing on a second
    read and leaves raw columns where value objects belong. The gate must therefore be a question
    about the **entity's resulting state**, never about which keys arrived. Found by review after the
    integration suite missed it entirely: every spec forks per operation, while
    `@mikro-orm/nestjs` gives one request-scoped `EntityManager` per HTTP request, so "read the
    program, then reserve against it" inside one request is exactly the unguarded shape,
  - a primary-key `findOne` **answers from the identity map without issuing a query**, which for a
    capacity read means a client can make a credit decision against a stale, overstated figure
    (§2.8). The locked read escapes that short-circuit only incidentally, because `PESSIMISTIC_WRITE`
    makes MikroORM's `isOptimisticLocking` false — which is why the unlocked reads have to ask for
    freshness explicitly rather than inheriting it. **Every** read whose port promises current state
    passes `refresh: true` — the capacity
    read and the reconciliation watermark alike; the second was missed on the first pass and cost
    nothing less than a reconciliation loop that could never terminate, because the watermark read
    stale while the locked read refreshed, so the decision and the write disagreed for ever. The
    fresh-fork discipline is a convention and conventions do not survive cycle 6,
  - **a read can write.** MikroORM's default `flushMode` is `auto`, and `findOne` flushes the unit of
    work *before* the identity-map short-circuit, so a read issued while a tracked aggregate carries
    uncommitted changes commits them on its own — a moved counter with no reservation row and no audit
    row, which is §2.4's invariant broken in committed state and, by §2.1, never healed. Hence
    `flushMode: COMMIT`. That setting is **not** free, and the two consequences are worth knowing
    because they interact:
    - `MetadataDiscovery` turns off change tracking on every scalar when `flushMode` is not `auto`, so
      nothing marks a mutated aggregate dirty as it happens. Flush-at-commit is unaffected — it
      compares snapshots — but a per-call `flushMode: AUTO` can no longer rescue anything, because the
      touch setters were never installed.
    - `refresh: true` re-registers the entity instead of merging into it, so it **discards** an
      unwritten change rather than preserving it. Under `auto` this was invisible: the read flushed
      first. The strongly consistent reads therefore flush explicitly **when they are inside a
      transaction**, where the statements join the one the caller opened; outside a transaction they do
      not, because a flush there would commit a capacity change on its own — the very thing being
      prevented.
    - The residual sharp edge, stated because it cannot currently be guarded: mutate a tracked
      aggregate *outside* a transaction and then read, and the mutation is silently discarded. §2.4
      forbids that shape outright and nothing does it, but MikroORM offers no cheap way to detect a
      dirty entity (`getPersistStack` sees only newly persisted ones; mutations need
      `computeChangeSets`, which has side effects), so a loud refusal would catch half the cases and
      mislead about the rest. It stays a documented constraint rather than a half-check.
  - **which projections are legal is API surface, not an implementation detail.** A partial select that
    asks for any of an aggregate's amounts must also select everything its assembly reads — for a
    program that is `currency` *and* `owner_org_id`; for a reservation, both currency columns and all
    six `fx_*` columns. A projection that selects no amount at all is always legal and is how the
    watermark read stays answerable for a program whose amounts cannot be hydrated. Anything in
    between is refused by name, because the alternatives are a `TypeError` from inside the domain or
    an aggregate whose getter returns a raw `bigint`,
  - aggregates that the unit of work tracks use TypeScript-`private` fields, not `#private` ones,
    because `EntitySchema` cannot see `#` fields. Value objects like `FxRate` are free to use `#`.
    Relatedly, the error classes type a reservation's status as a plain `string` rather than importing
    `ReservationStatus`: the errors file is imported *by* `reservation.ts`, so naming its types here
    would close a cycle. The looser type is the price of the dependency going one way only.
    One consequence worth knowing before cycle 6 debugs it: MikroORM's serializer skips properties
    whose name starts with `_`, so `wrap(program).toObject()` and `JSON.stringify(program)` return a
    program with **no limit, no reserved and no available**. §2.7's responses are hand-built, which is
    what keeps this harmless — returning an entity from a controller would not be.
- Kafka is consumed with `kafkajs` in a provider rather than `@EventPattern`, because offset handling
  is the point: `autoCommit: false`, commit **after** the database transaction commits, transient
  failures (no commit; Kafka redelivers) distinguished from permanent ones (DLQ, then commit), plus
  graceful shutdown.

### 2.7 API and security

Base path `/api/v1` (URI versioning).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/programs` | create a program (scope `programs:admin`) |
| `GET` | `/programs/:id/capacity` | limit, reserved, available, currency, `lastReconciledAt`, `overUtilized` |
| `GET` | `/programs/:id/capacity/stream` | SSE; emits on every capacity change |
| `POST` | `/programs/:id/reservations` | reserve → `201`; replay → `200` |
| `POST` | `/programs/:id/reservations/:invoiceId/release` | release with `reason`; idempotent |
| `GET` | `/programs/:id/reservations` | list; cursor pagination; status filter |
| `GET` | `/programs/:id/events` | audit log; cursor pagination |

Probes sit **outside** the versioned prefix, at `/health` (liveness, no dependency checks) and
`/health/ready` (readiness, checks Postgres and — from cycle 7 — the Kafka consumer). They belong to
the deployment rather than the business API, and an orchestrator should not have to track the
contract version to know whether a container is alive. Both are public, via Terminus — `@Public()` on
both handlers, checked live once `JwtAuthGuard` went global, not merely assumed from routing. A route
outside `/api/v1` is not outside a global `APP_GUARD`'s reach; the two are unrelated, and the first time
`JwtAuthGuard` was wired in, the probes silently started 401ing. Any future global guard addition needs
the same check against this section's public-routes list — it is not automatic.

- `reserve` and `release` are POSTs on action sub-resources: they are domain operations with business
  rules, not field edits. A deliberate departure from strict REST, stated in the README.
- Errors follow RFC 7807 (`application/problem+json`) with `code` and `traceId`: `409` insufficient
  capacity or state conflict, `422` missing FX rate, `404` unknown program **or no access**, `400`
  validation.
- Auth: a global `JwtAuthGuard` (`APP_GUARD`) with an explicit `@Public()` opt-out. Claims: `sub`,
  `org`, `scope`, `exp`, `iss`, `aud`. `@Scopes('capacity:write')` plus an ownership check
  (`program.ownerOrgId === user.org`); unauthorized access returns `404` so the resource's existence
  is not disclosed, covered by an integration test.
- HS256 with a secret from the environment (no secret → the app refuses to start); RS256/JWKS noted
  as the production choice. A development-only `POST /auth/token` endpoint (disabled in production)
  and ready-made examples in `requests.http` keep the service trivially runnable.
- `helmet`, configurable CORS, `@nestjs/throttler`, and logs free of tokens and PII.
- Kafka traffic does not pass through HTTP auth; mTLS/SASL is the production answer.

**Block 4's exact contract**, so it can be built without re-deciding any of this mid-flight. `/capacity/stream` (SSE) is block 6's, not block 4's — everything else in the table above is.

*Claims and tokens.* `iss`/`aud` are fixed constants (`program-capacity` / `program-capacity-api`), not configurable — this is one service with no federation, and a constant documents the intent as clearly as an env var would. `scope` is a space-separated string, OAuth2-style. `@nestjs/jwt` (wraps `jsonwebtoken`) does the signing/verification; no passport, since there is no strategy plugging in beyond "verify one HS256 token" and passport's boilerplate buys nothing here. `JWT_SECRET`'s minimum length is already enforced by `Env` validation at startup (§0), so "no secret → refuses to start" needs no new code.

*`JwtAuthGuard`* is global (`APP_GUARD`) and does both jobs in one guard rather than two, to avoid reading the reflector twice: `@Public()` (`SetMetadata('isPublic', true)`) bypasses it entirely; otherwise it extracts `Authorization: Bearer <token>`, verifies via `JwtService.verifyAsync` with `algorithms: ['HS256']` and the fixed issuer/audience, attaches the payload to `request.user`, then checks `@Scopes(...)` (`SetMetadata('scopes', scopes)`) against `user.scope.split(' ')`. Missing/invalid/expired token → `401`; token valid but missing a required scope → `403`.

*Ownership* is a separate, per-route guard (`ProgramOwnershipGuard`), applied after `JwtAuthGuard` so `request.user` already exists. It reads `:id` from the route, does one unlocked read (`ProgramRepository.findById`, off the request-scoped `EntityManager` — a plain read needs no `TransactionRunner`), and throws `NotFoundException` for **both** "no such program" and "`ownerOrgId !== user.org`" — one branch, one status, so the two cases are genuinely indistinguishable to a caller, not just documented as if they were.

*The dev token endpoint*, `POST /auth/token`, is `@Public()`, refuses with `404` when `NODE_ENV === 'production'` (checked in the handler, not by conditionally registering the module — simpler, and the 404 is consistent with "this route does not exist here"), and signs whatever `{ sub, org, scope }` the body states with a 1-hour expiry. It is a development convenience, not a security boundary, and says so nowhere near an audit log.

*RFC 7807.* One global exception filter, one place holding the `code → HTTP status` map:
- `409`: `INSUFFICIENT_CAPACITY`, `DUPLICATE_INVOICE`, `DUPLICATE_PROGRAM` (a client-supplied `id` taken by a concurrent `POST /programs`, the same backstop `ReserveInvoiceUseCase` has for its natural key), `RESERVATION_STATE_CONFLICT`.
- `404`: `PROGRAM_NOT_FOUND`, `RESERVATION_NOT_FOUND` (plus whatever `ProgramOwnershipGuard`/Nest's own routing already produce).
- `422`: `FX_RATE_NOT_FOUND`.
- `400`: `UNKNOWN_CURRENCY`, `INVALID_AMOUNT`, `INVALID_CREDIT_LIMIT` (`Money.fromDecimalString`'s grammar accepts a negative decimal string, so a negative `creditLimit` on `POST /programs` reaches `Program.create`'s own check — a client mistake, not corruption), `INVALID_CURSOR` (a page cursor that doesn't decode to a usable position — the repository's own last line of defense, since a client can hand-edit a URL's opaque `after` value in a way no DTO shape check would catch), class-validator's own `BadRequestException`.
- Every other `DomainError` (`CapacityInvariantError`, `MissingAuditContextError`, `InvalidReservationError`, `InvalidProgramError`, `InvalidFxRateError`, `CurrencyMismatchError`, `RESERVATION_PROGRAM_MISMATCH`, `IncompleteProjectionError`) is corruption or a programmer error, not a client mistake: `500`, with the `code` still in the body (it names a fault, not a stack trace) but a generic `detail`.
- A non-positive page `limit` stays a bare `RangeError` at the repository, matching the convention `CapacityEventLog.findByProgram` already established — the controller's own DTO validation (`@Min(1)`) is what stops a client reaching it over HTTP, so it needs no `DomainError`/status-map entry of its own.
- Nest's own `HttpException`s (from the guards, from `ValidationPipe`) keep their own status.
- Anything else: `500`, `code: 'INTERNAL_ERROR'`.
- Every response: `type`, `title`, `status`, `detail`, `code`, `traceId` — `traceId` from a per-request id (a small middleware, `x-request-id` if the caller sent one, `crypto.randomUUID()` otherwise), `content-type: application/problem+json`.

*The reservation listing endpoint resolves cycle 4's deferred cursor decision.* `listByProgram` was deliberately left off `ReservationRepository`'s port because "newest first" and an `invoiceId` cursor were shown to contradict each other with no index to serve either. Decided now: order by `reservedAt` with `invoiceId` as the tie-break (two invoices funded in the same transaction share an instant), a new migration adding `(program_id, reserved_at, invoice_id)`, and an opaque base64 cursor encoding both. The method returns to the port, implemented for real.

*`GET /capacity`* is a thin read: `findById` (already promises fresh, committed state) plus `findWatermark` for `lastReconciledAt`, mapped to the response shape the table already names. *`GET /events`* wires DTOs around `CapacityEventLog.findByProgram`, whose cursor already works (cycle 4). *`POST /programs`* validates a DTO, calls `Program.create`, persists through the same `TransactionRunner` the other two use cases already use — no new port.

*DTOs* validate shape (non-empty strings, `reason` in `['REPAID','CANCELLED']`) with class-validator; they do **not** re-validate what `Money.fromDecimalString`/`parseCurrencyCode` already check, so a malformed amount or an unsupported currency still surfaces as the domain's own `400`, through the same filter, not a second, looser check in the DTO.

*Swagger* stays light — `@ApiTags`/`@ApiOperation`/`@ApiResponse` on what exists, no schema essay per field. `helmet`, CORS and `@nestjs/throttler` are a few lines in `main.ts`; include them, they cost little and the plan already promises them.

*e2e (`supertest`, `test/e2e/`)*: 401 with no token, 403 with the wrong scope, 404 for another tenant's program (via `ProgramOwnershipGuard`, not a 403), the RFC 7807 shape itself, a paginated round trip for both listing endpoints, and the full reserve → release happy path through a real signed token.

**Second half of block 4: wiring the controllers on top of the infrastructure above**, all of which now exists (`d67b444`…`639c915`) and is deliberately not yet imported anywhere.

*Controllers.* One `ProgramsController` (`@Controller('programs')`) rather than one per sub-resource — the nesting is all under `/programs/:id`, and splitting it would scatter one resource's routes across files for no reader's benefit. `@UseGuards(ProgramOwnershipGuard)` on every method **except** `create` (there is no `:id` yet to own); `create` instead carries `@Scopes('programs:admin')` on its own. `actor` comes from `request.user.sub`, never from the request body; `correlationId` from an `X-Correlation-Id` header if present, else `null`.

- `POST /programs` → a small `CreateProgramUseCase` (same DI shape as the other two: `TransactionRunner` + nothing else, since a new program needs no clock) calling `Program.create` then `repos.programs.add`. `201`.
- `GET /:id/capacity` → a `CapacityQueryService` (constructed off the injected, request-scoped `EntityManager`, same pattern `ProgramOwnershipGuard` already uses — a plain unlocked read needs no `TransactionRunner`) wrapping `findById` + `findWatermark`.
- `POST /:id/reservations` → `ReserveInvoiceUseCase`. `201` on `CREATED`, `200` on `REPLAYED` — same body either way.
- `GET /:id/reservations` → `CapacityQueryService.listReservations`, wrapping the now-real `listByProgram`.
- `POST /:id/reservations/:invoiceId/release` → `ReleaseReservationUseCase`. Always `200`.
- `GET /:id/events` → `CapacityQueryService.listEvents`, wrapping `CapacityEventLog.findByProgram`. Its cursor and `id` are `bigint`; the wire form is a decimal string in both the query param and the response, converted at the DTO boundary — never a JS `number`, for the reason §2.2/§2.6 already give for every other 64-bit figure in this service.

*DTOs* validate shape only, per the standing rule: `CreateProgramDto`, `ReserveInvoiceDto { invoiceId, amount, currency }`, `ReleaseReservationDto { reason: 'REPAID' | 'CANCELLED' }`, `ListReservationsQueryDto { limit?, after?, status? }`, `ListEventsQueryDto { limit?, after? }` (query params arrive as strings; `class-transformer` converts `limit` to a number and leaves `after` a string, decoded/widened where each repository's method expects it). Response DTOs mirror §2.3's public-API shape: every amount a decimal string paired with its currency, never minor units, never a `Money` instance leaking out.

*`AppModule` wiring*, all at once now that every piece is real: `AuthModule` imported; `APP_GUARD` providers in order `ThrottlerGuard` then `JwtAuthGuard` (rate-limit before spending any verification effort on a request that was never going to be let through); `APP_FILTER: ProblemDetailsFilter`; `RequestIdMiddleware` applied to every route in `AppModule.configure`. `main.ts` gains `helmet()`, `enableCors()` (configurable origin from `Env`), `@nestjs/throttler`'s module registration, and Swagger (`DocumentBuilder` with `addBearerAuth()`, mounted at `/docs`, light decoration only — `@ApiTags`/`@ApiOperation`/`@ApiResponse`, no per-field essay).

*What stays out*: `/capacity/stream` (SSE, block 6), Kafka-anything (block 5/8), metrics (block 6). `requests.http` with ready-made examples is block 7's (docs), not built here, though nothing stops writing a first draft once the routes are real.

### 2.8 Real-time reads, audit trail, observability

- "Real time" means **strongly consistent reads**, not caching. `GET /capacity` is a primary-key read
  thanks to the denormalized counter. Caching availability would be an anti-pattern here: a client
  could make a credit decision against a stale, overstated figure.
- SSE streams are held in process memory, authorized exactly like the equivalent GET, with a ~15s
  heartbeat. The multi-replica limitation (cross-instance broadcast required) is documented.
- **`capacity_events`** is an append-only log written in the same transaction as the change it
  records: `type` (`RESERVED`, `RELEASED`, `LIMIT_CHANGED`, `RECONCILIATION_APPLIED`,
  `RECONCILIATION_ADJUSTMENT`, `DISCREPANCY_FLAGGED`), `invoice_id`, `delta`, `resulting_reserved`,
  `actor` (JWT subject or `treasury:kafka`), `source`, `correlation_id`, `occurred_at`, and
  `metadata` (jsonb: FX rate, snapshot `sequence`, reason). It answers "why did available capacity
  drop by 1.8M at 10:32?". This is not event sourcing — state is stored directly for fast reads — but
  the log can reconstruct and verify it.
- Append-only is enforced by a `BEFORE UPDATE OR DELETE` trigger, not by `REVOKE`. The local stack and
  the test harness connect as the table's owner, whose privileges a `REVOKE` would not constrain, so the
  grant-based version would look like a guarantee and be none. `TRUNCATE` is deliberately left ungated:
  it is how the integration suite isolates tests, and it cannot be reached by the application's own
  statements.
- `delta` means one thing only: **the change to the reserved total**. It is therefore zero for
  `LIMIT_CHANGED`, whose before and after values go to `metadata`. Letting one column carry two
  different quantities would break the `SUM(delta) == reserved_amount` invariant §2.4 relies on.
- `source` is `API`, `TREASURY_SNAPSHOT` or `TREASURY_EVENT`.
- Discrepancies are **upserted**, not appended: one row per `(program, invoice, reason)` with
  `first_seen` and `last_seen`, and a `DISCREPANCY_FLAGGED` event only when one appears or clears.
  Reconciliation re-derives every unresolved discrepancy from scratch on each snapshot, so appending
  would write a row a minute per unresolved invoice and leave
  `treasury_reconciliation_discrepancies_total` measuring snapshot cadence instead of the number of
  problems — while the alerting below reads it as the latter.
- The domain **produces** the event as the return value of every capacity-changing operation, so a
  call site cannot change capacity and forget the log. What the domain cannot honestly know — actor,
  source, correlation id and the clock — is passed in, and an operation refuses to run without it.
  A no-op (replayed reservation, repeated release, correction to the amount already held) returns no
  event: the log records changes, not the absence of one.
- `nestjs-pino` (JSON logs, `correlationId` from `x-request-id` or the Kafka header, redaction),
  Terminus (liveness without dependencies; readiness covering Postgres and the consumer), and
  `/metrics` via `prom-client` with **business** metrics: `capacity_reservations_total{result}`,
  `capacity_utilization_ratio`, `treasury_snapshot_lag_seconds`,
  `treasury_reconciliation_discrepancies_total`, `kafka_messages_total{type,result}`, `kafka_dlq_total`.
- The README includes what would be alerted on: snapshot lag > 2h, rising DLQ volume, utilization
  > 0.95, any `overUtilized` program.
- OpenTelemetry: noted as the next step, not implemented.

### 2.9 Programs and invoices

- Programs are created through an admin API; treasury updates the limit. A snapshot for an unknown
  program produces a discrepancy and goes to the DLQ — a closed set of identifiers, with no programs
  conjured from a typo. A program exists because a commercial agreement exists, not because a message
  referenced it.
- Seed data: 2–3 programs (USD, EUR, and one close to exhaustion so rejection is easy to demonstrate).
  The seed is idempotent, and it is guarded, because its damage cannot be undone: it writes four
  `capacity_events` rows, and `capacity_events` refuses `DELETE`, so a `DATABASE_URL` pointed at the
  wrong environment leaves `actor = 'seed'` entries in a real program's audit log permanently.
  The **structural** barrier is that the seed cannot run from the production image at all — it is a
  `ts-node` entry point over `src/`, and the runtime stage ships neither. What the guard adds is
  protection against the case that barrier does not cover: a developer running `npm run seed` locally
  with a `DATABASE_URL` that is not local. `NODE_ENV` is the wrong signal for that — the local stack
  deliberately runs `NODE_ENV=production` to exercise the production build, so the check would block
  the one environment that is supposed to seed while a developer's shell, where the accident happens,
  usually has no `NODE_ENV` set at all. The guard is therefore an **explicit opt-in**: the seed refuses
  unless it is told, in as many words, that this database may be seeded. Concretely it proceeds when
  `SEED_ALLOW=1`, or when the `DATABASE_URL` host is loopback (`localhost`, `::1`, `127.*`) or the
  compose service name `postgres` — the cases that are a local database by construction. Everything
  else refuses and names the variable to set, so the remote case is reachable but never accidental.
  This is a guard against a mistake and not a security control, and the refusal says so.
  The two seeded FX directions are deliberately **not** exact inverses of each other (0.9235 and
  1.0828): real quotes carry a spread, and a seed whose directions inverted cleanly would let a bug that
  divides by a rate instead of looking up its own direction pass every test.
- **Invoice details are not stored** — only `invoiceId`, amount and currency. Everything else belongs
  to the invoicing service.
- `invoiceId` is unique within a program, not globally: clients should not have to encode program
  identity into their own identifiers.

### 2.10 Testing and delivery

- Jest with `@swc/jest`. Weight sits in the middle of the pyramid:
  1. **unit** (no I/O): `Money`, availability rules, rounding, the state machine, and
     **reconciliation as a pure function** (state + snapshot → decisions) driven by table tests;
  2. **integration on Testcontainers** (Postgres + Redpanda) — the core: the concurrency test
     (50 parallel reservations, exact success count, invariant intact), idempotency, a REST `release`
     racing `InvoiceRepaid`, stale snapshots ignored, in-flight reservations surviving a snapshot,
     discrepancies recorded, and a poison message reaching the DLQ without stalling the partition;
  3. **e2e** (`supertest`): 401 without a token, 404 for another tenant's program, error format,
     pagination.
  Containers start once per run (`globalSetup`), isolation via `TRUNCATE`, factories instead of JSON
  fixtures. Mocking the repository would defeat the purpose here — the difficulty lives in the database.
- `docker compose up` brings up postgres and redpanda (with health checks), a one-shot `migrate`
  container (migrations + seed) and the API after it. Multi-stage Dockerfile on `node:22-alpine`,
  production dependencies only, non-root user, `tini` so signals reach the process and the consumer
  shuts down gracefully.
- `.env.example`, config validated at startup (fail fast), and scripts: `dev`, `test`,
  `test:integration`, `migration:up`, `seed`, `seed:treasury` (publishes a sample snapshot and an
  `InvoiceRepaid`).
- `requests.http` covering token, reserve, replay (idempotency), release, over-limit reserve, and the
  capacity read.
- GitHub Actions: lint → typecheck → unit → integration (Testcontainers) → docker build, plus
  `npm audit --audit-level=high`.
- A clean-clone check (`git clone` → one command → running service) before calling it done.

---

## 3. Repository layout

```
src/
  main.ts  app.module.ts          # composition root
  capacity/                       # core: programs, reservations, availability
    domain/                       # plain TS: program.ts, reservation.ts, money.ts, errors.ts
    application/                  # reserve/release/get-capacity (transactions, locking)
    infrastructure/persistence/   # EntitySchema, repositories, migrations/
    infrastructure/http/          # controllers, DTOs
  treasury-sync/
    domain/reconcile-program.ts   # pure function: state + snapshot → decisions
    application/                  # apply-snapshot, handle-invoice-repaid
    infrastructure/               # kafka-consumer, messages (validation + ACL), dlq.publisher
  fx/                             # FX rate port and provider
  auth/                           # JWT strategy, guards, decorators
  shared/
    config/                       # env schema, typed config service
    database/                     # MikroORM options + CLI config
    health/                       # Terminus probes
                                  # later: exception filter, logger, metrics
test/integration/  test/e2e/
docs/ASSUMPTIONS.md  docs/ARCHITECTURE.md
```

The `capacity` ↔ `treasury-sync` boundary separates real-time decisioning from alignment with the
outside world; these are the natural split points if the modules ever become separate services, with
`capacity` owning the data. **`treasury-sync` never writes to `capacity` tables directly** — it calls
its use cases, so locking and audit stay in one place.

Packaging is feature-first: a change to one capability touches one folder instead of being spread
across `controllers/`, `services/` and `entities/`. Layer-first packaging was the alternative and was
settled against at the skeleton stage, while the change was still cheap.

---

## 4. Plan of work

| # | Block | Time | Contents |
|---|---|---|---|
| 0 | Skeleton | 0:45 | Nest + MikroORM + validated config, docker-compose, Dockerfile, `.env.example`, health. Commit when `docker compose up` works |
| 1 | Domain | 1:00 | `Money`, `Program`, `Reservation`, `reconcile-program`, domain errors + unit tests |
| 2 | Persistence | 0:45 | `EntitySchema`, migrations, repositories, `capacity_events`, seed |
| 3 | Reserve/release | 1:15 | Transactions + `PESSIMISTIC_WRITE`, idempotency, audit, **concurrency test** |
| 4 | API | 1:00 | Controllers, DTOs, RFC 7807, pagination, auth, Swagger, e2e |
| 5 | Kafka | 1:30 | Consumer, message schemas, three message types, sequencing, DLQ, integration tests, `seed:treasury` |
| 6 | SSE and metrics | 0:30 | `@Sse()`, pino, `/metrics` |
| 7 | Docs and CI | 1:00 | README, ASSUMPTIONS, ARCHITECTURE, `requests.http`, Actions, clean-clone check |

The order is deliberate: the hardest and most important parts (domain, concurrency) come first, so
anything that slips is documentation and polish rather than the core. One commit per block.

Scope takes priority over the time estimate; realistically this is closer to 9–10 hours including
documentation.

Risks:
1. Block 5 is the least familiar ground. Fallback: consumer without Testcontainers, with
   reconciliation covered purely at the domain-function level.
2. Testcontainers pulls images on first run — pull them in the background early.

Progress: blocks 0–2 are committed, with 924 unit tests and 185 integration tests. Blocks 1 and 2 each
took a review pass that found real defects — the estimates above were honest about the work and wrong
about the verification, which is where most of the time actually went.

---

## 5. Deliberately out of scope (documented as trade-offs)

GraphQL, gRPC, Kubernetes, the outbox pattern (this service only consumes events), full event
sourcing, a general `Idempotency-Key` mechanism, FX mark-to-market, FX haircut, reservation expiry,
partial releases (the model is ready for them), chunked snapshots and claim-check, OpenTelemetry,
a real FX rate provider, RS256/JWKS, and splitting the API and consumer into separate deployments.
