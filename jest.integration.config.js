const { preset } = require('./jest.preset');

/**
 * Integration and e2e tests. Both talk to real infrastructure, so they share a
 * project: cycle 4 adds a `globalSetup` that starts Postgres and Redpanda once
 * per run via Testcontainers, and isolation between tests is TRUNCATE.
 *
 * Until then this is a working but empty project — a stub on purpose.
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
  // globalSetup: '<rootDir>/test/integration/global-setup.ts',   (cycle 4)
  // globalTeardown: '<rootDir>/test/integration/global-teardown.ts',
};
