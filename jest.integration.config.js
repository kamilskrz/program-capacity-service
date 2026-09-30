const { preset } = require('./jest.preset');

/**
 * Integration and e2e tests. Both talk to real infrastructure, so they share a
 * project: `globalSetup` starts Postgres once per run via Testcontainers and
 * applies the migrations, `globalTeardown` stops it, and isolation between tests is
 * `TRUNCATE` (see `test/integration/support/orm.ts`, which records why it is not a
 * transaction per test).
 *
 * Cycle 7 adds Redpanda to the same `globalSetup`.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...preset,
  displayName: 'integration',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/test/integration/**/*.spec.ts',
    '<rootDir>/test/e2e/**/*.e2e-spec.ts',
  ],
  // Containers are shared and the concurrency tests need a predictable database
  // state, so integration tests run one file at a time; the `--runInBand` flag
  // lives in the npm script because Jest only accepts it as a global option.
  testTimeout: 60_000,
  coverageDirectory: '<rootDir>/coverage/integration',
  globalSetup: '<rootDir>/test/integration/global-setup.ts',
  globalTeardown: '<rootDir>/test/integration/global-teardown.ts',
  // Fills in the non-database half of `Env` for the e2e suite's real Nest
  // application, before any test file (and so any `AppModule` import) loads.
  setupFiles: ['<rootDir>/test/e2e/support/env-setup.ts'],
};
