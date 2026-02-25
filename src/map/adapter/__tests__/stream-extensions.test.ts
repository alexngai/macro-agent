/**
 * Tests for Stream/Checkpoint/DiffStack/MergeQueue Extension Methods
 *
 * Tests the handlers using mock services.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerStreamExtensions,
  unregisterStreamExtensions,
  STREAM_EXTENSION_METHODS,
  type StreamExtensionServices,
} from "../extensions/streams.js";
import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { Stream, StreamNode, Checkpoint, DiffStack, DiffStackWithCheckpoints } from "git-cascade";
import type { MergeRequest } from "../../../workspace/merge-queue/types.js";

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
    sendMessage: vi.fn(),
    listAgents: vi.fn().mockReturnValue([]),
    getAgent: vi.fn(),
    listScopes: vi.fn().mockReturnValue([]),
    getScope: vi.fn(),
    emitEvent: vi.fn(),
    onEvent: vi.fn().mockReturnValue(() => {}),
    config: {},
  } as unknown as MAPAdapter & { handlers: Map<string, ExtensionHandler> };
}

function createMockContext(participantId = "test-participant"): ExtensionContext {
  return {
    participantId,
    capabilities: { canQuery: true, canMessage: true, canManageTasks: true } as any,
    sessionId: "test-session",
  };
}

// Sample data
const mockStream: Stream = {
  id: "stream-1",
  name: "main-integration",
  agentId: "agent-1",
  baseCommit: "abc123",
  parentStream: null,
  branchPointCommit: null,
  status: "active",
  createdAt: 1000,
  updatedAt: 2000,
  mergedInto: null,
  enableStackedReview: false,
  metadata: {},
  existingBranch: null,
  isLocalMode: false,
};

const mockChildStream: Stream = {
  ...mockStream,
  id: "stream-2",
  name: "feature-branch",
  parentStream: "stream-1",
};

const mockCheckpoint: Checkpoint = {
  id: "cp-1",
  streamId: "stream-1",
  commitSha: "abcdef1234567890",
  parentCommit: "0000000000000000",
  originalCommit: null,
  changeId: "change-1",
  message: "Added login feature",
  createdAt: 3000,
  createdBy: "agent-1",
};

const mockDiffStack: DiffStack = {
  id: "ds-1",
  name: "login-stack",
  description: "Login feature stack",
  targetBranch: "main",
  reviewStatus: "pending",
  reviewedBy: null,
  reviewedAt: null,
  reviewNotes: null,
  queuePosition: null,
  createdAt: 4000,
  createdBy: "agent-1",
};

const mockDiffStackWithCps: DiffStackWithCheckpoints = {
  ...mockDiffStack,
  checkpoints: [{ ...mockCheckpoint, position: 0 }] as any,
};

const mockMergeRequest: MergeRequest = {
  id: "mr-1",
  streamId: "stream-1",
  taskId: "task-1",
  workerBranch: "worker/agent-1/task-1",
  workerAgentId: "agent-1",
  status: "pending",
  priority: 0,
  position: 1,
  submittedAt: 5000,
  startedAt: null,
  completedAt: null,
  mergeCommit: null,
  conflictFiles: null,
  resolverTaskId: null,
  metadata: null,
};

function createMockServices(): StreamExtensionServices {
  return {
    getStream: vi.fn((id: string) => (id === "stream-1" ? mockStream : id === "stream-2" ? mockChildStream : null)),
    listStreams: vi.fn(() => [mockStream, mockChildStream]),
    getStreamBranchName: vi.fn((id: string) => `stream/${id}`),
    getStreamHierarchy: vi.fn(() => [
      {
        stream: mockStream,
        children: [{ stream: mockChildStream, children: [], tasks: [] }],
        tasks: [],
      } as StreamNode,
    ]),
    getCheckpoint: vi.fn((id: string) => (id === "cp-1" ? mockCheckpoint : null)),
    getCheckpointsForStream: vi.fn((streamId: string) =>
      streamId === "stream-1" ? [mockCheckpoint] : [],
    ),
    forkFromCheckpoint: vi.fn(() => "stream-3"),
    getDiffStack: vi.fn((id: string) => (id === "ds-1" ? mockDiffStack : null)),
    getDiffStackWithCheckpoints: vi.fn((id: string) =>
      id === "ds-1" ? mockDiffStackWithCps : null,
    ),
    listDiffStacks: vi.fn(() => [mockDiffStack]),
    createDiffStack: vi.fn(() => mockDiffStack),
    addCheckpointToStack: vi.fn(),
    getMergeQueueRequests: vi.fn(() => [mockMergeRequest]),
    getMergeQueueDepth: vi.fn(() => 1),
    getMergeRequest: vi.fn((id: string) => (id === "mr-1" ? mockMergeRequest : null)),
    createPR: vi.fn(async () => ({ prUrl: "https://github.com/test/repo/pull/1", prNumber: 1 })),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("Stream Extensions", () => {
  let adapter: ReturnType<typeof createMockAdapter>;
  let services: ReturnType<typeof createMockServices>;
  let context: ExtensionContext;

  beforeEach(() => {
    adapter = createMockAdapter();
    services = createMockServices();
    context = createMockContext();
    registerStreamExtensions(adapter, services);
  });

  describe("registration", () => {
    it("registers all extension methods", () => {
      for (const method of STREAM_EXTENSION_METHODS) {
        expect(adapter.handlers.has(method)).toBe(true);
      }
    });

    it("registers exactly 13 methods", () => {
      expect(adapter.handlers.size).toBe(13);
    });

    it("unregisters all methods", () => {
      unregisterStreamExtensions(adapter);
      expect(adapter.unregisterExtension).toHaveBeenCalledTimes(13);
    });
  });

  describe("_macro/streams/list", () => {
    it("returns all streams", async () => {
      const handler = adapter.handlers.get("_macro/streams/list")!;
      const result = (await handler(context, {})) as any;

      expect(result.streams).toHaveLength(2);
      expect(result.streams[0].id).toBe("stream-1");
      expect(result.streams[0].branchName).toBe("stream/stream-1");
      expect(result.streams[0].checkpointCount).toBe(1);
    });

    it("filters by status", async () => {
      const handler = adapter.handlers.get("_macro/streams/list")!;
      await handler(context, { filter: { status: "active" } });

      expect(services.listStreams).toHaveBeenCalledWith({ agentId: undefined, status: "active" });
    });

    it("filters by parentStream", async () => {
      const handler = adapter.handlers.get("_macro/streams/list")!;
      const result = (await handler(context, { filter: { parentStream: "stream-1" } })) as any;

      // Only stream-2 has parentStream === "stream-1"
      expect(result.streams).toHaveLength(1);
      expect(result.streams[0].id).toBe("stream-2");
    });
  });

  describe("_macro/streams/get", () => {
    it("returns stream info", async () => {
      const handler = adapter.handlers.get("_macro/streams/get")!;
      const result = (await handler(context, { streamId: "stream-1" })) as any;

      expect(result.stream.id).toBe("stream-1");
      expect(result.stream.name).toBe("main-integration");
      expect(result.stream.status).toBe("active");
    });

    it("throws on missing streamId", async () => {
      const handler = adapter.handlers.get("_macro/streams/get")!;
      await expect(handler(context, {})).rejects.toThrow("streamId is required");
    });

    it("throws on stream not found", async () => {
      const handler = adapter.handlers.get("_macro/streams/get")!;
      await expect(handler(context, { streamId: "nonexistent" })).rejects.toThrow(
        "Stream not found",
      );
    });

    it("includes children when requested", async () => {
      const handler = adapter.handlers.get("_macro/streams/get")!;
      const result = (await handler(context, {
        streamId: "stream-1",
        includeChildren: true,
      })) as any;

      expect(result.stream.id).toBe("stream-1");
      expect(result.children).toBeDefined();
    });
  });

  describe("_macro/streams/hierarchy", () => {
    it("returns stream tree", async () => {
      const handler = adapter.handlers.get("_macro/streams/hierarchy")!;
      const result = (await handler(context, {})) as any;

      expect(result.roots).toHaveLength(1);
      expect(result.roots[0].stream.id).toBe("stream-1");
      expect(result.roots[0].children).toHaveLength(1);
      expect(result.roots[0].children[0].stream.id).toBe("stream-2");
    });
  });

  describe("_macro/streams/createPR", () => {
    it("creates PR for stream", async () => {
      const handler = adapter.handlers.get("_macro/streams/createPR")!;
      const result = (await handler(context, {
        streamId: "stream-1",
        title: "My PR",
        draft: true,
      })) as any;

      expect(result.prUrl).toBe("https://github.com/test/repo/pull/1");
      expect(services.createPR).toHaveBeenCalledWith({
        branch: "stream/stream-1",
        targetBranch: "main",
        title: "My PR",
        body: undefined,
        draft: true,
      });
    });

    it("throws on missing streamId", async () => {
      const handler = adapter.handlers.get("_macro/streams/createPR")!;
      await expect(handler(context, {})).rejects.toThrow("streamId is required");
    });
  });

  describe("_macro/checkpoints/list", () => {
    it("returns checkpoints for stream", async () => {
      const handler = adapter.handlers.get("_macro/checkpoints/list")!;
      const result = (await handler(context, { streamId: "stream-1" })) as any;

      expect(result.checkpoints).toHaveLength(1);
      expect(result.checkpoints[0].id).toBe("cp-1");
      expect(result.checkpoints[0].commitShaShort).toBe("abcdef12");
    });

    it("throws on missing streamId", async () => {
      const handler = adapter.handlers.get("_macro/checkpoints/list")!;
      await expect(handler(context, {})).rejects.toThrow("streamId is required");
    });

    it("throws on stream not found", async () => {
      const handler = adapter.handlers.get("_macro/checkpoints/list")!;
      await expect(handler(context, { streamId: "nonexistent" })).rejects.toThrow(
        "Stream not found",
      );
    });
  });

  describe("_macro/checkpoints/get", () => {
    it("returns checkpoint info", async () => {
      const handler = adapter.handlers.get("_macro/checkpoints/get")!;
      const result = (await handler(context, { checkpointId: "cp-1" })) as any;

      expect(result.checkpoint.id).toBe("cp-1");
      expect(result.checkpoint.message).toBe("Added login feature");
    });

    it("throws on checkpoint not found", async () => {
      const handler = adapter.handlers.get("_macro/checkpoints/get")!;
      await expect(handler(context, { checkpointId: "nonexistent" })).rejects.toThrow(
        "Checkpoint not found",
      );
    });
  });

  describe("_macro/checkpoints/select", () => {
    it("forks from checkpoint", async () => {
      const handler = adapter.handlers.get("_macro/checkpoints/select")!;
      const result = (await handler(context, {
        streamId: "stream-1",
        checkpointId: "cp-1",
      })) as any;

      expect(result.success).toBe(true);
      expect(result.newStreamId).toBe("stream-3");
      expect(result.commitSha).toBe("abcdef1234567890");
      expect(services.forkFromCheckpoint).toHaveBeenCalledWith({
        checkpointId: "cp-1",
        name: "fork-from-cp-1",
        agentId: "external:test-participant",
      });
    });

    it("throws when checkpoint does not belong to stream", async () => {
      // cp-1 belongs to stream-1, not stream-2
      const handler = adapter.handlers.get("_macro/checkpoints/select")!;
      await expect(
        handler(context, { streamId: "stream-2", checkpointId: "cp-1" }),
      ).rejects.toThrow("does not belong to stream");
    });
  });

  describe("_macro/diffStacks/list", () => {
    it("returns diff stacks", async () => {
      const handler = adapter.handlers.get("_macro/diffStacks/list")!;
      const result = (await handler(context, {})) as any;

      expect(result.diffStacks).toHaveLength(1);
      expect(result.diffStacks[0].id).toBe("ds-1");
      expect(result.diffStacks[0].name).toBe("login-stack");
    });
  });

  describe("_macro/diffStacks/get", () => {
    it("returns diff stack with checkpoints", async () => {
      const handler = adapter.handlers.get("_macro/diffStacks/get")!;
      const result = (await handler(context, { diffStackId: "ds-1" })) as any;

      expect(result.diffStack.id).toBe("ds-1");
      expect(result.checkpoints).toHaveLength(1);
      expect(result.checkpoints[0].id).toBe("cp-1");
    });

    it("throws on not found", async () => {
      const handler = adapter.handlers.get("_macro/diffStacks/get")!;
      await expect(handler(context, { diffStackId: "nonexistent" })).rejects.toThrow(
        "DiffStack not found",
      );
    });
  });

  describe("_macro/diffStacks/create", () => {
    it("creates diff stack with checkpoints", async () => {
      const handler = adapter.handlers.get("_macro/diffStacks/create")!;
      const result = (await handler(context, {
        name: "new-stack",
        streamId: "stream-1",
        checkpointIds: ["cp-1"],
        targetBranch: "main",
        description: "Test stack",
      })) as any;

      expect(result.diffStack.id).toBe("ds-1");
      expect(services.createDiffStack).toHaveBeenCalledWith({
        name: "new-stack",
        targetBranch: "main",
        description: "Test stack",
        createdBy: "external:test-participant",
      });
      expect(services.addCheckpointToStack).toHaveBeenCalledWith({
        stackId: "ds-1",
        checkpointId: "cp-1",
        position: 0,
      });
    });

    it("throws on empty checkpointIds", async () => {
      const handler = adapter.handlers.get("_macro/diffStacks/create")!;
      await expect(
        handler(context, {
          name: "stack",
          checkpointIds: [],
          targetBranch: "main",
        }),
      ).rejects.toThrow("checkpointIds is required");
    });
  });

  describe("_macro/diffStacks/createPR", () => {
    it("creates PR from diff stack", async () => {
      const handler = adapter.handlers.get("_macro/diffStacks/createPR")!;
      const result = (await handler(context, {
        diffStackId: "ds-1",
        title: "PR from stack",
        draft: false,
      })) as any;

      expect(result.prUrl).toBe("https://github.com/test/repo/pull/1");
      expect(services.createPR).toHaveBeenCalledWith({
        branch: "stream/stream-1",
        targetBranch: "main",
        title: "PR from stack",
        body: undefined,
        draft: false,
      });
    });
  });

  describe("_macro/mergeQueue/status", () => {
    it("returns merge queue status", async () => {
      const handler = adapter.handlers.get("_macro/mergeQueue/status")!;
      const result = (await handler(context, {})) as any;

      expect(result.queueDepth).toBe(1);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].id).toBe("mr-1");
      expect(result.requests[0].status).toBe("pending");
    });

    it("filters by streamId", async () => {
      const handler = adapter.handlers.get("_macro/mergeQueue/status")!;
      await handler(context, { streamId: "stream-1" });

      expect(services.getMergeQueueRequests).toHaveBeenCalledWith("stream-1");
      expect(services.getMergeQueueDepth).toHaveBeenCalledWith("stream-1");
    });
  });

  describe("_macro/mergeQueue/get", () => {
    it("returns merge request", async () => {
      const handler = adapter.handlers.get("_macro/mergeQueue/get")!;
      const result = (await handler(context, { requestId: "mr-1" })) as any;

      expect(result.request.id).toBe("mr-1");
      expect(result.request.workerAgentId).toBe("agent-1");
    });

    it("throws on not found", async () => {
      const handler = adapter.handlers.get("_macro/mergeQueue/get")!;
      await expect(handler(context, { requestId: "nonexistent" })).rejects.toThrow(
        "Merge request not found",
      );
    });
  });
});
