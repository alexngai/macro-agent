/**
 * Unit tests for MCP Bridge Extensions (_macro/mcp/*)
 *
 * Tests the 17 server-side bridge handlers with mock adapter + mock services.
 * Follows the pattern from extensions.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerMCPBridgeExtensions,
  unregisterMCPBridgeExtensions,
  MCP_BRIDGE_METHODS,
  type MCPBridgeServices,
} from "../extensions/mcp-bridge.js";
import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { ParticipantCapabilities } from "../types.js";
import type { EventStore } from "../../../store/event-store.js";
import type { AgentManager } from "../../../agent/agent-manager.js";
import type { TaskManager } from "../../../task/task-manager.js";
import type { MessageRouter } from "../../../router/message-router.js";
import type { PeerManager } from "../../../peer/peer-manager.js";
import type { ActivityWatcher } from "../../../activity/watcher.js";
import type { TaskBackend } from "../../../task/backend/types.js";

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

function createMockEventStore(): EventStore {
  return {
    emit: vi.fn((input) => ({
      id: `evt_${Date.now()}`,
      version: 1,
      timestamp: Date.now(),
      ...input,
    })),
    query: vi.fn(() => []),
    getAgent: vi.fn(() => null),
    listAgents: vi.fn(() => []),
    getTask: vi.fn(() => null),
    listTasks: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    getFullMessage: vi.fn(() => null),
    addSubscription: vi.fn(),
    removeSubscription: vi.fn(),
    getSubscriptions: vi.fn(() => []),
    getSubscribers: vi.fn(() => []),
    onAgentChange: vi.fn(() => () => {}),
    onTaskChange: vi.fn(() => () => {}),
    onMessageChange: vi.fn(() => () => {}),
    persist: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    updateAgentMetadata: vi.fn(),
  } as unknown as EventStore;
}

function createMockAgentManager(): AgentManager {
  return {
    spawn: vi.fn(async (options: any) => ({
      id: "agent_spawned",
      session_id: "sess_spawned",
      agent: {
        id: "agent_spawned",
        session_id: "sess_spawned",
        task: options.task,
        task_id: "task_spawned",
        state: "running",
        parent: options.parent,
        lineage: [],
        config: {},
        cwd: options.cwd ?? "/test",
        created_at: Date.now(),
      },
      session: {} as any,
    })),
    terminate: vi.fn(async () => {}),
    resume: vi.fn(async () => ({} as any)),
    get: vi.fn(() => null),
    list: vi.fn(() => []),
    getChildren: vi.fn(() => []),
    getHierarchy: vi.fn(() => null),
    getOrCreateHeadManager: vi.fn(async () => ({} as any)),
    listHeadManagers: vi.fn(() => []),
    prompt: vi.fn(async function* () {}),
    getSession: vi.fn(() => null),
    hasActiveSession: vi.fn(() => false),
    onLifecycleEvent: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  } as unknown as AgentManager;
}

function createMockTaskManager(): TaskManager {
  return {
    create: vi.fn(() => ({
      id: "task_created",
      description: "test",
      status: "pending",
      created_at: Date.now(),
      created_by: "agent_test",
    })),
    get: vi.fn(() => null),
    list: vi.fn(() => []),
    getSubtasks: vi.fn(() => []),
    getSubtaskStatus: vi.fn(() => ({ total: 0, pending: 0, completed: 0, failed: 0 })),
    updateStatus: vi.fn(),
    assign: vi.fn(),
  } as unknown as TaskManager;
}

function createMockMessageRouter(): MessageRouter {
  return {
    sendToAddress: vi.fn(async () => ({
      id: "msg_123",
      delivered: [{ subscriber: "agent_target" }],
    })),
    getMessages: vi.fn(() => []),
  } as unknown as MessageRouter;
}

function createMockPeerManager(): PeerManager {
  return {
    hasTransport: vi.fn(() => true),
    sendMessage: vi.fn(async () => {}),
    sendRequest: vi.fn(async () => ({ result: "ok" })),
    respondToRequest: vi.fn(),
    getPeerMessages: vi.fn(() => []),
  } as unknown as PeerManager;
}

function createMockActivityWatcher(): ActivityWatcher {
  return {
    isRunning: vi.fn(() => true),
    start: vi.fn(),
    stop: vi.fn(),
    processActivity: vi.fn(),
    subscribeAgent: vi.fn(),
    unsubscribeAgent: vi.fn(),
  } as unknown as ActivityWatcher;
}

function createMockTaskBackend(): TaskBackend {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    claim: vi.fn(async () => ({})),
    unclaim: vi.fn(async () => {}),
  } as unknown as TaskBackend;
}

/**
 * Valid agent context included in params.context.
 */
function validContext() {
  return {
    agent_id: "agent_caller",
    session_id: "sess_caller",
    task_id: "task_caller",
    lineage: ["agent_root"],
    cwd: "/test/cwd",
  };
}

/**
 * Create params with valid context + additional args.
 */
function withContext(args: Record<string, unknown> = {}) {
  return { ...args, context: validContext() };
}

// =============================================================================
// Tests
// =============================================================================

describe("MCP Bridge Extensions", () => {
  let adapter: MAPAdapter & { handlers: Map<string, ExtensionHandler> };
  let services: MCPBridgeServices;
  let ctx: ExtensionContext;

  beforeEach(() => {
    adapter = createMockAdapter();
    services = {
      eventStore: createMockEventStore(),
      agentManager: createMockAgentManager(),
      taskManager: createMockTaskManager(),
      messageRouter: createMockMessageRouter(),
    };
    ctx = createMockContext();
  });

  // ─────────────────────────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────────────────────────

  describe("registration", () => {
    it("registers 10 core methods without optional services", () => {
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.size).toBe(10);
      expect(adapter.handlers.has("_macro/mcp/spawn_agent")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/emit_status")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/send_message")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/check_messages")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/query_index")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/get_hierarchy")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/get_agent_summary")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/stop_agent")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/done")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/inject_context")).toBe(true);
    });

    it("registers wait_for_activity when activityWatcher is provided", () => {
      services.activityWatcher = createMockActivityWatcher();
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/wait_for_activity")).toBe(true);
    });

    it("does not register wait_for_activity when activityWatcher is absent", () => {
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/wait_for_activity")).toBe(false);
    });

    it("registers task backend methods when taskBackend is provided", () => {
      services.taskBackend = createMockTaskBackend();
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/claim_task")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/unclaim_task")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/list_claimable_tasks")).toBe(true);
    });

    it("does not register task backend methods when taskBackend is absent", () => {
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/claim_task")).toBe(false);
      expect(adapter.handlers.has("_macro/mcp/unclaim_task")).toBe(false);
      expect(adapter.handlers.has("_macro/mcp/list_claimable_tasks")).toBe(false);
    });

    it("registers peer methods when peerManager is provided", () => {
      services.peerManager = createMockPeerManager();
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/send_peer_message")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/send_peer_request")).toBe(true);
      expect(adapter.handlers.has("_macro/mcp/respond_to_peer_request")).toBe(true);
    });

    it("does not register peer methods when peerManager is absent", () => {
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/send_peer_message")).toBe(false);
    });

    it("registers all 17 methods with all optional services", () => {
      services.activityWatcher = createMockActivityWatcher();
      services.taskBackend = createMockTaskBackend();
      services.peerManager = createMockPeerManager();
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.size).toBe(17);
    });

    it("unregisters all methods via unregisterMCPBridgeExtensions", () => {
      services.activityWatcher = createMockActivityWatcher();
      services.taskBackend = createMockTaskBackend();
      services.peerManager = createMockPeerManager();
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.size).toBe(17);

      unregisterMCPBridgeExtensions(adapter);
      expect(adapter.handlers.size).toBe(0);
    });

    it("MCP_BRIDGE_METHODS lists all 17 methods", () => {
      expect(MCP_BRIDGE_METHODS).toHaveLength(17);
      expect(MCP_BRIDGE_METHODS).toContain("_macro/mcp/spawn_agent");
      expect(MCP_BRIDGE_METHODS).toContain("_macro/mcp/done");
      expect(MCP_BRIDGE_METHODS).toContain("_macro/mcp/wait_for_activity");
      expect(MCP_BRIDGE_METHODS).toContain("_macro/mcp/claim_task");
      expect(MCP_BRIDGE_METHODS).toContain("_macro/mcp/send_peer_message");
      expect(MCP_BRIDGE_METHODS).toContain("_macro/mcp/respond_to_peer_request");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Context extraction
  // ─────────────────────────────────────────────────────────────────

  describe("context extraction", () => {
    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
    });

    it("rejects when params.context is missing", async () => {
      const handler = adapter.handlers.get("_macro/mcp/emit_status")!;
      await expect(handler(ctx, { summary: "test" })).rejects.toThrow(
        "params.context.agent_id is required"
      );
    });

    it("rejects when params.context.agent_id is missing", async () => {
      const handler = adapter.handlers.get("_macro/mcp/emit_status")!;
      await expect(
        handler(ctx, { context: { session_id: "s1" }, summary: "test" })
      ).rejects.toThrow("params.context.agent_id is required");
    });

    it("rejects when params is null", async () => {
      const handler = adapter.handlers.get("_macro/mcp/emit_status")!;
      await expect(handler(ctx, null)).rejects.toThrow(
        "params.context.agent_id is required"
      );
    });

    it("separates context from args correctly", async () => {
      const handler = adapter.handlers.get("_macro/mcp/emit_status")!;
      await handler(ctx, withContext({ status_type: "checkpoint", summary: "half done" }));

      expect(services.eventStore.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          source: { agent_id: "agent_caller" },
          payload: expect.objectContaining({
            status_type: "checkpoint",
            summary: "half done",
          }),
        })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // spawn_agent
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/mcp/spawn_agent", () => {
    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
    });

    it("calls agentManager.spawn with parent = context.agent_id", async () => {
      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      await handler(ctx, withContext({ task: "child task" }));

      expect(services.agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "child task",
          parent: "agent_caller",
        })
      );
    });

    it("returns agent_id, task_id, session_id", async () => {
      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      const result = (await handler(ctx, withContext({ task: "test" }))) as any;

      expect(result.agent_id).toBe("agent_spawned");
      expect(result.task_id).toBe("task_spawned");
      expect(result.session_id).toBe("sess_spawned");
    });

    it("defaults subscribe_parent to true and topics to []", async () => {
      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      await handler(ctx, withContext({ task: "test" }));

      expect(services.agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          subscribeParent: true,
          topics: [],
        })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // emit_status
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/mcp/emit_status", () => {
    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
    });

    it("emits status event via eventStore.emit", async () => {
      const handler = adapter.handlers.get("_macro/mcp/emit_status")!;
      const result = (await handler(
        ctx,
        withContext({ status_type: "checkpoint", summary: "50% done" })
      )) as any;

      expect(services.eventStore.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          source: { agent_id: "agent_caller" },
        })
      );
      expect(result.event_id).toBeDefined();
    });

    it("updates task status when complete_task is true and status is completed", async () => {
      const handler = adapter.handlers.get("_macro/mcp/emit_status")!;
      const result = (await handler(
        ctx,
        withContext({ status_type: "completed", summary: "done", complete_task: true })
      )) as any;

      expect(services.taskManager.updateStatus).toHaveBeenCalledWith("task_caller", "completed");
      expect(result.task_updated).toBe(true);
    });

    it("updates task status for failed with complete_task", async () => {
      const handler = adapter.handlers.get("_macro/mcp/emit_status")!;
      const result = (await handler(
        ctx,
        withContext({ status_type: "failed", summary: "error", complete_task: true })
      )) as any;

      expect(services.taskManager.updateStatus).toHaveBeenCalledWith("task_caller", "failed");
      expect(result.task_updated).toBe(true);
    });

    it("does not update task when complete_task is false", async () => {
      const handler = adapter.handlers.get("_macro/mcp/emit_status")!;
      const result = (await handler(
        ctx,
        withContext({ status_type: "completed", summary: "done", complete_task: false })
      )) as any;

      expect(services.taskManager.updateStatus).not.toHaveBeenCalled();
      expect(result.task_updated).toBe(false);
    });

    it("emits status_emitted MAP event for TUI subscribers", async () => {
      const handler = adapter.handlers.get("_macro/mcp/emit_status")!;
      await handler(
        ctx,
        withContext({ status_type: "checkpoint", summary: "50% done", details: "halfway" })
      );

      expect(adapter.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status_emitted",
          agentId: "agent_caller",
          data: expect.objectContaining({
            agentId: "agent_caller",
            taskId: "task_caller",
            statusType: "checkpoint",
            summary: "50% done",
            details: "halfway",
          }),
        })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // send_message
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/mcp/send_message", () => {
    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
    });

    it("sends to agent by agent_id", async () => {
      const handler = adapter.handlers.get("_macro/mcp/send_message")!;
      await handler(
        ctx,
        withContext({ to: { agent_id: "agent_target" }, content: "hello" })
      );

      expect(services.messageRouter.sendToAddress).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "agent_caller",
          to: { agent: "agent_target" },
          content: "hello",
        })
      );
    });

    it("sends to task by task_id", async () => {
      const handler = adapter.handlers.get("_macro/mcp/send_message")!;
      await handler(
        ctx,
        withContext({ to: { task_id: "task_target" }, content: "update" })
      );

      expect(services.messageRouter.sendToAddress).toHaveBeenCalledWith(
        expect.objectContaining({
          to: { task: "task_target" },
        })
      );
    });

    it("throws when 'to' is missing", async () => {
      const handler = adapter.handlers.get("_macro/mcp/send_message")!;
      await expect(
        handler(ctx, withContext({ content: "hello" }))
      ).rejects.toThrow("params.to is required");
    });

    it("throws when no target specified in to", async () => {
      const handler = adapter.handlers.get("_macro/mcp/send_message")!;
      await expect(
        handler(ctx, withContext({ to: {}, content: "hello" }))
      ).rejects.toThrow("Must specify one of");
    });

    it("returns message_id and delivered_to count", async () => {
      const handler = adapter.handlers.get("_macro/mcp/send_message")!;
      const result = (await handler(
        ctx,
        withContext({ to: { agent_id: "agent_target" }, content: "hello" })
      )) as any;

      expect(result.message_id).toBe("msg_123");
      expect(result.delivered_to).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // check_messages
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/mcp/check_messages", () => {
    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
    });

    it("returns formatted messages", async () => {
      (services.messageRouter.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: "msg_1",
          from: { agent_id: "agent_sender" },
          content: "hello",
          timestamp: 1000,
          truncated: false,
        },
      ]);

      const handler = adapter.handlers.get("_macro/mcp/check_messages")!;
      const result = (await handler(ctx, withContext({ limit: 10 }))) as any;

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].from).toBe("agent:agent_sender");
      expect(result.messages[0].content).toBe("hello");
    });

    it("returns total_pending count", async () => {
      (services.messageRouter.getMessages as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce([]) // limited query
        .mockReturnValueOnce([{ id: "m1" }, { id: "m2" }]); // all query

      const handler = adapter.handlers.get("_macro/mcp/check_messages")!;
      const result = (await handler(ctx, withContext({}))) as any;

      expect(result.total_pending).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // query_index
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/mcp/query_index", () => {
    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
    });

    it("queries agents when type is 'agents'", async () => {
      (services.agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "agent_1", task: "Task 1", state: "running" },
        { id: "agent_2", task: "Task 2", state: "stopped" },
      ]);

      const handler = adapter.handlers.get("_macro/mcp/query_index")!;
      const result = (await handler(ctx, withContext({ type: "agents" }))) as any;

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].type).toBe("agent");
      expect(result.total).toBe(2);
    });

    it("queries tasks when type is 'tasks'", async () => {
      (services.taskManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "task_1", description: "Do thing", status: "pending" },
      ]);

      const handler = adapter.handlers.get("_macro/mcp/query_index")!;
      const result = (await handler(ctx, withContext({ type: "tasks" }))) as any;

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].type).toBe("task");
    });

    it("applies state filter for agents", async () => {
      (services.agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "agent_1", task: "Task 1", state: "running" },
        { id: "agent_2", task: "Task 2", state: "stopped" },
      ]);

      const handler = adapter.handlers.get("_macro/mcp/query_index")!;
      const result = (await handler(
        ctx,
        withContext({ type: "agents", filter: { state: "running" } })
      )) as any;

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].id).toBe("agent_1");
    });

    it("returns has_more flag with pagination", async () => {
      const agents = Array.from({ length: 25 }, (_, i) => ({
        id: `agent_${i}`,
        task: `Task ${i}`,
        state: "running",
      }));
      (services.agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue(agents);

      const handler = adapter.handlers.get("_macro/mcp/query_index")!;
      const result = (await handler(
        ctx,
        withContext({ type: "agents", limit: 10 })
      )) as any;

      expect(result.entries).toHaveLength(10);
      expect(result.total).toBe(25);
      expect(result.has_more).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // get_hierarchy
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/mcp/get_hierarchy", () => {
    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
    });

    it("returns hierarchy tree for agent", async () => {
      (services.agentManager.getHierarchy as ReturnType<typeof vi.fn>).mockReturnValue({
        root: {
          agent: { id: "agent_root", task: "Root task", state: "running" },
          children: [],
        },
        depth: 1,
        totalAgents: 1,
      });

      const handler = adapter.handlers.get("_macro/mcp/get_hierarchy")!;
      const result = (await handler(
        ctx,
        withContext({ root: "agent_root" })
      )) as any;

      expect(result.tree.agent_id).toBe("agent_root");
      expect(result.depth).toBe(1);
      expect(result.total_agents).toBe(1);
    });

    it("throws notFound for non-existent agent", async () => {
      const handler = adapter.handlers.get("_macro/mcp/get_hierarchy")!;
      await expect(
        handler(ctx, withContext({ root: "nonexistent" }))
      ).rejects.toThrow("not found");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // get_agent_summary
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/mcp/get_agent_summary", () => {
    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
    });

    it("returns agent details", async () => {
      (services.agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "agent_target",
        session_id: "sess_target",
        task: "Target task",
        state: "running",
        parent: "agent_root",
        created_at: 1000,
      });
      (services.agentManager.getChildren as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "child_1" },
      ]);

      const handler = adapter.handlers.get("_macro/mcp/get_agent_summary")!;
      const result = (await handler(
        ctx,
        withContext({ agent_id: "agent_target" })
      )) as any;

      expect(result.id).toBe("agent_target");
      expect(result.task).toBe("Target task");
      expect(result.children_count).toBe(1);
    });

    it("throws notFound for non-existent agent", async () => {
      const handler = adapter.handlers.get("_macro/mcp/get_agent_summary")!;
      await expect(
        handler(ctx, withContext({ agent_id: "nonexistent" }))
      ).rejects.toThrow("not found");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // stop_agent
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/mcp/stop_agent", () => {
    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
    });

    it("terminates agent in caller's subtree", async () => {
      (services.agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "agent_child",
        state: "running",
        lineage: ["agent_root", "agent_caller"],
      });
      (services.agentManager.getChildren as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const handler = adapter.handlers.get("_macro/mcp/stop_agent")!;
      const result = (await handler(
        ctx,
        withContext({ agent_id: "agent_child" })
      )) as any;

      expect(services.agentManager.terminate).toHaveBeenCalledWith("agent_child", "cancelled");
      expect(result.success).toBe(true);
      expect(result.stopped_agents).toContain("agent_child");
    });

    it("throws permissionDenied for agent outside subtree", async () => {
      (services.agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "agent_other",
        state: "running",
        lineage: ["agent_root"],
      });

      const handler = adapter.handlers.get("_macro/mcp/stop_agent")!;
      await expect(
        handler(ctx, withContext({ agent_id: "agent_other" }))
      ).rejects.toThrow("Cannot stop agent outside your subtree");
    });

    it("throws notFound for non-existent agent", async () => {
      const handler = adapter.handlers.get("_macro/mcp/stop_agent")!;
      await expect(
        handler(ctx, withContext({ agent_id: "nonexistent" }))
      ).rejects.toThrow("not found");
    });

    it("allows stopping self", async () => {
      (services.agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "agent_caller",
        state: "running",
        lineage: ["agent_root"],
      });
      (services.agentManager.getChildren as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const handler = adapter.handlers.get("_macro/mcp/stop_agent")!;
      const result = (await handler(
        ctx,
        withContext({ agent_id: "agent_caller" })
      )) as any;

      expect(result.success).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // done (delegates to createDoneHandler)
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/mcp/done", () => {
    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
      // done handler needs the agent to exist for role resolution
      (services.agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "agent_caller",
        state: "running",
        role: "worker",
        task_id: "task_caller",
        parent: "agent_root",
        lineage: ["agent_root"],
      });
    });

    it("delegates to createDoneHandler and returns result", async () => {
      const handler = adapter.handlers.get("_macro/mcp/done")!;
      const result = (await handler(
        ctx,
        withContext({ status: "completed", summary: "all done" })
      )) as any;

      // The done handler should return a result with shouldTerminate
      expect(result).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // spawn_agent — fire-and-forget prompt session streaming
  // ─────────────────────────────────────────────────────────────────

  describe("spawn_agent session streaming", () => {
    /**
     * Helper: wait until adapter.emitEvent has been called with a specific event type.
     * Polls every 10ms up to timeoutMs.
     */
    async function waitForEmitEvent(
      emitFn: ReturnType<typeof vi.fn>,
      eventType: string,
      timeoutMs = 5000,
    ): Promise<unknown> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const call = emitFn.mock.calls.find(
          (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === eventType,
        );
        if (call) return call[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(
        `Timeout waiting for emitEvent(${eventType}). ` +
          `Received: ${emitFn.mock.calls.map((c: unknown[]) => (c[0] as Record<string, unknown>)?.type).join(", ")}`,
      );
    }

    beforeEach(() => {
      registerMCPBridgeExtensions(adapter, services);
    });

    it("emits session_user_message MAP event before prompt starts", async () => {
      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      await handler(ctx, withContext({ task: "do something" }));

      // Fire-and-forget IIFE starts immediately — wait for it
      const event = await waitForEmitEvent(adapter.emitEvent as ReturnType<typeof vi.fn>, "session_user_message");
      const evt = event as Record<string, unknown>;
      expect(evt.type).toBe("session_user_message");
      expect(evt.agentId).toBe("agent_spawned");
      expect(evt.eventId).toBeDefined();
      expect(evt.timestamp).toBeGreaterThan(0);

      const data = evt.data as Record<string, unknown>;
      expect(data.agentId).toBe("agent_spawned");
      expect(data.sessionId).toBe("sess_spawned");
      expect(data.content).toBe("do something");
    });

    it("emits session_prompt_done MAP event after prompt completes", async () => {
      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      await handler(ctx, withContext({ task: "finish this" }));

      const event = await waitForEmitEvent(adapter.emitEvent as ReturnType<typeof vi.fn>, "session_prompt_done");
      const evt = event as Record<string, unknown>;
      expect(evt.type).toBe("session_prompt_done");
      expect(evt.agentId).toBe("agent_spawned");

      const data = evt.data as Record<string, unknown>;
      expect(data.agentId).toBe("agent_spawned");
      expect(data.stopReason).toBe("end_turn");
    });

    it("emits session_update MAP events for each prompt update", async () => {
      // Configure prompt to yield controlled updates
      const updates = [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } },
        { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "Read file", status: "running" },
        { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "Read file", status: "completed", rawOutput: "contents" },
      ];

      (services.agentManager.prompt as ReturnType<typeof vi.fn>).mockImplementation(
        async function* () {
          for (const u of updates) {
            yield u;
          }
        },
      );

      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      await handler(ctx, withContext({ task: "read a file" }));

      // Wait for the final event
      await waitForEmitEvent(adapter.emitEvent as ReturnType<typeof vi.fn>, "session_prompt_done");

      // Collect all emitEvent calls
      const calls = (adapter.emitEvent as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as Record<string, unknown>,
      );

      // Should have: 1 user_message + 4 session_updates + 1 prompt_done = 6 events
      const userMessages = calls.filter((c) => c.type === "session_user_message");
      const sessionUpdates = calls.filter((c) => c.type === "session_update");
      const promptDones = calls.filter((c) => c.type === "session_prompt_done");

      expect(userMessages).toHaveLength(1);
      expect(sessionUpdates).toHaveLength(4);
      expect(promptDones).toHaveLength(1);

      // Verify update payloads contain the original update objects
      const updatePayloads = sessionUpdates.map(
        (c) => (c.data as Record<string, unknown>).update,
      );
      expect((updatePayloads[0] as Record<string, unknown>).sessionUpdate).toBe("agent_message_chunk");
      expect((updatePayloads[2] as Record<string, unknown>).sessionUpdate).toBe("tool_call");
    });

    it("records user and assistant turns in eventStore after prompt completes", async () => {
      const updates = [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I will help." } },
      ];

      (services.agentManager.prompt as ReturnType<typeof vi.fn>).mockImplementation(
        async function* () {
          for (const u of updates) yield u;
        },
      );

      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      await handler(ctx, withContext({ task: "help me" }));

      // Wait for prompt to finish
      await waitForEmitEvent(adapter.emitEvent as ReturnType<typeof vi.fn>, "session_prompt_done");

      // Small delay for turn recording (happens after emitMAPEvent)
      await new Promise((r) => setTimeout(r, 50));

      // Check eventStore.emit calls for turn recording
      const turnCalls = (services.eventStore.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "turn",
      );

      expect(turnCalls.length).toBe(2);

      // First turn: user prompt
      const userTurn = turnCalls[0][0] as Record<string, unknown>;
      expect(userTurn.type).toBe("turn");
      expect((userTurn.source as Record<string, unknown>).agent_id).toBe("agent_spawned");
      const userPayload = userTurn.payload as Record<string, unknown>;
      expect(userPayload.participant).toBe("user");
      expect(userPayload.content).toBe("help me");
      expect(userPayload.conversation_id).toBe("sess_spawned");

      // Second turn: assistant response
      const assistantTurn = turnCalls[1][0] as Record<string, unknown>;
      const assistantPayload = assistantTurn.payload as Record<string, unknown>;
      expect(assistantPayload.participant).toBe("agent_spawned");
      expect(assistantPayload.content_type).toBe("assistant_response");
      const content = assistantPayload.content as { parts: Array<{ type: string; text?: string }> };
      expect(content.parts[0].type).toBe("text");
      expect(content.parts[0].text).toBe("I will help.");
    });

    it("accumulates tool calls in assistant turn content", async () => {
      const updates = [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading file..." } },
        { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "Read", status: "running", _meta: { claudeCode: { toolName: "Read" } }, rawInput: { path: "/foo" } },
        { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "Read", status: "completed", rawOutput: "file contents", _meta: { claudeCode: { toolName: "Read" } }, rawInput: { path: "/foo" } },
      ];

      (services.agentManager.prompt as ReturnType<typeof vi.fn>).mockImplementation(
        async function* () {
          for (const u of updates) yield u;
        },
      );

      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      await handler(ctx, withContext({ task: "read /foo" }));

      await waitForEmitEvent(adapter.emitEvent as ReturnType<typeof vi.fn>, "session_prompt_done");
      await new Promise((r) => setTimeout(r, 50));

      const turnCalls = (services.eventStore.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "turn",
      );

      const assistantTurn = turnCalls[1][0] as Record<string, unknown>;
      const assistantPayload = assistantTurn.payload as Record<string, unknown>;
      const content = assistantPayload.content as { parts: Array<Record<string, unknown>> };

      // Should have text part + tool part
      expect(content.parts).toHaveLength(2);
      expect(content.parts[0].type).toBe("text");
      expect(content.parts[0].text).toBe("Reading file...");
      expect(content.parts[1].type).toBe("tool");
      expect(content.parts[1].toolCallId).toBe("tc_1");
      expect(content.parts[1].name).toBe("Read");
      expect(content.parts[1].output).toBe("file contents");
    });

    it("emits session_prompt_done with stopReason 'error' when prompt throws", async () => {
      (services.agentManager.prompt as ReturnType<typeof vi.fn>).mockImplementation(
        async function* () {
          throw new Error("Agent process crashed");
        },
      );

      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      await handler(ctx, withContext({ task: "crash test" }));

      const event = await waitForEmitEvent(adapter.emitEvent as ReturnType<typeof vi.fn>, "session_prompt_done");
      const evt = event as Record<string, unknown>;
      const data = evt.data as Record<string, unknown>;
      expect(data.stopReason).toBe("error");
    });

    it("does not emit session events when task is empty", async () => {
      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      await handler(ctx, withContext({ task: "" }));

      // Wait a bit to ensure no events are emitted
      await new Promise((r) => setTimeout(r, 100));

      expect(adapter.emitEvent).not.toHaveBeenCalled();
    });

    it("all events include agentId at the top level for subscription routing", async () => {
      const handler = adapter.handlers.get("_macro/mcp/spawn_agent")!;
      await handler(ctx, withContext({ task: "routing test" }));

      await waitForEmitEvent(adapter.emitEvent as ReturnType<typeof vi.fn>, "session_prompt_done");

      const calls = (adapter.emitEvent as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as Record<string, unknown>,
      );

      for (const evt of calls) {
        expect(evt.agentId).toBe("agent_spawned");
        expect(evt.eventId).toBeDefined();
        expect(evt.timestamp).toBeGreaterThan(0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Optional handler: activityWatcher absent
  // ─────────────────────────────────────────────────────────────────

  describe("optional handlers - activityWatcher absent", () => {
    it("wait_for_activity is not registered when absent", () => {
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/wait_for_activity")).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Optional handler: taskBackend absent
  // ─────────────────────────────────────────────────────────────────

  describe("optional handlers - taskBackend absent", () => {
    it("claim_task is not registered when absent", () => {
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/claim_task")).toBe(false);
    });

    it("unclaim_task is not registered when absent", () => {
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/unclaim_task")).toBe(false);
    });

    it("list_claimable_tasks is not registered when absent", () => {
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/list_claimable_tasks")).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Optional handler: peerManager absent
  // ─────────────────────────────────────────────────────────────────

  describe("optional handlers - peerManager absent", () => {
    it("send_peer_message is not registered when absent", () => {
      registerMCPBridgeExtensions(adapter, services);
      expect(adapter.handlers.has("_macro/mcp/send_peer_message")).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Peer bridges (with peerManager)
  // ─────────────────────────────────────────────────────────────────

  describe("peer bridges", () => {
    beforeEach(() => {
      services.peerManager = createMockPeerManager();
      registerMCPBridgeExtensions(adapter, services);
    });

    it("send_peer_message sends via peerManager", async () => {
      const handler = adapter.handlers.get("_macro/mcp/send_peer_message")!;
      await handler(
        ctx,
        withContext({ to: "peer_target", type: "status", payload: { data: 1 } })
      );

      expect(services.peerManager!.sendMessage).toHaveBeenCalledWith(
        "agent_caller",
        "peer_target",
        expect.objectContaining({ type: "status", payload: { data: 1 } })
      );
    });

    it("send_peer_request sends via peerManager and returns result", async () => {
      const handler = adapter.handlers.get("_macro/mcp/send_peer_request")!;
      const result = await handler(
        ctx,
        withContext({ to: "peer_target", method: "getStatus", params: {} })
      );

      expect(services.peerManager!.sendRequest).toHaveBeenCalled();
      expect(result).toEqual({ result: "ok" });
    });

    it("respond_to_peer_request calls peerManager.respondToRequest", async () => {
      const handler = adapter.handlers.get("_macro/mcp/respond_to_peer_request")!;
      await handler(
        ctx,
        withContext({ request_id: "req_1", result: { data: 42 } })
      );

      expect(services.peerManager!.respondToRequest).toHaveBeenCalledWith(
        "agent_caller",
        "req_1",
        expect.objectContaining({ result: { data: 42 } })
      );
    });
  });
});
