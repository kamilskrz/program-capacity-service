/**
 * Root configuration. `npm test` selects the `unit` project and
 * `npm run test:integration` the `integration` one.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  projects: [
    '<rootDir>/jest.unit.config.js',
    '<rootDir>/jest.integration.config.js',
  ],
  passWithNoTests: true,
};
