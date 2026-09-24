const { preset } = require('./jest.preset');

/**
 * Unit tests: no I/O at all. They live next to the code they cover, so a domain
 * rule and its table tests stay in one place.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...preset,
  displayName: 'unit',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  coverageDirectory: '<rootDir>/coverage/unit',
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts'],
};
