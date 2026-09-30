// @ts-check
import js from '@eslint/js';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const PROCESS_ENV_SELECTOR =
  'MemberExpression[object.name="process"][property.name="env"]';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '**/*.js'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierRecommended,

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],

      // docs/PLAN.md: the environment is read and validated in exactly one
      // place. Everything else takes a typed value through configuration.
      'no-restricted-syntax': [
        'error',
        {
          selector: PROCESS_ENV_SELECTOR,
          message:
            'Do not read process.env outside src/shared/config. Inject AppConfigService instead.',
        },
      ],
    },
  },

  {
    files: ['src/shared/config/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    files: ['test/**/*.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    // The integration harness is an entry point, like the MikroORM CLI: it starts
    // the container before any Nest container exists, so the connection string it
    // publishes to the test files has nowhere else to live but the environment.
    // Scoped to the two files that do it, so a spec still cannot read config.
    files: [
      'test/integration/global-setup.ts',
      'test/integration/support/postgres-container.ts',
      // Same reason: a Jest `setupFiles` entry runs before any `AppModule`
      // import resolves `ConfigModule.forRoot({ validate })`, so it is the
      // one other place that has to fill in what `.env` would (docs/PLAN.md
      // 2.7's second half).
      'test/e2e/support/env-setup.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
