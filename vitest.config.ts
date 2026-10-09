import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Patterns resolve against the cwd of the vitest process, and this config is
    // picked up both from the repo root and from individual package directories,
    // so cover both layouts: "src/**..." for per-package runs and
    // "packages/*/src/**..." for a single run from the repo root.
    include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
  },
});
