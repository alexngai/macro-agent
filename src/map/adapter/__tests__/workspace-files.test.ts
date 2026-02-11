/**
 * Tests for Workspace File Search Extension Methods (_macro/workspace/files/*)
 *
 * Tests the search, list, and read handlers using a real temporary filesystem.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  registerWorkspaceFileExtensions,
  unregisterWorkspaceFileExtensions,
  type WorkspaceFileServices,
} from "../extensions/workspace-files.js";
import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { ParticipantCapabilities } from "../types.js";
import type { AgentId } from "../../../store/types/index.js";

// =============================================================================
// Mock Setup
// =============================================================================

function createMockAdapter(): MAPAdapter & {
  handlers: Map<string, ExtensionHandler>;
} {
  const handlers = new Map<string, ExtensionHandler>();

  return {
    handlers,
    registerExtension: vi.fn((method: string, handler: ExtensionHandler) => {
      handlers.set(method, handler);
    }),
    unregisterExtension: vi.fn((method: string) => {
      handlers.delete(method);
    }),
    hasExtension: vi.fn((method: string) => handlers.has(method)),
    getExtensions: vi.fn(() => Array.from(handlers.keys())),
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
    acceptConnection: vi.fn(),
    disconnectParticipant: vi.fn(),
    getParticipant: vi.fn(),
    getParticipants: vi.fn().mockReturnValue([]),
    createSubscription: vi.fn(),
    removeSubscription: vi.fn(),
    pauseSubscription: vi.fn(),
    resumeSubscription: vi.fn(),
    getSubscriptions: vi.fn().mockReturnValue([]),
    emitEvent: vi.fn(),
    listAgents: vi.fn().mockReturnValue([]),
    getAgent: vi.fn(),
    listScopes: vi.fn().mockReturnValue([]),
    getScope: vi.fn(),
    sendMessage: vi.fn(),
    onEvent: vi.fn().mockReturnValue(() => {}),
    config: { name: "test", version: "1.0.0" },
  } as unknown as MAPAdapter & { handlers: Map<string, ExtensionHandler> };
}

function createMockContext(): ExtensionContext {
  return {
    participantId: "p-test" as any,
    capabilities: {
      canQuery: true,
      canSubscribe: true,
      canMessage: true,
      canManageTasks: true,
    } as ParticipantCapabilities,
    sessionId: "s-test",
  };
}

// =============================================================================
// Temporary Workspace Filesystem
// =============================================================================

let tmpDir: string;

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-files-test-"));

  // Create a file structure:
  // src/
  //   index.ts
  //   utils/
  //     helpers.ts
  // README.md
  // package.json
  // .git/           (excluded dir)
  //   config
  // node_modules/   (excluded dir)
  //   foo.js
  // image.png       (binary extension)

  fs.mkdirSync(path.join(dir, "src", "utils"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), 'export const main = "hello";');
  fs.writeFileSync(path.join(dir, "src", "utils", "helpers.ts"), 'export function help() {}');
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Project");
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"test"}');

  // Excluded directories
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "git config");
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "foo.js"), "module");

  // Binary file
  fs.writeFileSync(path.join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  return dir;
}

function cleanupTempWorkspace(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// =============================================================================
// Tests
// =============================================================================

describe("Workspace File Extensions", () => {
  let adapter: MAPAdapter & { handlers: Map<string, ExtensionHandler> };
  let services: WorkspaceFileServices;

  beforeEach(() => {
    tmpDir = createTempWorkspace();
    adapter = createMockAdapter();

    services = {
      getWorkspace: vi.fn().mockReturnValue({ path: tmpDir }),
      agentExists: vi.fn().mockReturnValue(true),
    };
  });

  afterEach(() => {
    cleanupTempWorkspace(tmpDir);
  });

  // ===========================================================================
  // Registration
  // ===========================================================================

  describe("registration", () => {
    it("registers all three workspace file methods", () => {
      registerWorkspaceFileExtensions(adapter, services);

      expect(adapter.handlers.has("_macro/workspace/files/search")).toBe(true);
      expect(adapter.handlers.has("_macro/workspace/files/list")).toBe(true);
      expect(adapter.handlers.has("_macro/workspace/files/read")).toBe(true);
    });

    it("unregisters all three workspace file methods", () => {
      registerWorkspaceFileExtensions(adapter, services);
      unregisterWorkspaceFileExtensions(adapter);

      expect(adapter.handlers.has("_macro/workspace/files/search")).toBe(false);
      expect(adapter.handlers.has("_macro/workspace/files/list")).toBe(false);
      expect(adapter.handlers.has("_macro/workspace/files/read")).toBe(false);
    });
  });

  // ===========================================================================
  // _macro/workspace/files/search
  // ===========================================================================

  describe("_macro/workspace/files/search", () => {
    it("finds files matching a query", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: "index",
      })) as { files: Array<{ path: string; isDirectory: boolean }> };

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe("src/index.ts");
      expect(result.files[0].isDirectory).toBe(false);
    });

    it("finds files matching by extension", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: ".ts",
      })) as { files: Array<{ path: string }> };

      const paths = result.files.map((f) => f.path);
      expect(paths).toContain("src/index.ts");
      expect(paths).toContain("src/utils/helpers.ts");
    });

    it("returns MIME types for matched files", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: "index.ts",
      })) as { files: Array<{ mime?: string }> };

      expect(result.files[0].mime).toBe("text/typescript");
    });

    it("returns file sizes", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: "README",
      })) as { files: Array<{ size?: number }> };

      expect(result.files[0].size).toBeGreaterThan(0);
    });

    it("excludes node_modules and .git directories", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      // Search for something that exists in node_modules
      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: "foo",
      })) as { files: Array<{ path: string }> };

      const paths = result.files.map((f) => f.path);
      expect(paths).not.toContain("node_modules/foo.js");
    });

    it("excludes binary file extensions", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: "image",
      })) as { files: Array<{ path: string }> };

      const paths = result.files.map((f) => f.path);
      expect(paths).not.toContain("image.png");
    });

    it("case-insensitive matching", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: "README",
      })) as { files: Array<{ path: string }> };

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe("README.md");
    });

    it("supports path-based queries with /", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: "src/utils",
      })) as { files: Array<{ path: string }> };

      const paths = result.files.map((f) => f.path);
      // Should find the directory and the file inside
      expect(paths).toContain("src/utils/");
      expect(paths).toContain("src/utils/helpers.ts");
    });

    it("respects limit parameter", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: ".", // matches everything
        limit: 2,
      })) as { files: Array<{ path: string }> };

      expect(result.files.length).toBeLessThanOrEqual(2);
    });

    it("searches within cwd subdirectory", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: "helpers",
        cwd: "src/utils",
      })) as { files: Array<{ path: string }> };

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe("src/utils/helpers.ts");
    });

    it("returns empty array when no matches", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: "nonexistent-file-xyz",
      })) as { files: Array<{ path: string }> };

      expect(result.files).toEqual([]);
    });

    it("returns empty files when agent has no workspace", async () => {
      (services.getWorkspace as ReturnType<typeof vi.fn>).mockReturnValue(null);
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        query: "test",
      })) as { files: unknown[] };

      expect(result.files).toEqual([]);
    });

    it("throws for missing agentId", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      await expect(
        handler(createMockContext(), { query: "test" })
      ).rejects.toThrow("agentId is required");
    });

    it("throws for missing query", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      await expect(
        handler(createMockContext(), { agentId: "agent-1" })
      ).rejects.toThrow("query is required");
    });

    it("throws for non-existent agent", async () => {
      (services.agentExists as ReturnType<typeof vi.fn>).mockReturnValue(false);
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      await expect(
        handler(createMockContext(), { agentId: "missing", query: "test" })
      ).rejects.toThrow("not found");
    });
  });

  // ===========================================================================
  // _macro/workspace/files/list
  // ===========================================================================

  describe("_macro/workspace/files/list", () => {
    it("lists files in root directory", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
      })) as { files: Array<{ path: string; isDirectory: boolean }> };

      const paths = result.files.map((f) => f.path);
      expect(paths).toContain("src/");
      expect(paths).toContain("README.md");
      expect(paths).toContain("package.json");
    });

    it("lists directories before files (sorted)", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
      })) as { files: Array<{ isDirectory: boolean }> };

      // All directories should come before files
      const firstFileIndex = result.files.findIndex((f) => !f.isDirectory);
      const lastDirIndex = result.files.findLastIndex((f) => f.isDirectory);
      if (firstFileIndex !== -1 && lastDirIndex !== -1) {
        expect(lastDirIndex).toBeLessThan(firstFileIndex);
      }
    });

    it("lists files in subdirectory", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        directory: "src",
      })) as { files: Array<{ path: string }> };

      const paths = result.files.map((f) => f.path);
      expect(paths).toContain("src/utils/");
      expect(paths).toContain("src/index.ts");
    });

    it("excludes node_modules and .git from listing", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
      })) as { files: Array<{ path: string }> };

      const paths = result.files.map((f) => f.path);
      expect(paths).not.toContain("node_modules/");
      expect(paths).not.toContain(".git/");
    });

    it("excludes binary files from listing", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
      })) as { files: Array<{ path: string }> };

      const paths = result.files.map((f) => f.path);
      expect(paths).not.toContain("image.png");
    });

    it("returns MIME and size for files", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        directory: "src",
      })) as { files: Array<{ path: string; mime?: string; size?: number; isDirectory: boolean }> };

      const indexFile = result.files.find((f) => f.path === "src/index.ts");
      expect(indexFile).toBeDefined();
      expect(indexFile!.mime).toBe("text/typescript");
      expect(indexFile!.size).toBeGreaterThan(0);
    });

    it("returns empty files when agent has no workspace", async () => {
      (services.getWorkspace as ReturnType<typeof vi.fn>).mockReturnValue(null);
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
      })) as { files: unknown[] };

      expect(result.files).toEqual([]);
    });

    it("throws for missing agentId", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      await expect(handler(createMockContext(), {})).rejects.toThrow(
        "agentId is required"
      );
    });

    it("throws for non-existent agent", async () => {
      (services.agentExists as ReturnType<typeof vi.fn>).mockReturnValue(false);
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      await expect(
        handler(createMockContext(), { agentId: "missing" })
      ).rejects.toThrow("not found");
    });

    it("throws for non-existent directory", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      await expect(
        handler(createMockContext(), { agentId: "agent-1", directory: "nonexistent" })
      ).rejects.toThrow("Directory not found");
    });
  });

  // ===========================================================================
  // _macro/workspace/files/read
  // ===========================================================================

  describe("_macro/workspace/files/read", () => {
    it("reads file contents", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        path: "src/index.ts",
      })) as { text: string; mime: string; size: number };

      expect(result.text).toBe('export const main = "hello";');
      expect(result.mime).toBe("text/typescript");
      expect(result.size).toBeGreaterThan(0);
    });

    it("reads file with correct MIME type", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        path: "README.md",
      })) as { text: string; mime: string };

      expect(result.text).toBe("# Test Project");
      expect(result.mime).toBe("text/markdown");
    });

    it("reads JSON file", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        path: "package.json",
      })) as { text: string; mime: string };

      expect(result.text).toBe('{"name":"test"}');
      expect(result.mime).toBe("application/json");
    });

    it("supports lineRange", async () => {
      // Create a multi-line file
      const multiLineContent = "line 1\nline 2\nline 3\nline 4\nline 5";
      fs.writeFileSync(path.join(tmpDir, "multiline.txt"), multiLineContent);

      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      const result = (await handler(createMockContext(), {
        agentId: "agent-1",
        path: "multiline.txt",
        lineRange: { start: 2, end: 4 },
      })) as { text: string };

      expect(result.text).toBe("line 2\nline 3\nline 4");
    });

    it("throws for invalid lineRange (start < 1)", async () => {
      fs.writeFileSync(path.join(tmpDir, "lines.txt"), "line 1\nline 2");
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      await expect(
        handler(createMockContext(), {
          agentId: "agent-1",
          path: "lines.txt",
          lineRange: { start: 0, end: 2 },
        })
      ).rejects.toThrow("lineRange must have start >= 1");
    });

    it("throws for invalid lineRange (end < start)", async () => {
      fs.writeFileSync(path.join(tmpDir, "lines.txt"), "line 1\nline 2");
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      await expect(
        handler(createMockContext(), {
          agentId: "agent-1",
          path: "lines.txt",
          lineRange: { start: 3, end: 1 },
        })
      ).rejects.toThrow("lineRange must have start >= 1");
    });

    it("throws for missing agentId", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      await expect(
        handler(createMockContext(), { path: "src/index.ts" })
      ).rejects.toThrow("agentId is required");
    });

    it("throws for missing path", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      await expect(
        handler(createMockContext(), { agentId: "agent-1" })
      ).rejects.toThrow("path is required");
    });

    it("throws for non-existent agent", async () => {
      (services.agentExists as ReturnType<typeof vi.fn>).mockReturnValue(false);
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      await expect(
        handler(createMockContext(), { agentId: "missing", path: "src/index.ts" })
      ).rejects.toThrow("not found");
    });

    it("throws for agent without workspace", async () => {
      (services.getWorkspace as ReturnType<typeof vi.fn>).mockReturnValue(null);
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      await expect(
        handler(createMockContext(), { agentId: "agent-1", path: "src/index.ts" })
      ).rejects.toThrow("has no workspace");
    });

    it("throws for non-existent file", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      await expect(
        handler(createMockContext(), { agentId: "agent-1", path: "nonexistent.ts" })
      ).rejects.toThrow("File not found");
    });

    it("throws for directory path", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      await expect(
        handler(createMockContext(), { agentId: "agent-1", path: "src" })
      ).rejects.toThrow("Path is a directory");
    });

    it("rejects path traversal attempts", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/read")!;

      await expect(
        handler(createMockContext(), { agentId: "agent-1", path: "../../etc/passwd" })
      ).rejects.toThrow("Path traversal not allowed");
    });
  });

  // ===========================================================================
  // Path Traversal (across all handlers)
  // ===========================================================================

  describe("path traversal protection", () => {
    it("search rejects cwd with path traversal", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/search")!;

      await expect(
        handler(createMockContext(), {
          agentId: "agent-1",
          query: "test",
          cwd: "../../etc",
        })
      ).rejects.toThrow("Path traversal not allowed");
    });

    it("list rejects directory with path traversal", async () => {
      registerWorkspaceFileExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/files/list")!;

      await expect(
        handler(createMockContext(), {
          agentId: "agent-1",
          directory: "../../etc",
        })
      ).rejects.toThrow("Path traversal not allowed");
    });
  });
});
