import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: 'default',
    // Integration tests share one Postgres database. We do NOT clean state
    // via vitest setupFiles — tried that, it raced against test files'
    // own top-level `tryConnect()` and froze the worker pool. Instead, the
    // `pnpm test:integration` script (scripts/test-integration.sh) runs
    // each integration file in its own fresh vitest invocation and
    // truncates between files via `docker exec`. Per-test transactions
    // would be cleaner long-term but require a larger refactor.
  },
});
