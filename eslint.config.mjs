// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportDeclaration[source.value=/^\\.\\.?\\/.*\\.js$/], ExportNamedDeclaration[source.value=/^\\.\\.?\\/.*\\.js$/], ExportAllDeclaration[source.value=/^\\.\\.?\\/.*\\.js$/]',
          message:
            "Use extensionless relative imports in TypeScript source. tsdown rewrites them to '.js' for the published Node ESM build.",
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Plain Node ESM scripts (no TypeScript). Declare Node globals so
    // `process`/`console` are recognized.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
