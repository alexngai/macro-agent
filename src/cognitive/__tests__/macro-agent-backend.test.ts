import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExtendedSessionUpdate } from "acp-factory";
import { MacroAgentBackend } from "../macro-agent-backend.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { RoleRegistry, RoleDefinition } from "../../roles/types.js";

// ── Mock Helpers ─────────────────────────────────────────────────

function createMockRoleRegistry(): RoleRegistry {
  const roles = new Map<string, RoleDefinition>();
  return {
    registerRole: vi.fn((role: RoleDefinition) => {
      roles.set(role.name, role);
    }),
    resolveRole: vi.fn((name: string) => {
      const role = roles.get(name);
      if (!role) throw new Error(`Role not found: ${name}`);
      return role;
    }),
    getRole: vi.fn((name: string) => roles.get(name)),
    hasCapability: vi.fn(() => true),
    loadConfigs: vi.fn(),
    loadProjectConfig: vi.fn(),
    loadUserConfig: vi.fn(),
    loadFromFile: vi.fn(),
    clearLoadedRoles: vi.fn(),
    dispose: vi.fn(),
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

    it("skips registration if analyst role already exists", () => {
      const registry = createMockRoleRegistry();
      // Pre-register analyst
      (registry.resolveRole as ReturnType<typeof vi.fn>).mockReturnValue({
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
      const session = await backend.spawn({
        agentType: "claude-code",
        task: { description: "Analyze trajectory" },
        cwd: "/workspace",
      });

      expect(agentManager.spawn).toHaveBeenCalledWith(
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
      const session = await backend.spawn({
        agentType: "claude-code",
        task: { description: "test" },
      });

      await backend.terminate(session.id);

      expect(agentManager.terminate).toHaveBeenCalledWith(
        "agent_test123",
        "cancelled",
      );
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
