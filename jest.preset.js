/**
 * Shared transform for every Jest project. @swc/jest keeps the suite fast while
 * still emitting the decorator metadata Nest relies on.
 */
const swcTransform = [
  '@swc/jest',
  {
    sourceMaps: 'inline',
    module: { type: 'commonjs' },
    jsc: {
      target: 'es2023',
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  },
];

/** @type {import('jest').Config} */
const preset = {
  rootDir: __dirname,
  transform: { '^.+\\.(t|j)s$': swcTransform },
  moduleFileExtensions: ['js', 'json', 'ts'],
  clearMocks: true,
};

module.exports = { preset, swcTransform };
