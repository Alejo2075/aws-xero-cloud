import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './scripts/workspace.mjs';

const alias = workspaceAliases(import.meta.dirname);
const common = { alias, environment: 'node' as const, testTimeout: 20_000 };

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { ...common, name: 'unit', include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'] } },
      { resolve: { alias }, test: { ...common, name: 'contracts', include: ['tests/contracts/**/*.test.ts'] } },
      { resolve: { alias }, test: { ...common, name: 'integration', include: ['tests/integration/**/*.test.ts'] } },
      { resolve: { alias }, test: { ...common, name: 'e2e', testTimeout: 120_000, hookTimeout: 120_000, include: ['tests/e2e/**/*.test.ts'] } },
      { resolve: { alias }, test: { ...common, name: 'aws-disposable', testTimeout: 120_000, include: ['tests/aws-disposable/**/*.test.ts'] } },
    ],
  },
});
