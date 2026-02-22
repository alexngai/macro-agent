/**
 * Session Lifecycle Tests
 *
 * Tests that MacroAgentBackend extracts trajectories on session completion,
 * feeds them to Atlas, and invokes onSessionComplete callback.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MacroAgentBackend } from "../macro-agent-backend.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AtlasInstance, SessionCompleteEvent, SessionEventEmitter } from "../types.js";

// ── Mock Helpers ─────────────────────────────────────────────────

let spawnCounter = 0;

function createMockAgentManager(
  overrides?: Partial<AgentManager>,
): AgentManager {
  return {
    spawn: vi.fn().mockImplementation(async () => ({
      id: `agent_${spawnCounter++}`,
      session_id: `session_${spawnCounter}`,
    })),
    prompt: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {},
    }),
    promptUntilDone: vi.fn().mockResolvedValue({
      doneCalled: true,
      doneStatus: "completed",
      exceededMax: false,
      followUpCount: 0,
      updates: [],
    }),
    terminate: vi.fn().mockResolvedValue(undefined),
    getRoleRegistry: vi.fn().mockReturnValue({
      resolveRole: vi.fn().mockImplementation(() => {
        throw new Error("not found");
      }),
      registerRole: vi.fn(),
    }),
    supportsInjection: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as AgentManager;
}

function createMockAtlas(overrides?: Partial<AtlasInstance>): AtlasInstance {
  return {
    processTrajectory: vi.fn().mockResolvedValue({
      trajectoryId: "traj_1",
      stored: true,
    }),
    runBatchLearning: vi.fn().mockResolvedValue({
      trajectoriesProcessed: 0,
      playbooksExtracted: 0,
    }),
    queryMemory: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("MacroAgentBackend — Session Lifecycle", () => {
  beforeEach(() => {
    spawnCounter = 0;
  });

  it("extracts trajectory and feeds to Atlas on completion", async () => {
    const atlas = createMockAtlas();
    const agentManager = createMockAgentManager();
    const backend = new MacroAgentBackend(agentManager, { atlas });

    const session = await backend.spawn({
      agentType: "claude-code",
      task: { description: "Analyze data" },
    });

    // Wait for runSession to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(session.state).toBe("completed");
    expect(atlas.processTrajectory).toHaveBeenCalledTimes(1);

    const trajectory = (atlas.processTrajectory as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(trajectory.task.description).toBe("Analyze data");
    expect(trajectory.outcome.success).toBe(true);
  });

  it("extracts trajectory with failure outcome on failed session", async () => {
    const atlas = createMockAtlas();
    const agentManager = createMockAgentManager({
      promptUntilDone: vi.fn().mockRejectedValue(new Error("Agent crashed")),
    });
    const backend = new MacroAgentBackend(agentManager, { atlas });

    const session = await backend.spawn({
      agentType: "claude-code",
      task: { description: "Analyze data" },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(session.state).toBe("failed");
    expect(atlas.processTrajectory).toHaveBeenCalledTimes(1);

    const trajectory = (atlas.processTrajectory as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(trajectory.outcome.success).toBe(false);
    expect(trajectory.outcome.errorInfo).toBe("Agent crashed");
  });

  it("invokes onSessionComplete callback with session and trajectory", async () => {
    const onSessionComplete = vi.fn();
    const agentManager = createMockAgentManager();
    const backend = new MacroAgentBackend(agentManager, { onSessionComplete });

    await backend.spawn({
      agentType: "claude-code",
      task: { description: "Analyze data" },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(onSessionComplete).toHaveBeenCalledTimes(1);
    const event: SessionCompleteEvent = onSessionComplete.mock.calls[0][0];
    expect(event.state).toBe("completed");
    expect(event.trajectory).toBeDefined();
    expect(event.trajectory!.task.description).toBe("Analyze data");
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("works without Atlas (no trajectory ingestion, still calls callback)", async () => {
    const onSessionComplete = vi.fn();
    const agentManager = createMockAgentManager();
    const backend = new MacroAgentBackend(agentManager, { onSessionComplete });

    await backend.spawn({
      agentType: "claude-code",
      task: { description: "Analyze data" },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(onSessionComplete).toHaveBeenCalledTimes(1);
    expect(onSessionComplete.mock.calls[0][0].trajectory).toBeDefined();
  });

  it("Atlas.processTrajectory() error doesn't break session completion", async () => {
    const atlas = createMockAtlas({
      processTrajectory: vi.fn().mockRejectedValue(new Error("Atlas unavailable")),
    });
    const onSessionComplete = vi.fn();
    const agentManager = createMockAgentManager();
    const backend = new MacroAgentBackend(agentManager, {
      atlas,
      onSessionComplete,
    });

    const session = await backend.spawn({
      agentType: "claude-code",
      task: { description: "Analyze data" },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Session should still complete normally
    expect(session.state).toBe("completed");
    // Callback should still fire
    expect(onSessionComplete).toHaveBeenCalledTimes(1);
  });

  it("no errors when neither atlas nor callback are configured", async () => {
    const agentManager = createMockAgentManager();
    const backend = new MacroAgentBackend(agentManager);

    const session = await backend.spawn({
      agentType: "claude-code",
      task: { description: "Analyze data" },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(session.state).toBe("completed");
  });

  describe("MAP event emission", () => {
    function createMockMapAdapter(): SessionEventEmitter & { emitEvent: ReturnType<typeof vi.fn> } {
      return {
        emitEvent: vi.fn(),
      };
    }

    it("emits session.complete MAP event when mapAdapter is provided", async () => {
      const mapAdapter = createMockMapAdapter();
      const agentManager = createMockAgentManager();
      const backend = new MacroAgentBackend(agentManager, { mapAdapter });

      await backend.spawn({
        agentType: "claude-code",
        task: { description: "Analyze data" },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(mapAdapter.emitEvent).toHaveBeenCalledTimes(1);
      const event = mapAdapter.emitEvent.mock.calls[0][0];
      expect(event.type).toBe("session.complete");
      expect(event.eventId).toBeDefined();
      expect(event.timestamp).toBeGreaterThan(0);
      expect(event.agentId).toBeDefined();
      expect(event.data.outcome).toBe("success");
    });

    it("MAP event data includes correct session metadata", async () => {
      const mapAdapter = createMockMapAdapter();
      const agentManager = createMockAgentManager();
      const backend = new MacroAgentBackend(agentManager, { mapAdapter });

      const session = await backend.spawn({
        agentType: "claude-code",
        task: { description: "Deep analysis" },
      });

      await new Promise((r) => setTimeout(r, 50));

      const event = mapAdapter.emitEvent.mock.calls[0][0];
      expect(event.data.sessionId).toBe(session.id);
      expect(event.data.state).toBe("completed");
      expect(event.data.duration_ms).toBeGreaterThanOrEqual(0);
      expect(event.data.message_count).toBe(0);
      expect(event.data.tool_call_count).toBe(0);
    });

    it("emits failure outcome on failed session", async () => {
      const mapAdapter = createMockMapAdapter();
      const agentManager = createMockAgentManager({
        promptUntilDone: vi.fn().mockRejectedValue(new Error("Crashed")),
      });
      const backend = new MacroAgentBackend(agentManager, { mapAdapter });

      await backend.spawn({
        agentType: "claude-code",
        task: { description: "Analyze data" },
      });

      await new Promise((r) => setTimeout(r, 50));

      const event = mapAdapter.emitEvent.mock.calls[0][0];
      expect(event.data.outcome).toBe("failure");
      expect(event.data.state).toBe("failed");
    });

    it("works without mapAdapter (no MAP event, callback still fires)", async () => {
      const onSessionComplete = vi.fn();
      const agentManager = createMockAgentManager();
      const backend = new MacroAgentBackend(agentManager, { onSessionComplete });

      await backend.spawn({
        agentType: "claude-code",
        task: { description: "Analyze data" },
      });

      await new Promise((r) => setTimeout(r, 50));

      // Callback fires, but no MAP event (no error thrown)
      expect(onSessionComplete).toHaveBeenCalledTimes(1);
    });
  });
});
