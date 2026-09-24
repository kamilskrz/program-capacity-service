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
);
