import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'out/',
      'dist/',
      '.vite/',
      'coverage/',
      'tests/fixtures/',
      'resources/templates/',
      'docs/wireframes/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The workbench renderer runs in a browser context (no Node globals; AGENTS.md: renderer has no Node APIs).
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: ['src/renderer/**/*.test.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-globals': ['error', { name: 'process', message: 'The renderer has no Node.js process.' }],
    },
  },
  {
    // Architecture invariant: platform differences live in src/platform only (PLAN §5, §6).
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/platform/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'platform', message: 'Use the adapters in src/platform instead.' },
      ],
    },
  },
);
