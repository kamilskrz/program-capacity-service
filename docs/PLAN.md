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
| `sequence` <= last applied | ignore the snapshot |
| Checksums do not match | reject the whole snapshot |

**Governing rule: when in doubt, hold the capacity — never release it.** A snapshot may add or
correct a hold, but never releases one based on *absent* data; a treasury-side bug (an empty list)
would otherwise free the entire limit. The cost is that a lost `InvoiceRepaid` keeps capacity held
until someone resolves it — an error in the safe direction.

Reconciliation **may** drive `available` below zero (e.g. a reduced limit). The state is then stored,
the program is marked `overUtilized`, new reservations are rejected and releases still work. The
consumer must not crash on this.

### 2.2 Kafka messages

One topic, `treasury.program-events`, keyed by `programId` (ordering within a partition), with three
message types:

- `ProgramSnapshot` — full state: `sequence`, `asOf`, `creditLimit`, outstanding invoices (id, amount
  in program currency plus the original, status), `outstandingTotal`, `invoiceCount`
- `ProgramLimitChanged` — new limit
- `InvoiceRepaid` — treasury observed a repayment, so the reservation is released

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
  `BIGINT` in the database, `bigint` in TypeScript, **strings in JSON** to protect JS clients from
  precision loss. A `Money` value object carries this.
- A reservation stores the original amount, the FX rate used (with source and timestamp) and the
  amount in program currency, **rounded up**.
- **The rate is frozen at reservation time.** A release frees exactly the stored amount and never
  re-converts; re-converting makes the limit drift over thousands of invoices.
- Drift against the market is corrected by treasury snapshots (effectively their mark-to-market).
  A correction updates the held amount and writes an audit entry; a later release frees the
  corrected amount.
- FX rates come through an `FxRateProvider` port backed by a seeded database table. A missing rate
  for a currency pair yields `422` rather than a guess.
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

### 2.5 Idempotency and reservation lifecycle

- The idempotency key is the **natural key** `(program_id, invoice_id)`, enforced by a unique
  constraint. The domain defines what a duplicate is — an invoice is financed exactly once — and the
  same rule applies to Kafka, where HTTP headers do not exist.
- A repeat with an identical payload returns `200` and the existing reservation; a different payload
  returns `409`.
- `release` is idempotent: an already-released reservation returns `200` with current state, so REST
  and Kafka can race safely.
- States: `ACTIVE` → `RELEASED` (terminal), enforced by a state machine in the domain.
- `reason: REPAID | CANCELLED` — both free capacity but mean different things for risk and audit.
- The model keeps `reservedAmount` and `releasedAmount` (today either 0 or the full amount), so
  **partial releases are a natural extension**.
- Re-reserving a released invoice returns `409`.
- A general `Idempotency-Key` header mechanism is documented; implemented only if time allows.

### 2.6 Stack and layering

- NestJS + TypeScript, PostgreSQL, MikroORM, Kafka via `kafkajs`, Redpanda locally and in tests
  (Kafka-protocol compatible, single container, fast startup — swapping in MSK/Confluent is a broker
  address change).
- Versions are pinned to NestJS 11, TypeScript 5 and MikroORM 6 rather than the newest releases.
  MikroORM 7 is ESM-only: consuming it from this CommonJS toolchain fails to typecheck, and going
  full ESM breaks Jest, whose runtime cannot `require()` an ESM module — that would take the
  Testcontainers suite with it. MikroORM 6 is also the version `@mikro-orm/nestjs` targets. Moving to
  MikroORM 7 is an ESM migration, not a version bump.
- **The domain is plain TypeScript**, with no imports from NestJS or MikroORM. Persistence is mapped
  through `EntitySchema`, so domain classes carry no decorators and the unit of work still tracks
  them without hand-written mappers.
- MikroORM specifics to respect:
  - the Kafka consumer runs outside the HTTP request context → `em.fork()` / `@CreateRequestContext()`,
  - identity map: every capacity-changing operation starts from a fresh fork and reads the program
    with the lock,
  - `BigIntType` for amounts,
  - migrations via `@mikro-orm/migrations`, never `schema:update`,
  - unique-constraint violations surface at `flush()`, not at entity creation — map them to `409`.
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
contract version to know whether a container is alive. Both are public, via Terminus.

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

---

## 5. Deliberately out of scope (documented as trade-offs)

GraphQL, gRPC, Kubernetes, the outbox pattern (this service only consumes events), full event
sourcing, a general `Idempotency-Key` mechanism, FX mark-to-market, FX haircut, reservation expiry,
partial releases (the model is ready for them), chunked snapshots and claim-check, OpenTelemetry,
a real FX rate provider, RS256/JWKS, and splitting the API and consumer into separate deployments.
