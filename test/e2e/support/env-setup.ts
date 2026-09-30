// Runs once per test file, before that file's own imports resolve
// (`jest.integration.config.js`'s `setupFiles`). `AppConfigModule`'s
// `ConfigModule.forRoot({ validate })` runs synchronously the moment
// `AppModule` is imported — at module-load time, not when Nest later
// instantiates it — so setting these from inside `createE2eApp()` itself
// would already be too late. `DATABASE_URL` is `global-setup.ts`'s job
// (docs/PLAN.md 2.10); this fills in the rest of `Env` so an e2e run needs no
// `.env` file. Values only, `??=`, so a real `.env`/CI value always wins.
process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '3000';
process.env.KAFKA_BROKERS ??= 'localhost:19092';
process.env.JWT_SECRET ??= 'e2e-tests-only-secret-0123456789-abcdef';
