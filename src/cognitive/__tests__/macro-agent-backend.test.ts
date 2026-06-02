import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExtendedSessionUpdate } from "acp-factory";
import { MacroAgentBackend } from "../macro-agent-backend.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { RoleRegistry, RoleDefinition } from "../../roles/types.js";

// ── Mock Helpers ─────────────────────────────────────────────────

// Stand-in for the built-in "generic" role the REAL DefaultRoleRegistry falls
// back to. Used by resolveRole() below so the mock matches production
// semantics (resolveRole NEVER throws on a miss).
const GENERIC_FALLBACK = { name: "generic" } as unknown as RoleDefinition;

function createMockRoleRegistry(): RoleRegistry {
  const roles = new Map<string, RoleDefinition>();
  return {
    registerRole: vi.fn((role: RoleDefinition) => {
      roles.set(role.name, role);
    }),
    // MUST mirror the real DefaultRoleRegistry.resolveRole(): on an unknown
    // role it does NOT throw — it logs and returns the GenericRole fallback.
    // A throwing mock (the old behavior) masked the constructor bug where
    // analyst registration was gated on resolveRole() throwing.
    resolveRole: vi.fn((name: string) => {
      return roles.get(name) ?? GENERIC_FALLBACK;
    }),
    getRole: vi.fn((name: string) => roles.get(name)),
    hasCapability: vi.fn(() => true),
    listRoles: vi.fn(() => [...roles.values()]),
  } as unknown as RoleRegistry;
}

function createMockAgentManager(
  overrides?: Partial<AgentManager>,
): AgentManager {
  const registry = createMockRoleRegistry();

  return {
    spawn: vi.fn().mockResolvedValue({
      id: "agent_test123",
      session_id: "session_test123",
    }),
    prompt: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        // Empty iterator by default
      },
    }),
    promptUntilDone: vi.fn().mockResolvedValue({
      doneCalled: true,
      doneStatus: "completed",
      exceededMax: false,
      followUpCount: 0,
      updates: [],
    }),
    terminate: vi.fn().mockResolvedValue(undefined),
    getRoleRegistry: vi.fn().mockReturnValue(registry),
    supportsInjection: vi.fn().mockResolvedValue(false),
    get: vi.fn(),
    list: vi.fn(),
    getChildren: vi.fn(),
    getHierarchy: vi.fn(),
    getOrCreateHeadManager: vi.fn(),
    listHeadManagers: vi.fn(),
    getSession: vi.fn(),
    hasActiveSession: vi.fn(),
    isPrompting: vi.fn(),
    isProcessRunning: vi.fn(),
    respondToPermission: vi.fn(),
    cancelPermission: vi.fn(),
    setPermissionMode: vi.fn(),
    getPermissionMode: vi.fn(),
    onLifecycleEvent: vi.fn(),
    setSpawnInterceptor: vi.fn(),
    setOpenTasksSocketPath: vi.fn(),
    setMailServices: vi.fn(),
    close: vi.fn(),
    continue: vi.fn(),
    forkAgent: vi.fn(),
    ...overrides,
  } as unknown as AgentManager;
}

// ── Tests ────────────────────────────────────────────────────────

describe("MacroAgentBackend", () => {
  let agentManager: AgentManager;
  let backend: MacroAgentBackend;

  beforeEach(() => {
    agentManager = createMockAgentManager();
    backend = new MacroAgentBackend(agentManager);
  });

  describe("constructor", () => {
    it("registers analyst role in registry", () => {
      const registry = agentManager.getRoleRegistry();
      expect(registry.registerRole).toHaveBeenCalledWith(
        expect.objectContaining({ name: "analyst" }),
      );
    });

    it("registers analyst against a real-semantics registry (resolveRole does NOT throw on miss)", () => {
      // Regression guard for the live Arm-B bug: the constructor must NOT rely
      // on resolveRole() throwing to detect a missing analyst role. With a
      // non-throwing registry (production behavior), analyst must still be
      // registered, and resolveRole("analyst") must then return analyst —
      // NOT fall back to "generic" (which would give the spawned agent
      // all built-in tools + own-workspace + persistent lifecycle, exactly
      // the conditions that produced 0 env-tool calls and a 600s timeout).
      const registry = createMockRoleRegistry();
      const am = createMockAgentManager({
        getRoleRegistry: vi.fn().mockReturnValue(registry),
      });

      new MacroAgentBackend(am);

      expect(registry.registerRole).toHaveBeenCalledWith(
        expect.objectContaining({ name: "analyst" }),
      );
      // After construction, the role must resolve to analyst, not generic.
      expect(registry.resolveRole("analyst").name).toBe("analyst");
    });

    it("skips registration if analyst role already exists", () => {
      const registry = createMockRoleRegistry();
      // Pre-register analyst via getRole (the exact-match existence check the
      // constructor now uses), mirroring the real registry's API.
      (registry.getRole as ReturnType<typeof vi.fn>).mockReturnValue({
        name: "analyst",
      });

      const am = createMockAgentManager({
        getRoleRegistry: vi.fn().mockReturnValue(registry),
      });

      new MacroAgentBackend(am);
      expect(registry.registerRole).not.toHaveBeenCalled();
    });
  });

  describe("properties", () => {
    it("has name macro-agent", () => {
      expect(backend.name).toBe("macro-agent");
    });

    it("supports claude-code agent type", () => {
      expect(backend.supportedTypes).toContain("claude-code");
    });
  });

  describe("isAvailable", () => {
    it("returns true", async () => {
      expect(await backend.isAvailable()).toBe(true);
    });
  });

  describe("spawn", () => {
    it("spawns analyst via agentManager", async () => {
      // Use a deferred promise so promptUntilDone hangs, keeping session in "running"
      let resolvePrompt!: () => void;
      const hangingPrompt = new Promise<void>((r) => { resolvePrompt = r; });

      const am = createMockAgentManager({
        promptUntilDone: vi.fn().mockImplementation(async () => {
          await hangingPrompt;
          return {
            doneCalled: true,
            doneStatus: "completed",
            exceededMax: false,
            followUpCount: 0,
            updates: [],
          };
        }),
      });
      const b = new MacroAgentBackend(am);

      const session = await b.spawn({
        agentType: "claude-code",
        task: { description: "Analyze trajectory" },
        cwd: "/workspace",
      });

      expect(am.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Analyze trajectory",
          role: "analyst",
          parent: null,
          cwd: "/workspace",
        }),
      );
      expect(session.state).toBe("running");
      expect(session.agentType).toBe("claude-code");
      expect(session.task.description).toBe("Analyze trajectory");

      // Let the hanging prompt resolve to avoid dangling promises
      resolvePrompt();
    });

    it("returns session with unique ID", async () => {
      const session = await backend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      expect(session.id).toMatch(/^cognitive_/);
    });

    it("passes env config when provided", async () => {
      await backend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
        env: { FOO: "bar" },
      });

      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { env: { FOO: "bar" } },
        }),
      );
    });

    it("passes custom prompt when provided", async () => {
      await backend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
        systemPromptAdditions: "Extra context here",
      });

      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          customPrompt: "Extra context here",
        }),
      );
    });

    it("forwards mcpServers into the raw macro spawn config (Arm B chain)", async () => {
      const mcpServers = [
        {
          name: "tauenv",
          command: "/venv/bin/python",
          args: ["-m", "autonomation_tau_bench.mcp_env", "--split", "airline"],
          env: { TAU_REWARD_FILE: "/tmp/reward.json" },
        },
      ];

      await backend.spawn({
        agentType: "claude-code",
        task: { description: "handle the customer" },
        mcpServers,
      });

      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ mcpServers }),
        }),
      );
    });

    it("forwards both env and mcpServers together into the raw spawn config", async () => {
      const mcpServers = [
        { name: "tauenv", command: "/venv/bin/python", args: ["-m", "x"] },
      ];

      await backend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
        env: { TAU_REWARD_FILE: "/tmp/r.json" },
        mcpServers,
      });

      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            env: { TAU_REWARD_FILE: "/tmp/r.json" },
            mcpServers,
          },
        }),
      );
    });

    it("invokes beforeSpawn BEFORE driving the agent (per-attempt reset hook)", async () => {
      // beforeSpawn must run before agentManager.spawn so the env subprocess /
      // reward sink is reset for THIS attempt. We assert ordering by recording
      // the call sequence.
      const order: string[] = [];
      const beforeSpawn = vi.fn(() => {
        order.push("beforeSpawn");
      });
      const am = createMockAgentManager({
        spawn: vi.fn().mockImplementation(async () => {
          order.push("spawn");
          return { id: "agent_test123", session_id: "session_test123" };
        }),
      });
      const b = new MacroAgentBackend(am);

      await b.spawn({
        agentType: "claude-code",
        task: { description: "tau episode" },
        beforeSpawn,
      });

      expect(beforeSpawn).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["beforeSpawn", "spawn"]);
    });

    it("passes completionSignal into promptUntilDone (S1 threading)", async () => {
      const completionSignal = vi.fn(() => false);

      await backend.spawn({
        agentType: "claude-code",
        task: { description: "tau episode" },
        completionSignal,
      });

      await vi.waitFor(() => {
        expect(agentManager.promptUntilDone).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.objectContaining({ isComplete: completionSignal }),
        );
      });
    });

    it("treats completedExternally as a success (session → completed) even without done()", async () => {
      const am = createMockAgentManager({
        promptUntilDone: vi.fn().mockResolvedValue({
          doneCalled: false,
          completedExternally: true,
          updates: [],
        }),
      });
      const b = new MacroAgentBackend(am);

      const session = await b.spawn({
        agentType: "claude-code",
        task: { description: "tau episode" },
        completionSignal: () => true,
      });

      await vi.waitFor(async () => {
        const s = await b.getSession(session.id);
        expect(s!.state).toBe("completed");
        expect(s!.error).toBeUndefined();
      });
    });

    it("passes config: undefined when neither env nor mcpServers set (M0 back-compat)", async () => {
      await backend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ config: undefined }),
      );
    });

    it("stores macro agent ID in session metadata", async () => {
      const session = await backend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      expect(session.metadata.macroAgentId).toBe("agent_test123");
    });
  });

  describe("spawn with useTeam", () => {
    it("passes coordinator as parent when useTeam is true", async () => {
      const teamBackend = new MacroAgentBackend(agentManager, {
        useTeam: true,
        coordinatorAgentId: "agent_coord1" as unknown as import("../../store/types/index.js").AgentId,
      });

      await teamBackend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          parent: "agent_coord1",
        }),
      );
    });

    it("passes null parent when useTeam is false", async () => {
      await backend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          parent: null,
        }),
      );
    });
  });

  describe("spawn with tasksAdapter", () => {
    it("creates and assigns task via tasksAdapter", async () => {
      const mockTasksAdapter = {
        createTask: vi.fn().mockResolvedValue("task_123"),
        assignTask: vi.fn().mockResolvedValue(undefined),
        transitionTask: vi.fn().mockResolvedValue(undefined),
        getTask: vi.fn(),
        listTasks: vi.fn(),
        queryReady: vi.fn(),
        addBlocker: vi.fn(),
        removeBlocker: vi.fn(),
        claimTask: vi.fn(),
        unclaimTask: vi.fn(),
        listClaimable: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        connected: true,
      };

      const b = new MacroAgentBackend(agentManager, {
        tasksAdapter: mockTasksAdapter as any,
      });

      await b.spawn({
        agentType: "claude-code",
        task: { description: "Analyze data", domain: "analysis" },
      });

      expect(mockTasksAdapter.createTask).toHaveBeenCalledWith({
        title: "Analyze data",
        tags: ["analysis"],
      });
      expect(mockTasksAdapter.assignTask).toHaveBeenCalledWith(
        "task_123",
        "agent_test123",
      );
      expect(mockTasksAdapter.transitionTask).toHaveBeenCalledWith(
        "task_123",
        "start",
      );
    });
  });

  describe("getSession", () => {
    it("returns session after spawn", async () => {
      const spawned = await backend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      const retrieved = await backend.getSession(spawned.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(spawned.id);
    });

    it("returns undefined for unknown session", async () => {
      const retrieved = await backend.getSession("nonexistent");
      expect(retrieved).toBeUndefined();
    });
  });

  describe("session lifecycle", () => {
    it("transitions to completed when done() is called", async () => {
      const session = await backend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      // Wait for the background runSession to complete
      await vi.waitFor(async () => {
        const s = await backend.getSession(session.id);
        expect(s!.state).toBe("completed");
      });
    });

    it("transitions to failed when done() is not called", async () => {
      const am = createMockAgentManager({
        promptUntilDone: vi.fn().mockResolvedValue({
          doneCalled: false,
          exceededMax: true,
          followUpCount: 1,
          updates: [],
        }),
      });
      const b = new MacroAgentBackend(am);

      const session = await b.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      await vi.waitFor(async () => {
        const s = await b.getSession(session.id);
        expect(s!.state).toBe("failed");
        expect(s!.error).toBe("Agent did not call done()");
      });
    });

    it("transitions to failed when promptUntilDone throws", async () => {
      const am = createMockAgentManager({
        promptUntilDone: vi.fn().mockRejectedValue(new Error("Process died")),
      });
      const b = new MacroAgentBackend(am);

      const session = await b.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      await vi.waitFor(async () => {
        const s = await b.getSession(session.id);
        expect(s!.state).toBe("failed");
        expect(s!.error).toBe("Process died");
      });
    });
  });

  describe("session updates", () => {
    it("populates session messages from onUpdate callback", async () => {
      const am = createMockAgentManager({
        promptUntilDone: vi.fn().mockImplementation(
          async (_agentId: string, _message: string, options?: { onUpdate?: (u: ExtendedSessionUpdate) => void }) => {
            // Simulate updates via onUpdate callback
            const update = {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Analysis result" },
            } as unknown as ExtendedSessionUpdate;
            options?.onUpdate?.(update);

            return {
              doneCalled: true,
              doneStatus: "completed",
              exceededMax: false,
              followUpCount: 0,
              updates: [update],
            };
          },
        ),
      });
      const b = new MacroAgentBackend(am);

      const session = await b.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      await vi.waitFor(async () => {
        const s = await b.getSession(session.id);
        expect(s!.state).toBe("completed");
        expect(s!.messages).toHaveLength(1);
        expect(s!.messages[0]!.content).toBe("Analysis result");
      });
    });
  });

  describe("terminate", () => {
    it("terminates the macro-agent process", async () => {
      // Use a deferred promise so promptUntilDone hangs until after terminate
      let resolvePrompt!: () => void;
      const hangingPrompt = new Promise<void>((r) => { resolvePrompt = r; });

      const am = createMockAgentManager({
        promptUntilDone: vi.fn().mockImplementation(async () => {
          await hangingPrompt;
          return {
            doneCalled: true,
            doneStatus: "completed",
            exceededMax: false,
            followUpCount: 0,
            updates: [],
          };
        }),
      });
      const b = new MacroAgentBackend(am);

      const session = await b.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      await b.terminate(session.id);

      expect(am.terminate).toHaveBeenCalledWith(
        "agent_test123",
        "cancelled",
      );

      // Let the hanging prompt resolve to avoid dangling promises
      resolvePrompt();
    });

    it("sets session to failed", async () => {
      // Use a deferred promise so promptUntilDone hangs until after terminate
      let resolvePrompt!: () => void;
      const hangingPrompt = new Promise<void>((r) => { resolvePrompt = r; });

      const am = createMockAgentManager({
        promptUntilDone: vi.fn().mockImplementation(async () => {
          await hangingPrompt;
          return {
            doneCalled: true,
            doneStatus: "completed",
            exceededMax: false,
            followUpCount: 0,
            updates: [],
          };
        }),
      });
      const b = new MacroAgentBackend(am);

      const session = await b.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      await b.terminate(session.id);

      const s = await b.getSession(session.id);
      expect(s!.state).toBe("failed");
      expect(s!.error).toBe("Terminated by caller");

      // Let the hanging prompt resolve to avoid dangling promises
      resolvePrompt();
    });

    it("does nothing for unknown session", async () => {
      await backend.terminate("nonexistent");
      expect(agentManager.terminate).not.toHaveBeenCalled();
    });
  });

  describe("listSessions", () => {
    it("returns all tracked sessions", async () => {
      await backend.spawn({
        agentType: "claude-code",
        task: { description: "task 1" },
      });
      await backend.spawn({
        agentType: "claude-code",
        task: { description: "task 2" },
      });

      const sessions = await backend.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it("returns empty array when no sessions", async () => {
      const sessions = await backend.listSessions();
      expect(sessions).toHaveLength(0);
    });
  });

  describe("configurable options", () => {
    it("forwards maxFollowUps to promptUntilDone", async () => {
      const b = new MacroAgentBackend(agentManager, { maxFollowUps: 3 });

      await b.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      // Wait for runSession to call promptUntilDone
      await vi.waitFor(() => {
        expect(agentManager.promptUntilDone).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.objectContaining({ maxFollowUps: 3 }),
        );
      });
    });
  });
});
