import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "test_fixtures/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      // E2E tests are run separately via vitest.e2e.config.ts
      "**/*.e2e.test.ts",
      "**/e2e/**",
    ],
    // Use forks instead of threads to avoid segfaults with better-sqlite3
    // Native modules can cause memory access issues during thread cleanup
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    server: {
      deps: {
        // Force inline the sudocode packages to avoid Node.js type stripping issues
        inline: [/@sudocode-ai\/.*/],
      },
    },
  },
});
