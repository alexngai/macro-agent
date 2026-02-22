/**
 * EventStore Out-of-Band Field Preservation Tests
 *
 * Tests that fields written via updateAgentMetadata() (out-of-band,
 * not through events) survive the rebuildViews() cycle that occurs
 * on every auto-load (every 1 second) and on reload().
 *
 * The preservation relies on OUT_OF_BAND_FIELDS in rebuildViews()
 * which saves these values before clearing views, replays all events,
 * then restores the saved values.
 *
 * @module store/__tests__/event-store-oob
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, type EventStore } from "../event-store.js";
import type { AgentId } from "../types/index.js";

describe("EventStore — Out-of-Band Field Preservation", () => {
  let eventStore: EventStore;

  const AGENT_ID = "oob-test-001" as AgentId;

  beforeEach(async () => {
    eventStore = await createEventStore({ instanceId: `oob-test-${Date.now()}` });

    // Create an agent via spawn event
    eventStore.emit({
      type: "spawn",
      source: { agent_id: AGENT_ID },
      payload: {
        agent_id: AGENT_ID,
        task: "Test task",
        role: "worker",
        cwd: "/original/path",
      },
    });
    await eventStore.persist();
  });

  afterEach(async () => {
    try { await eventStore.close(); } catch { /* ignore */ }
  });

  it("cwd survives rebuildViews after updateAgentMetadata", async () => {
    // Verify initial cwd from spawn event
    expect(eventStore.getAgent(AGENT_ID)?.cwd).toBe("/original/path");

    // Update cwd out-of-band
    eventStore.updateAgentMetadata(AGENT_ID, { cwd: "/workspace/worktree-001" });
    expect(eventStore.getAgent(AGENT_ID)?.cwd).toBe("/workspace/worktree-001");

    // Persist and reload (triggers rebuildViews)
    await eventStore.persist();
    await eventStore.reload();

    // cwd should survive the rebuild
    const agent = eventStore.getAgent(AGENT_ID);
    expect(agent).not.toBeNull();
    expect(agent!.cwd).toBe("/workspace/worktree-001");
  });

  it("team_instance survives rebuildViews", async () => {
    // Set team_instance out-of-band
    eventStore.updateAgentMetadata(AGENT_ID, { team_instance: "team-alpha-001" });
    expect(eventStore.getAgent(AGENT_ID)?.team_instance).toBe("team-alpha-001");

    // Persist and reload
    await eventStore.persist();
    await eventStore.reload();

    // team_instance should survive
    expect(eventStore.getAgent(AGENT_ID)?.team_instance).toBe("team-alpha-001");
  });

  it("all OUT_OF_BAND_FIELDS preserved together", async () => {
    // Set all out-of-band fields simultaneously
    eventStore.updateAgentMetadata(AGENT_ID, {
      name: "Developer Alpha",
      plan: [{ content: "Step 1: do the thing", priority: "high", status: "pending" }],
      metadata: { custom_key: "custom_value" },
      cwd: "/workspace/worktree-002",
      team_instance: "team-beta-002",
    });

    // Verify all set correctly
    const before = eventStore.getAgent(AGENT_ID)!;
    expect(before.name).toBe("Developer Alpha");
    expect(before.cwd).toBe("/workspace/worktree-002");
    expect(before.team_instance).toBe("team-beta-002");

    // Persist and reload (triggers rebuildViews)
    await eventStore.persist();
    await eventStore.reload();

    // All fields should survive
    const after = eventStore.getAgent(AGENT_ID)!;
    expect(after.name).toBe("Developer Alpha");
    expect(after.cwd).toBe("/workspace/worktree-002");
    expect(after.team_instance).toBe("team-beta-002");

    // plan and metadata may be stored as JSON strings or objects depending on TinyBase internals
    const plan = typeof after.plan === "string" ? JSON.parse(after.plan) : after.plan;
    expect(plan).toEqual([{ content: "Step 1: do the thing", priority: "high", status: "pending" }]);

    const metadata = typeof after.metadata === "string" ? JSON.parse(after.metadata) : after.metadata;
    expect(metadata).toEqual({ custom_key: "custom_value" });
  });
});
