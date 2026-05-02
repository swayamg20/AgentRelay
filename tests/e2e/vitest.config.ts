import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["src/**/*.e2e.test.ts"],
    globalSetup: ["./src/global-setup.ts"],
    fileParallelism: false,
  },
});
