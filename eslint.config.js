import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/*.tsbuildinfo', 'fixtures/generated/**', 'website/**'],
  },

  // Root tooling configs are plain JS and are not part of any tsconfig, so they
  // get syntactic linting only.
  {
    files: ['*.js', 'scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        // `perf-assert.mjs` drives the index pipeline, whose run signature takes a signal.
        AbortController: 'readonly',
      },
    },
  },

  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Explicit project list rather than `projectService: true`, because tests are
        // deliberately excluded from each package's tsconfig (so `dist/` stays
        // publishable) and live only in tsconfig.test.json, which auto-discovery does
        // not find. Source files and test files are in exactly one project each.
        project: [
          './tsconfig.test.json',
          './packages/*/tsconfig.json',
          './cli/tsconfig.json',
          './fixtures/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `_`-prefixed parameters are how M0.1 stubs name the arguments a real
      // implementation will use. Matches tsconfig's noUnusedParameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Stubs are declared `async` / return Promises to pin the real signature
      // before there is a body to await.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      // Boundary rule B3/B5 depend on exhaustive unions; make gaps loud.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
