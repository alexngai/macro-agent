/**
 * Cognitive Extension Tests
 *
 * Tests that MAP cognitive extension handlers correctly dispatch
 * Atlas operations and return expected results.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerCognitiveExtensions,
  unregisterCognitiveExtensions,
  COGNITIVE_EXTENSION_METHODS,
} from "../../map/adapter/extensions/cognitive.js";
import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../../map/adapter/interface.js";
import type { AtlasInstance } from "../types.js";
import type { EventStore } from "../../store/event-store.js";

// ── Mock Helpers ─────────────────────────────────────────────────

function createMockAtlas(overrides?: Partial<AtlasInstance>): AtlasInstance {
  return {
    processTrajectory: vi.fn().mockResolvedValue({
      trajectoryId: "traj_1",
      stored: true,
    }),
    runBatchLearning: vi.fn().mockResolvedValue({
      trajectoriesProcessed: 5,
      playbooksExtracted: 2,
    }),
    runTeamBatchLearning: vi.fn().mockResolvedValue({
      trajectoriesProcessed: 3,
      teamPlaybooksCreated: 1,
    }),
    queryMemory: vi.fn().mockResolvedValue({
      results: [{ content: "test insight" }],
    }),
    prune: vi.fn().mockResolvedValue({
      totalPruned: 10,
      remainingCount: 50,
    }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockEventStore(): EventStore {
  return {
    emit: vi.fn().mockReturnValue({ id: "evt_1" }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventStore;
}

function createMockContext(): ExtensionContext {
  return {
    participantId: "participant_1",
    capabilities: {},
    sessionId: "session_1",
  } as unknown as ExtensionContext;
}

/**
 * Creates a mock MAPAdapter that captures registered handlers.
 * Returns the adapter and a map of registered handlers for testing.
 */
function createMockAdapter(): {
  adapter: MAPAdapter;
  handlers: Map<string, ExtensionHandler>;
} {
  const handlers = new Map<string, ExtensionHandler>();
  const adapter = {
    registerExtension: vi.fn((method: string, handler: ExtensionHandler) => {
      handlers.set(method, handler);
    }),
    unregisterExtension: vi.fn((method: string) => {
      handlers.delete(method);
    }),
  } as unknown as MAPAdapter;
  return { adapter, handlers };
}

// ── Tests ────────────────────────────────────────────────────────

describe("Cognitive Extensions", () => {
  let atlas: AtlasInstance;
  let eventStore: EventStore;
  let handlers: Map<string, ExtensionHandler>;
  let context: ExtensionContext;

  beforeEach(() => {
    atlas = createMockAtlas();
    eventStore = createMockEventStore();
    context = createMockContext();

    const mock = createMockAdapter();
    handlers = mock.handlers;
    registerCognitiveExtensions(mock.adapter, { atlas, eventStore });
  });

  describe("_macro/cognitive/command", () => {
    it("query operation returns results synchronously", async () => {
      const handler = handlers.get("_macro/cognitive/command")!;
      const result = await handler(context, {
        operation: "query",
        config: { query: "How to optimize queries?" },
      });

      expect(atlas.queryMemory).toHaveBeenCalledWith("How to optimize queries?", {
        domains: undefined,
        includeExperiences: undefined,
        includePlaybooks: undefined,
      });
      expect((result as any).status).toBe("completed");
      expect((result as any).result).toEqual({ results: [{ content: "test insight" }] });
    });

    it("extract operation starts async and returns job_id", async () => {
      const handler = handlers.get("_macro/cognitive/command")!;
      const result = await handler(context, { operation: "extract" });

      expect((result as any).status).toBe("started");
      expect((result as any).job_id).toBeDefined();

      // Wait for async operation to complete
      await new Promise((r) => setTimeout(r, 50));
      expect(atlas.runBatchLearning).toHaveBeenCalled();
    });

    it("team-extract dispatches to runTeamBatchLearning", async () => {
      const handler = handlers.get("_macro/cognitive/command")!;
      const result = await handler(context, { operation: "team-extract" });

      expect((result as any).status).toBe("started");

      await new Promise((r) => setTimeout(r, 50));
      expect(atlas.runTeamBatchLearning).toHaveBeenCalled();
    });

    it("prune dispatches to atlas.prune()", async () => {
      const handler = handlers.get("_macro/cognitive/command")!;
      const result = await handler(context, {
        operation: "prune",
        config: { maxAge: 7 },
      });

      expect((result as any).status).toBe("started");

      await new Promise((r) => setTimeout(r, 50));
      expect(atlas.prune).toHaveBeenCalledWith({ maxAge: 7 });
    });

    it("emits cognitive_result event on async completion", async () => {
      const handler = handlers.get("_macro/cognitive/command")!;
      const result = await handler(context, { operation: "extract" });
      const jobId = (result as any).job_id;

      await new Promise((r) => setTimeout(r, 50));

      expect(eventStore.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          payload: expect.objectContaining({
            status_type: "cognitive_result",
            job_id: jobId,
            status: "completed",
          }),
        }),
      );
    });

    it("emits failure event when async operation fails", async () => {
      atlas = createMockAtlas({
        runBatchLearning: vi.fn().mockRejectedValue(new Error("Learning failed")),
      });

      const mock = createMockAdapter();
      handlers = mock.handlers;
      registerCognitiveExtensions(mock.adapter, { atlas, eventStore });

      const handler = handlers.get("_macro/cognitive/command")!;
      await handler(context, { operation: "extract" });

      await new Promise((r) => setTimeout(r, 50));

      expect(eventStore.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            status_type: "cognitive_result",
            status: "failed",
            error: "Learning failed",
          }),
        }),
      );
    });

    it("rejects unknown operations", async () => {
      const handler = handlers.get("_macro/cognitive/command")!;
      await expect(
        handler(context, { operation: "unknown" }),
      ).rejects.toThrow("Unknown operation");
    });

    it("rejects missing operation", async () => {
      const handler = handlers.get("_macro/cognitive/command")!;
      await expect(handler(context, {})).rejects.toThrow("operation is required");
    });

    it("rejects query without config.query", async () => {
      const handler = handlers.get("_macro/cognitive/command")!;
      await expect(
        handler(context, { operation: "query", config: {} }),
      ).rejects.toThrow("config.query is required");
    });

    it("rejects team-extract when not supported", async () => {
      atlas = createMockAtlas({ runTeamBatchLearning: undefined });
      const mock = createMockAdapter();
      handlers = mock.handlers;
      registerCognitiveExtensions(mock.adapter, { atlas, eventStore });

      const handler = handlers.get("_macro/cognitive/command")!;
      await expect(
        handler(context, { operation: "team-extract" }),
      ).rejects.toThrow("not supported");
    });

    it("rejects prune when not supported", async () => {
      atlas = createMockAtlas({ prune: undefined });
      const mock = createMockAdapter();
      handlers = mock.handlers;
      registerCognitiveExtensions(mock.adapter, { atlas, eventStore });

      const handler = handlers.get("_macro/cognitive/command")!;
      await expect(
        handler(context, { operation: "prune" }),
      ).rejects.toThrow("not supported");
    });
  });

  describe("_macro/cognitive/status", () => {
    it("returns availability and supported operations", async () => {
      const handler = handlers.get("_macro/cognitive/status")!;
      const result = await handler(context, {});

      expect((result as any).available).toBe(true);
      expect((result as any).operations).toContain("extract");
      expect((result as any).operations).toContain("query");
      expect((result as any).operations).toContain("team-extract");
      expect((result as any).operations).toContain("prune");
    });

    it("excludes unsupported operations from list", async () => {
      atlas = createMockAtlas({
        runTeamBatchLearning: undefined,
        prune: undefined,
      });
      const mock = createMockAdapter();
      handlers = mock.handlers;
      registerCognitiveExtensions(mock.adapter, { atlas, eventStore });

      const handler = handlers.get("_macro/cognitive/status")!;
      const result = await handler(context, {});

      expect((result as any).operations).toEqual(["extract", "query"]);
    });
  });

  describe("_macro/cognitive/query", () => {
    it("delegates to atlas.queryMemory()", async () => {
      const handler = handlers.get("_macro/cognitive/query")!;
      const result = await handler(context, {
        query: "How to handle errors?",
        options: { domains: ["backend"] },
      });

      expect(atlas.queryMemory).toHaveBeenCalledWith("How to handle errors?", {
        domains: ["backend"],
      });
      expect((result as any).result).toEqual({
        results: [{ content: "test insight" }],
      });
    });

    it("rejects missing query", async () => {
      const handler = handlers.get("_macro/cognitive/query")!;
      await expect(handler(context, {})).rejects.toThrow("query is required");
    });
  });

  describe("registration", () => {
    it("registers all cognitive methods", () => {
      expect(handlers.has("_macro/cognitive/command")).toBe(true);
      expect(handlers.has("_macro/cognitive/status")).toBe(true);
      expect(handlers.has("_macro/cognitive/query")).toBe(true);
    });

    it("unregisters all cognitive methods", () => {
      const mock = createMockAdapter();
      registerCognitiveExtensions(mock.adapter, { atlas, eventStore });
      unregisterCognitiveExtensions(mock.adapter);

      expect(mock.adapter.unregisterExtension).toHaveBeenCalledTimes(
        COGNITIVE_EXTENSION_METHODS.length,
      );
    });
  });
});
