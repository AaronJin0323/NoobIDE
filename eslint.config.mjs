import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['node_modules/', 'out/', 'dist/', '.vite/', 'coverage/', 'tests/fixtures/', 'resources/templates/'] },
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
