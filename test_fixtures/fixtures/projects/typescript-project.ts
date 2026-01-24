/**
 * TypeScript Project Fixtures
 *
 * Predefined project structures for testing.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7f2l Phase 4: Fixtures Library
 */

import type { TempRepoOptions, BranchConfig } from "../repos/types.js";

/**
 * Basic TypeScript project structure
 */
export const TYPESCRIPT_PROJECT: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "test-project",
      version: "1.0.0",
      type: "module",
      main: "dist/index.js",
      scripts: {
        build: "tsc",
        test: "vitest",
        lint: "eslint src/",
      },
      devDependencies: {
        typescript: "^5.0.0",
        vitest: "^1.0.0",
      },
    },
    null,
    2
  ),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: "./dist",
        rootDir: "./src",
        declaration: true,
      },
      include: ["src/**/*"],
      exclude: ["node_modules", "dist"],
    },
    null,
    2
  ),
  "src/index.ts": `/**
 * Main entry point
 */
export const VERSION = "1.0.0";

export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`,
  "src/utils.ts": `/**
 * Utility functions
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function slugify(str: string): string {
  return str.toLowerCase().replace(/\\s+/g, "-");
}
`,
  "tests/index.test.ts": `import { describe, it, expect } from "vitest";
import { greet, VERSION } from "../src/index.js";

describe("index", () => {
  it("should export VERSION", () => {
    expect(VERSION).toBe("1.0.0");
  });

  it("should greet", () => {
    expect(greet("World")).toBe("Hello, World!");
  });
});
`,
  "README.md": `# Test Project

A test project for multi-agent orchestration testing.
`,
};

/**
 * TypeScript project with existing feature branch
 */
export const PROJECT_WITH_BRANCHES: {
  initialFiles: Record<string, string>;
  branches: BranchConfig[];
} = {
  initialFiles: TYPESCRIPT_PROJECT,
  branches: [
    {
      name: "feature/existing",
      files: {
        "src/feature.ts": `/**
 * Existing feature module
 */
export function existingFeature(): boolean {
  return true;
}
`,
      },
      commit: "Add existing feature",
    },
    {
      name: "feature/wip",
      files: {
        "src/wip.ts": `/**
 * Work in progress
 */
export function wipFeature(): void {
  // TODO: implement
}
`,
      },
      commit: "WIP: Start new feature",
    },
  ],
};

/**
 * Minimal project for quick tests
 */
export const MINIMAL_PROJECT: Record<string, string> = {
  "index.ts": "export const version = '1.0.0';",
};

/**
 * Project with conflicting setup for merge conflict tests
 */
export const CONFLICT_PRONE_PROJECT: {
  initialFiles: Record<string, string>;
  branches: BranchConfig[];
} = {
  initialFiles: {
    ...TYPESCRIPT_PROJECT,
    "src/shared.ts": `/**
 * Shared module - likely to have conflicts
 */
export const CONFIG = {
  version: "1.0.0",
  name: "original",
};
`,
  },
  branches: [
    {
      name: "feature/alpha",
      files: {
        "src/shared.ts": `/**
 * Shared module - modified by alpha
 */
export const CONFIG = {
  version: "1.1.0",
  name: "alpha",
  alpha: true,
};
`,
      },
      commit: "Alpha modifies shared config",
    },
    {
      name: "feature/beta",
      files: {
        "src/shared.ts": `/**
 * Shared module - modified by beta
 */
export const CONFIG = {
  version: "1.2.0",
  name: "beta",
  beta: true,
};
`,
      },
      commit: "Beta modifies shared config",
    },
  ],
};

/**
 * Create custom TypeScript project options
 */
export function createTypescriptProjectOptions(
  overrides: Partial<TempRepoOptions> = {}
): TempRepoOptions {
  return {
    initialFiles: TYPESCRIPT_PROJECT,
    ...overrides,
  };
}
