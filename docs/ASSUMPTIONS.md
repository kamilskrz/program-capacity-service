# Assumptions

What the brief left open, and what this service decided instead. Each of these is a place a real
project would ask treasury or the product owner rather than choose alone.

## The Kafka message format

The brief says capacity data flows in from treasury over Kafka, including periodic bulk
reconciliation messages, but does not specify a format. This service defines one (`docs/PLAN.md` §2.2)
and treats it as an interface to negotiate, not a fact:

- **One topic**, `treasury.program-events`, keyed by `programId`, so one program's messages are
  ordered with respect to each other. Three types on it, discriminated by a `type` field.
- **A snapshot carries full state**, not a delta: `sequence`, `asOf`, `creditLimit`, and every
  outstanding invoice with the rate that priced it. This is what makes a lost message survivable.
- **Two checksum pairs**, one over the outstanding entries and one over the repaid ones. Covering only
  the outstanding entries would leave the release path — the only path that *frees* capacity — with no
  integrity check at all, so a single fabricated `REPAID` entry could free a whole hold while the
  checksums agreed precisely because they ignored it.
- **`asOf` is assumed to move forward with `sequence`.** The watermark enforces the sequence half; the
  clock half is the producer's responsibility. A snapshot whose `asOf` went backwards would drag
  `lastReconciledAt` back with it. Checking it would mean carrying the previous `asOf` into the
  decision, which is deliberately not done — stated here rather than papered over.
- **A snapshot lists only outstanding invoices**, so its size is bounded by the limit (~200 entries at
  50k average). The pathological case — 10,000 small invoices, ~1.5 MB — exceeds Kafka's default 1 MB
  message limit. Chunked snapshots and the claim-check pattern are the remedy; neither is built.

If treasury's real format differs, the anti-corruption layer (`infrastructure/messages/`) is the only
thing that changes: it validates the wire shape and maps it to the domain's own types, so a format
change never reaches a business rule.

## Currency and FX

- **A program has one currency**; invoices may be in others. An invoice in a third currency is
  converted into the program's at reservation time and the rate is **frozen** on the reservation.
- **Conversion rounds up.** A consequence worth stating before it is diagnosed as a bug: a producer
  that rounds *to nearest* will disagree with this service by one minor unit on roughly half of its
  converted invoices, and a snapshot entry whose own rate does not reproduce its own amount is flagged
  `INCONSISTENT_FX_EVIDENCE`. That is the check working. If it turns out to be routine in practice,
  the fix is an agreed tolerance of one minor unit, negotiated with treasury and applied in one place
   — not a loosened check.
- **Rates come from a seeded table**, not a market feed. A missing pair is a `422`, never a guess.
- **FX risk itself belongs to treasury.** This service moves no money; it measures exposure against a
  limit.

## Identity and tenancy

- **Programs are a closed set.** They are created through an admin API, never conjured by a message
  referencing an unknown id — a program exists because a commercial agreement exists. A snapshot for
  an unknown program is a dead-letter case.
- **`invoiceId` is unique within a program, not globally.** Clients should not have to encode program
  identity into their own identifiers.
- **One organisation owns a program**, matched against the token's `org` claim. Multi-org access,
  roles beyond scopes, and delegated access are out of scope.
- **Invoice details are not stored** — only the id, the amount and the currency. Everything else
  belongs to the invoicing service.

## Operational shape

- **The API and the Kafka consumer are one process**, as `docker-compose.yml` runs them. Splitting them
  is a deployment change, not a code change; the module boundary is already there.
- **One replica.** The SSE stream is in process memory and does not cross instances. Everything else
  — the row lock, the idempotency key, the watermark — is correct under multiple replicas already.
- **HS256 with a shared secret**, because the brief has no identity provider. RS256/JWKS is the
  production answer, and the guard is the only thing that would change.
- **`treasury:kafka` is the actor** on every change a message causes, as `capacity_events.actor`.
  A real deployment would carry the producer's own identity.
