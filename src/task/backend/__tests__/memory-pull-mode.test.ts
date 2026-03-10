/**
 * Pull-Mode Task Backend Tests
 *
 * Tests the claim/unclaim/listClaimable methods of InMemoryTaskBackend
 * which enable the pull model where workers claim tasks from a pool.
 *
 * @module task/backend/__tests__/memory-pull-mode
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createEventStore, type EventStore } from "../../../store/event-store.js";
import { InMemoryTaskBackend } from "../memory.js";
import type { AgentId, TaskId } from "../../../store/types/index.js";

describe("InMemoryTaskBackend — Pull Mode", () => {
  let eventStore: EventStore;
  let backend: InMemoryTaskBackend;

  const AGENT_A = "agent-a" as AgentId;
  const AGENT_B = "agent-b" as AgentId;
  const CREATOR = "creator-001" as AgentId;

  beforeEach(async () => {
    eventStore = await createEventStore({ instanceId: `pull-test-${Date.now()}` });
    backend = new InMemoryTaskBackend(eventStore);
  });

  // ─────────────────────────────────────────────────────────────────
  // claim()
  // ─────────────────────────────────────────────────────────────────

  it("claim returns first pending unblocked task", async () => {
    const t1 = await backend.create({ description: "Task 1", created_by: CREATOR });
    const t2 = await backend.create({ description: "Task 2", created_by: CREATOR });
    const t3 = await backend.create({ description: "Task 3", created_by: CREATOR });

    const claimed = await backend.claim!(AGENT_A);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(t1.id);
    expect(claimed!.assigned_agent).toBe(AGENT_A);

    // Second claim should return t2
    const claimed2 = await backend.claim!(AGENT_B);
    expect(claimed2).not.toBeNull();
    expect(claimed2!.id).toBe(t2.id);
    expect(claimed2!.assigned_agent).toBe(AGENT_B);
  });

  it("claim skips assigned tasks", async () => {
    const t1 = await backend.create({ description: "Task 1", created_by: CREATOR });
    const t2 = await backend.create({ description: "Task 2", created_by: CREATOR });

    // Assign t1 directly
    await backend.assign(t1.id, { agent_id: AGENT_A });

    // claim should skip t1 and return t2
    const claimed = await backend.claim!(AGENT_B);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(t2.id);
  });

  it("claim skips blocked tasks", async () => {
    const blocker = await backend.create({ description: "Blocker task", created_by: CREATOR });
    const blocked = await backend.create({ description: "Blocked task", created_by: CREATOR });
    const available = await backend.create({ description: "Available task", created_by: CREATOR });

    // Add blocker dependency
    await backend.addBlocker(blocked.id, blocker.id);

    // claim should skip blocked and return available
    const claimed = await backend.claim!(AGENT_A);
    expect(claimed).not.toBeNull();
    // Should return either blocker or available (blocker is pending+unblocked, so it comes first)
    // blocker is pending + not assigned + not blocked → claimable
    // blocked is pending + not assigned but IS blocked → not claimable
    // available is pending + not assigned + not blocked → claimable
    expect([blocker.id, available.id]).toContain(claimed!.id);
    expect(claimed!.id).not.toBe(blocked.id);
  });

  it("claim returns null when no claimable tasks", async () => {
    // Create a task and assign it
    const t1 = await backend.create({ description: "Task 1", created_by: CREATOR });
    await backend.assign(t1.id, { agent_id: AGENT_A });

    // No unassigned pending tasks left
    const claimed = await backend.claim!(AGENT_B);
    expect(claimed).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────
  // unclaim()
  // ─────────────────────────────────────────────────────────────────

  it("unclaim returns task to pending pool", async () => {
    const t1 = await backend.create({ description: "Task 1", created_by: CREATOR });

    // Claim it
    const claimed = await backend.claim!(AGENT_A);
    expect(claimed!.id).toBe(t1.id);
    expect(claimed!.assigned_agent).toBe(AGENT_A);

    // Unclaim it
    await backend.unclaim!(t1.id);

    // Task should be claimable again
    const reClaimed = await backend.claim!(AGENT_B);
    expect(reClaimed).not.toBeNull();
    expect(reClaimed!.id).toBe(t1.id);
    expect(reClaimed!.assigned_agent).toBe(AGENT_B);
  });

  it("unclaim throws on unassigned task", async () => {
    const t1 = await backend.create({ description: "Task 1", created_by: CREATOR });

    await expect(backend.unclaim!(t1.id)).rejects.toThrow("not assigned");
  });

  // ─────────────────────────────────────────────────────────────────
  // listClaimable()
  // ─────────────────────────────────────────────────────────────────

  it("listClaimable filters by tags", async () => {
    await backend.create({
      description: "Frontend task",
      created_by: CREATOR,
      tags: ["frontend", "ui"],
    });
    await backend.create({
      description: "Backend task",
      created_by: CREATOR,
      tags: ["backend", "api"],
    });
    await backend.create({
      description: "Untagged task",
      created_by: CREATOR,
    });

    // Filter by "backend" tag
    const claimable = await backend.listClaimable!({ tags: ["backend"] });
    expect(claimable.length).toBe(1);
    expect(claimable[0].description).toBe("Backend task");

    // Filter by "frontend" tag
    const frontendTasks = await backend.listClaimable!({ tags: ["frontend"] });
    expect(frontendTasks.length).toBe(1);
    expect(frontendTasks[0].description).toBe("Frontend task");

    // No filter returns all claimable
    const allClaimable = await backend.listClaimable!();
    expect(allClaimable.length).toBe(3);
  });
});
