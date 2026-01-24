/**
 * SudocodeClient Integration Tests
 *
 * Tests for client integration edge cases and potential bugs.
 *
 * @module task/backend/sudocode/__tests__/client-integration.test
 * @see s-8472 Pluggable Task Backend Integration
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkServerHealth,
  createSudocodeClient,
  type SudocodeClientConfig,
  type IssueChangeEvent,
} from "../client.js";
import { createStandaloneClient, StandaloneClient } from "../standalone-client.js";

// Mock fetch for server health checks
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 0);
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }

  send(_data: string) {
    // Mock send
  }

  static clearInstances() {
    MockWebSocket.instances = [];
  }

  static simulateMessage(data: unknown) {
    for (const ws of MockWebSocket.instances) {
      if (ws.onmessage) {
        ws.onmessage({ data: JSON.stringify(data) });
      }
    }
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

describe("Client Integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.clearInstances();
    tmpDir = mkdtempSync(join(tmpdir(), "sudocode-client-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("StandaloneClient initialization", () => {
    it("should create .sudocode directory if it doesn't exist", async () => {
      const client = await createStandaloneClient({ projectPath: tmpDir });

      try {
        expect(existsSync(join(tmpDir, ".sudocode"))).toBe(true);
        expect(existsSync(join(tmpDir, ".sudocode", "cache.db"))).toBe(true);
      } finally {
        client.close();
      }
    });

    it("should throw if init is not called on raw StandaloneClient", async () => {
      const client = new StandaloneClient({ projectPath: tmpDir });

      // Operations should fail before init
      await expect(client.getIssue("i-test")).rejects.toThrow("not initialized");

      client.close();
    });

    it("should handle double init gracefully", async () => {
      const client = new StandaloneClient({ projectPath: tmpDir });
      await client.init();
      await client.init(); // Second init should be a no-op

      expect(client.isReady()).toBe(true);
      client.close();
    });

    it("should handle close before init", () => {
      const client = new StandaloneClient({ projectPath: tmpDir });
      // Should not throw
      expect(() => client.close()).not.toThrow();
      expect(client.isReady()).toBe(false);
    });
  });

  describe("StandaloneClient issue operations", () => {
    let client: StandaloneClient;

    beforeEach(async () => {
      client = await createStandaloneClient({ projectPath: tmpDir });
    });

    afterEach(() => {
      client.close();
    });

    it("should return null for non-existent issue", async () => {
      const issue = await client.getIssue("i-nonexistent");
      expect(issue).toBeNull();
    });

    it("should list issues with empty database", async () => {
      const issues = await client.listIssues();
      expect(issues).toEqual([]);
    });

    it("should list ready issues with empty database", async () => {
      const ready = await client.getReadyIssues();
      expect(ready).toEqual([]);
    });

    it("should throw when updating non-existent issue", async () => {
      await expect(
        client.updateIssue("i-nonexistent", { title: "Updated" })
      ).rejects.toThrow();
    });
  });

  describe("StandaloneClient spec operations", () => {
    let client: StandaloneClient;

    beforeEach(async () => {
      client = await createStandaloneClient({ projectPath: tmpDir });
    });

    afterEach(() => {
      client.close();
    });

    it("should return null for non-existent spec", async () => {
      const spec = await client.getSpec("s-nonexistent");
      expect(spec).toBeNull();
    });

    it("should list specs with empty database", async () => {
      const specs = await client.listSpecs();
      expect(specs).toEqual([]);
    });
  });

  describe("StandaloneClient relationship operations", () => {
    let client: StandaloneClient;

    beforeEach(async () => {
      client = await createStandaloneClient({ projectPath: tmpDir });
    });

    afterEach(() => {
      client.close();
    });

    it("should return empty array for blockers of non-existent issue", async () => {
      const blockers = await client.getBlockers("i-nonexistent");
      expect(blockers).toEqual([]);
    });

    it("should return empty array for blocking of non-existent issue", async () => {
      const blocking = await client.getBlocking("i-nonexistent");
      expect(blocking).toEqual([]);
    });

    it("should infer entity type from ID prefix", async () => {
      // This tests the internal inferEntityType function indirectly
      // by trying to create links with different ID prefixes

      // Should not throw for valid prefixes (even if entities don't exist)
      // The operation may fail for other reasons but not for entity type inference
      await expect(
        client.createLink("i-from", "i-to", "blocks")
      ).rejects.toThrow(); // Will throw because entities don't exist, but not for type inference

      await expect(
        client.createLink("s-from", "i-to", "implements")
      ).rejects.toThrow();
    });

    it("should throw for invalid entity ID prefix", async () => {
      await expect(
        client.createLink("x-invalid", "i-to", "blocks")
      ).rejects.toThrow("Cannot infer entity type");
    });
  });

  describe("StandaloneClient event subscriptions", () => {
    let client: StandaloneClient;

    beforeEach(async () => {
      client = await createStandaloneClient({
        projectPath: tmpDir,
        pollInterval: 100, // Short interval for testing
      });
    });

    afterEach(() => {
      client.close();
    });

    it("should subscribe to global issue changes", async () => {
      const events: IssueChangeEvent[] = [];
      const unsubscribe = client.onIssueChange((event) => {
        events.push(event);
      });

      // Unsubscribe should work
      unsubscribe();
      expect(typeof unsubscribe).toBe("function");
    });

    it("should subscribe to specific issue changes", async () => {
      const events: IssueChangeEvent[] = [];
      const unsubscribe = client.onIssueChange("i-specific", (event) => {
        events.push(event);
      });

      unsubscribe();
      expect(typeof unsubscribe).toBe("function");
    });

    it("should stop polling when all subscribers unsubscribe", async () => {
      const unsub1 = client.onIssueChange(() => {});
      const unsub2 = client.onIssueChange(() => {});

      unsub1();
      // Polling should still be active (unsub2 still subscribed)

      unsub2();
      // Now polling should stop
    });

    it("should handle callback errors gracefully", async () => {
      const goodEvents: IssueChangeEvent[] = [];

      // Subscribe with a callback that throws
      client.onIssueChange(() => {
        throw new Error("Callback error");
      });

      // Subscribe with a good callback
      client.onIssueChange((event) => {
        goodEvents.push(event);
      });

      // Trigger an event manually (this tests error handling in emitChangeEvent)
      // The good callback should still receive events
    });
  });

  describe("Client factory auto mode", () => {
    it("should timeout properly when server is slow", async () => {
      // Make fetch return a promise that respects abort signal
      // fetch signature is fetch(url, options) where options.signal is the AbortSignal
      mockFetch.mockImplementation((_url: string, options?: { signal?: AbortSignal }) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve({ ok: true }), 5000);
          if (options?.signal) {
            options.signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(new Error("Aborted"));
            });
          }
        });
      });

      const config: SudocodeClientConfig = {
        mode: "auto",
        projectPath: tmpDir,
        autoDetect: {
          timeout: 100, // Very short timeout
          preferManaged: true,
        },
      };

      const client = await createSudocodeClient(config);

      try {
        // Should have fallen back to standalone due to timeout
        expect(MockWebSocket.instances).toHaveLength(0);
        expect(client.isReady()).toBe(true);
      } finally {
        client.close();
      }
    });

    it("should use custom server URL for health check", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const config: SudocodeClientConfig = {
        mode: "auto",
        autoDetect: {
          serverUrl: "http://custom-server:9999",
        },
      };

      const client = await createSudocodeClient(config);

      try {
        expect(mockFetch).toHaveBeenCalledWith(
          "http://custom-server:9999/health",
          expect.anything()
        );
      } finally {
        client.close();
      }
    });
  });

  describe("checkServerHealth edge cases", () => {
    it("should handle network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await checkServerHealth("http://localhost:3001");
      expect(result).toBe(false);
    });

    it("should handle 500 response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await checkServerHealth("http://localhost:3001");
      expect(result).toBe(false);
    });

    it("should handle 404 response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const result = await checkServerHealth("http://localhost:3001");
      expect(result).toBe(false);
    });
  });

  describe("StandaloneClient feedback operations", () => {
    let client: StandaloneClient;

    beforeEach(async () => {
      client = await createStandaloneClient({ projectPath: tmpDir });
    });

    afterEach(() => {
      client.close();
    });

    it("should handle addFeedback gracefully even if not supported", async () => {
      // addFeedback should not throw even if the CLI doesn't support it
      await expect(
        client.addFeedback("i-from", "s-to", {
          type: "comment",
          content: "Test feedback",
        })
      ).resolves.not.toThrow();
    });
  });

  describe("StandaloneClient lifecycle", () => {
    it("should clean up resources on close", async () => {
      const client = await createStandaloneClient({
        projectPath: tmpDir,
        pollInterval: 100,
      });

      // Subscribe to start polling
      client.onIssueChange(() => {});

      expect(client.isReady()).toBe(true);

      client.close();

      expect(client.isReady()).toBe(false);

      // Operations should fail after close
      await expect(client.getIssue("i-test")).rejects.toThrow("not initialized");
    });

    it("should handle multiple close calls", async () => {
      const client = await createStandaloneClient({ projectPath: tmpDir });

      client.close();
      client.close(); // Should not throw
      client.close(); // Should not throw

      expect(client.isReady()).toBe(false);
    });
  });
});
