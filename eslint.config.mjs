// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.kaizen/**',
      'coverage/**',
      'apps/web/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // Dev-only screenshot harness (T-3.6C): Node script whose page.evaluate
    // callbacks run in the browser.
    files: ['apps/web/scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', window: 'readonly', document: 'readonly' },
    },
  },
  {
    // CommonJS bin shim (T-3.6C): loads the built CLI.
    files: ['packages/cli/bin/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', process: 'readonly', console: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Node scripts (demo publisher, web screenshot harness) and the Vercel
    // function run under Node, not the browser — declare the runtime globals
    // they legitimately use.
    files: ['scripts/**/*.mjs', 'apps/web/api/**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    // Node ESM test scripts (experiment harnesses) run under Node, not the
    // browser — declare the Node/runtime globals they legitimately use.
    files: ['test/**/*.mjs', 'contracts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        structuredClone: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
  },
);
