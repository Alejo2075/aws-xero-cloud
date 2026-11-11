import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'examples/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/src/**', '**/dist/**'], message: 'No private deep imports.' }] }],
    },
  },
  {
    // Dependency rule: core domain packages must not import infrastructure SDKs.
    files: ['packages/{core,specification,invocation,scheduler,scaling}/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['@aws-sdk/*', 'dockerode', '@kubernetes/*', 'react*'] }],
    },
  },
);
