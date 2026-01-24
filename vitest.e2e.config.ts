import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // Run all e2e tests
    include: [
      "src/**/*.e2e.test.ts",
      "src/**/e2e/**/*.test.ts",
    ],
    // Use forks instead of threads to avoid segfaults with better-sqlite3
    pool: "forks",
    // Longer timeout for e2e tests that start servers or run git operations
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run tests sequentially to avoid server port conflicts
    fileParallelism: false,
    server: {
      deps: {
        // Force inline the sudocode packages to avoid Node.js type stripping issues
        inline: [/@sudocode-ai\/.*/],
      },
    },
  },
});
