# Program Capacity & Invoice Reservation

A service that tracks how much of a financing program's credit limit is currently committed, and
decides — under concurrency — whether one more invoice can be funded against it.

An invoice approved for early payment reserves capacity; a repayment releases it. Capacity also moves
without anyone calling this service: treasury publishes snapshots and events to Kafka, and the two
views have to be reconciled without either double-counting exposure or inventing it.

```bash
docker compose up          # Postgres, Redpanda, migrations, API
npm run seed               # three demo programs
```

Then open `requests.http`, or:

```bash
curl -s localhost:3000/api/v1/auth/token -H 'content-type: application/json' \
  -d '{"sub":"analyst-1","org":"org-northwind","scope":"capacity:write programs:admin"}'
```

---

## What the hard part actually is

Three things in this brief can silently produce a wrong number, and everything below is arranged
around them.

**Two requests can oversell a limit.** Read-then-write on a shared counter is a lost update. Every
capacity change — REST, snapshot, repayment — goes through one `SELECT … FOR UPDATE` on the program
row inside one transaction: lock, read, decide in the pure domain, write the reservation, the counter
and the audit row, commit. One mechanism, not one per entry point. A test fires 50 concurrent reserves
at a limit that fits exactly 30 and asserts the count, the final counter and the invariant; breaking
the lock on purpose makes all 50 succeed, which is how that test is known to be worth having.

**Money in floats is wrong money.** Amounts are `bigint` minor units with an ISO 4217 code, `BIGINT`
in Postgres, never a float at any stage, and never a `number` — which stops being exact at 2⁵³, below
the largest limit a program can plausibly carry. Currencies do not all have two decimals (JPY has 0,
KWD 3), so "minor unit" is looked up, never assumed. FX rates are scaled integers, directional, and
never inverted: a EUR/USD quote does not answer a USD/EUR question, because 1/1.0987 is not
representable. The rate that converted an invoice is frozen on the reservation, so a release frees
exactly what was held rather than what today's rate would say.

**Treasury and this service see the same invoices, not two separate pools.** Modelling them as
separate pools was the first thing considered and rejected — it double-counts exposure. Reconciliation
is a pure function from (program state, snapshot) to a plan of steps plus discrepancies, which makes
the rules testable without a database. Its governing rule: **when in doubt, hold the capacity, never
release it.** A snapshot may add or correct a hold, but never releases one on *absent* data — a
treasury-side bug that published an empty list would otherwise free every limit at once.

---

## Running it

| | |
|---|---|
| `docker compose up` | Postgres + Redpanda + migrations + API on :3000 |
| `npm run seed` | three demo programs (one with head-room, one nearly exhausted, one EUR) |
| `npm run seed:treasury` | publishes a sample snapshot and an `InvoiceRepaid` |
| `npm run dev` | watch mode against a local `.env` |
| `npm test` | 1096 unit tests, no I/O, ~1s |
| `npm run test:integration` | 227 tests against real Postgres and Redpanda via Testcontainers |
| `npm run lint` / `npm run typecheck` | both clean, both enforced in CI |

`npm run seed` and `npm run seed:treasury` refuse a non-local database or broker unless
`SEED_ALLOW=1`: the seed writes `capacity_events` rows, and that table refuses `DELETE`, so seeding
the wrong environment cannot be undone.

Docker is required for the integration tests. Everything else runs from a clean clone with
`npm ci`.

---

## The API

Base path `/api/v1`. Every route needs a bearer token; `/health`, `/health/ready` and `/metrics` do
not, because an orchestrator and a scraper carry none.

| Method | Path | |
|---|---|---|
| `POST` | `/programs` | create a program (`programs:admin`) |
| `GET` | `/programs/:id/capacity` | limit, reserved, available, currency, `overUtilized` |
| `GET` | `/programs/:id/capacity/stream` | SSE; the current figure, then one event per change |
| `POST` | `/programs/:id/reservations` | reserve → `201`; identical replay → `200` |
| `POST` | `/programs/:id/reservations/:invoiceId/release` | idempotent |
| `GET` | `/programs/:id/reservations` | cursor pagination, status filter |
| `GET` | `/programs/:id/events` | the audit log, cursor pagination |

Swagger at `/docs`. Errors are RFC 7807 (`application/problem+json`) with a `code` and a `traceId`
that matches the log line for that request — send an `X-Request-Id` and it is used as both.

**Auth.** HS256, claims `sub`/`org`/`scope`, a global guard with an explicit `@Public()` opt-out.
Scopes are checked as an exact set, and ownership (`program.ownerOrgId === user.org`) separately —
a program belonging to another organisation answers **404**, the same status and the same body as one
that does not exist, so the API does not disclose which it was. RS256/JWKS is the production answer;
the dev-only `POST /auth/token` mints tokens locally and returns 404 in production.

**Idempotency** is the natural key `(program_id, invoice_id)`, enforced by a unique constraint rather
than a header, because the same rule has to hold for Kafka, where HTTP headers do not exist. A replay
is judged on the **original** amount the client sent, never the converted one: the rate is frozen, so
comparing converted amounts would turn every honest retry hours later into a conflict.

---

## How it is put together

```
capacity/        domain/          plain TypeScript — Money, Program, Reservation. No Nest, no ORM.
                 application/     use cases: lock, call the domain, persist. They decide nothing.
                 infrastructure/  EntitySchema mappings, repositories, controllers, DTOs
treasury-sync/   domain/          reconcile-program.ts: (state, snapshot) → plan. Pure.
                 application/     applying that plan, and the discrepancy state machine
                 infrastructure/  the kafkajs consumer, message DTOs, the DLQ
fx/  auth/  shared/
```

The domain holds the rules and returns its own audit event, so a call site cannot change capacity and
forget the log. A no-op — a replayed reservation, a repeated release — returns no event, because the
log records changes, not the absence of one. What the domain cannot honestly know (who, over what
transport, at what time) is passed in, and an operation refuses to run without it.

`treasury-sync` never writes to `capacity`'s tables directly; it goes through the same locking and the
same audit path as everything else.

Full reasoning, including what was rejected and why, is in [`docs/PLAN.md`](docs/PLAN.md) — written
before the code and amended as the code taught us things. Assumptions are in
[`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md), the layering in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Kafka

One topic, `treasury.program-events`, keyed by `programId` so one program's messages stay ordered.
Three message types: a full-state `ProgramSnapshot`, `ProgramLimitChanged`, `InvoiceRepaid`.
Incremental events carry **state, not deltas** (`status = REPAID`, not `-100k`), which makes them
idempotent and tolerant of loss — the next snapshot heals whatever a lost message missed.

Consumed with `kafkajs` directly rather than a Nest transport, because offset handling is the point:
`autoCommit: false`, and the offset moves only after the database transaction that applied the message
has committed. A **transient** failure leaves the offset alone so Kafka redelivers; a **permanent**
one goes to `treasury.program-events.dlq` and is committed, so one poison message cannot stall the
partition behind it.

The permanent set is closed and explicit — malformed JSON, an unrecognised type, a validation failure,
a rejected snapshot, an unknown program. **Everything else defaults to transient**, including an
exception nobody anticipated: a message retrying forever is recoverable, a message silently
dead-lettered is a quietly dropped snapshot.

---

## Observability

`/metrics` exposes the figures worth alerting on: `capacity_reservations_total{result}`,
`capacity_utilization_ratio`, `treasury_snapshot_lag_seconds`,
`treasury_reconciliation_discrepancies_total`, `kafka_messages_total{type,result}`, `kafka_dlq_total`.

Worth alerting on: snapshot lag over 2h (treasury has gone quiet), rising DLQ volume (the producer's
format drifted), utilization above 0.95, and any `overUtilized` program (exposure exceeds the limit —
always the result of a snapshot, never of this service accepting a reservation).

Logs are JSON via `nestjs-pino`, with the request id as the correlation id and `authorization`
redacted.

---

## What is deliberately not here

Partial releases (the schema is ready, the domain refuses them rather than half-supporting them),
a general `Idempotency-Key` header, chunked snapshots and the claim-check pattern, FX haircut and
mark-to-market, reservation expiry, OpenTelemetry, RS256/JWKS, a real FX provider, and splitting the
API and the consumer into separate deployments. Each is a decision rather than an omission; the
reasoning is in `docs/PLAN.md` §5.

The SSE stream is held in process memory, so it is **single-replica**: a change applied by one
instance does not reach a stream held by another. Fixing it needs a broadcast the streams subscribe to
(Postgres `LISTEN/NOTIFY`, or the Kafka topic this service already consumes) — named, not built.
