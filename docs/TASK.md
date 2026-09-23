Program Capacity & Invoice Reservation
A financing program has a total credit limit (e.g. $10,000,000). When an invoice is approved for
early payment, it reserves a portion of that capacity. When repaid, the amount is released back.
Your task is to implement a module that tracks this in real time — accepting reservations,
processing releases, and exposing current availability to clients.
Capacity data also flows in from an external treasury system via Kafka, including periodic bulk
reconciliation messages that bring a program's full state up to date. Programs and invoices may
be denominated in different currencies.
All endpoints must be authenticated. The service should be runnable locally. Treat this as
production code — if you make assumptions or trade-offs, document them briefly.