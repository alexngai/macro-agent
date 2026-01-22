import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Use forks instead of threads to avoid segfaults with better-sqlite3
    // Native modules can cause memory access issues during thread cleanup
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
