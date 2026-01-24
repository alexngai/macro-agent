/**
 * Cascade Termination E2E Tests
 *
 * Tests hierarchical agent termination with real Claude agents.
 * Verifies that cascade termination works correctly when parent agents
 * terminate and children need to be cleaned up.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable (and authenticated Claude Code)
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/__tests__/e2e/cascade-termination.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

import { createEventStore, type EventStore } from "../../store/event-store.js";
import {
  createAgentManager,
  type AgentManager,
} from "../../agent/agent-manager.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../router/message-router.js";
import {
  cascadeTerminateChildren,
  getAllDescendants,
  needsCascadeTermination,
  type CascadeAgentManager,
  type CascadeAgent,
} from "../../lifecycle/cascade.js";

// ─────────────────────────────────────────────────────────────────
// Test Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;

const log = (msg: string) => console.log(`[Cascade-E2E] ${msg}`);

// Timeouts for different operations
const TIMEOUT = {
  SPAWN: 60000,
  PROMPT: 120000,
  CASCADE: 180000,
  MULTI_AGENT: 300000,
};

/**
 * Create an isolated test git repo
 */
function createTestRepo(prefix: string): { path: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cascade-e2e-${prefix}-`)
  );
  const repoPath = path.join(tmpDir, "test-repo");
  fs.mkdirSync(repoPath);
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync('git config user.name "Test User"', {
    cwd: repoPath,
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Cascade Test Repo\n");
  execSync("git add -A", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: "pipe" });

  return {
    path: repoPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/**
 * Create a CascadeAgentManager adapter from real AgentManager
 */
function createCascadeAdapter(agentManager: AgentManager): CascadeAgentManager {
  return {
    getChildren(agentId: string): CascadeAgent[] {
      const allAgents = agentManager.list();
      return allAgents
        .filter((agent) => agent.parent === agentId)
        .map((agent) => ({
          id: agent.id,
          state: agent.state === "running" ? "running" : "stopped",
          parent: agent.parent ?? undefined,
        }));
    },
    async terminate(agentId: string, reason: string): Promise<void> {
      await agentManager.terminate(agentId, reason);
    },
  };
}

/**
 * Wait for agent to reach a specific state
 */
async function waitForAgentState(
  agentManager: AgentManager,
  agentId: string,
  targetState: "running" | "stopped",
  timeoutMs = 30000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const agent = agentManager.get(agentId);
    if (agent?.state === targetState) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timeout waiting for agent ${agentId} to reach state ${targetState}`
  );
}

// ─────────────────────────────────────────────────────────────────
// Cascade Termination E2E Tests
// ─────────────────────────────────────────────────────────────────

describe("Cascade Termination E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let testRepo: { path: string; cleanup: () => void };

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("⚠️  Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    testRepo = createTestRepo("cascade");
    log(`Test repo created at: ${testRepo.path}`);

    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: testRepo.path,
    });

    log("Services initialized");
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Terminate all remaining agents
    try {
      for (const agent of agentManager.list()) {
        if (agent.state === "running") {
          try {
            await agentManager.terminate(agent.id, "test_cleanup");
          } catch {
            // Ignore termination errors during cleanup
          }
        }
      }
    } catch {
      // Ignore errors during cleanup
    }

    await agentManager?.close();
    await eventStore?.close();
    testRepo?.cleanup();
    log("Cleanup complete");
  });

  // ─────────────────────────────────────────────────────────────────
  // Test: Parent + Child Cascade
  // ─────────────────────────────────────────────────────────────────

  testFn(
    "should cascade terminate child when parent terminates",
    async () => {
      log("Spawning parent agent...");

      // Spawn parent agent
      const parent = await agentManager.spawn({
        task: "You are a coordinator. Wait for instructions.",
        role: "coordinator",
        streamId: "cascade-test",
        cwd: testRepo.path,
      });

      log(`Parent spawned: ${parent.id}`);
      await waitForAgentState(agentManager, parent.id, "running");

      // Spawn child agent
      log("Spawning child agent...");
      const child = await agentManager.spawn({
        task: "You are a worker. Wait for work.",
        role: "worker",
        streamId: "cascade-test",
        parent: parent.id,
        cwd: testRepo.path,
      });

      log(`Child spawned: ${child.id}`);
      await waitForAgentState(agentManager, child.id, "running");

      // Verify parent-child relationship
      const childAgent = agentManager.get(child.id);
      expect(childAgent?.parent).toBe(parent.id);
      log("✓ Parent-child relationship verified");

      // Create cascade adapter
      const cascadeAdapter = createCascadeAdapter(agentManager);

      // Verify children are found
      const children = cascadeAdapter.getChildren(parent.id);
      expect(children.length).toBe(1);
      expect(children[0].id).toBe(child.id);
      expect(children[0].state).toBe("running");
      log("✓ Child found via cascade adapter");

      // Verify cascade is needed
      expect(needsCascadeTermination(parent.id, cascadeAdapter)).toBe(true);

      // Trigger cascade termination
      log("Triggering cascade termination...");
      const result = await cascadeTerminateChildren(
        parent.id,
        cascadeAdapter,
        { reason: "parent_terminated" }
      );

      log(`Cascade result: ${result.childrenTerminated} terminated`);

      // Verify result
      expect(result.childrenTerminated).toBe(1);
      expect(result.terminatedIds).toContain(child.id);
      expect(result.errors).toBeUndefined();

      // Verify child is terminated
      await waitForAgentState(agentManager, child.id, "stopped", 10000);
      const terminatedChild = agentManager.get(child.id);
      expect(terminatedChild?.state).toBe("stopped");
      log("✓ Child successfully terminated via cascade");

      // Terminate parent
      await agentManager.terminate(parent.id, "test_complete");
      log("✓ Test complete");
    },
    { timeout: TIMEOUT.CASCADE }
  );

  // ─────────────────────────────────────────────────────────────────
  // Test: Multiple Children Cascade
  // ─────────────────────────────────────────────────────────────────

  testFn(
    "should cascade terminate multiple children",
    async () => {
      log("Spawning parent agent...");

      const parent = await agentManager.spawn({
        task: "You are a coordinator managing multiple workers.",
        role: "coordinator",
        streamId: "cascade-multi",
        cwd: testRepo.path,
      });

      await waitForAgentState(agentManager, parent.id, "running");
      log(`Parent spawned: ${parent.id}`);

      // Spawn 3 children
      const childIds: string[] = [];
      for (let i = 1; i <= 3; i++) {
        log(`Spawning child ${i}...`);
        const child = await agentManager.spawn({
          task: `You are worker ${i}. Wait for work.`,
          role: "worker",
          streamId: "cascade-multi",
          parent: parent.id,
          cwd: testRepo.path,
        });

        await waitForAgentState(agentManager, child.id, "running");
        childIds.push(child.id);
        log(`Child ${i} spawned: ${child.id}`);
      }

      // Verify all children are running
      for (const childId of childIds) {
        const child = agentManager.get(childId);
        expect(child?.state).toBe("running");
        expect(child?.parent).toBe(parent.id);
      }
      log("✓ All children running and linked to parent");

      // Create cascade adapter and verify
      const cascadeAdapter = createCascadeAdapter(agentManager);
      const children = cascadeAdapter.getChildren(parent.id);
      expect(children.length).toBe(3);
      log("✓ All 3 children found via cascade adapter");

      // Trigger cascade
      log("Triggering cascade termination...");
      const result = await cascadeTerminateChildren(
        parent.id,
        cascadeAdapter,
        { reason: "parent_terminated" }
      );

      // Verify result
      expect(result.childrenTerminated).toBe(3);
      expect(result.terminatedIds.length).toBe(3);
      for (const childId of childIds) {
        expect(result.terminatedIds).toContain(childId);
      }
      expect(result.errors).toBeUndefined();
      log(`✓ Cascade terminated ${result.childrenTerminated} children`);

      // Verify all children are stopped
      for (const childId of childIds) {
        await waitForAgentState(agentManager, childId, "stopped", 10000);
        const child = agentManager.get(childId);
        expect(child?.state).toBe("stopped");
      }
      log("✓ All children successfully terminated");

      // Cleanup parent
      await agentManager.terminate(parent.id, "test_complete");
      log("✓ Test complete");
    },
    { timeout: TIMEOUT.MULTI_AGENT }
  );

  // ─────────────────────────────────────────────────────────────────
  // Test: Deep Hierarchy Cascade (3 Levels)
  // ─────────────────────────────────────────────────────────────────

  testFn(
    "should cascade terminate deep hierarchy in depth-first order",
    async () => {
      const terminationOrder: string[] = [];

      log("Spawning 3-level hierarchy...");

      // Level 0: Coordinator
      const coordinator = await agentManager.spawn({
        task: "You are the top-level coordinator.",
        role: "coordinator",
        streamId: "cascade-deep",
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, coordinator.id, "running");
      log(`Level 0 (coordinator): ${coordinator.id}`);

      // Level 1: Worker (child of coordinator)
      const worker1 = await agentManager.spawn({
        task: "You are a mid-level worker.",
        role: "worker",
        streamId: "cascade-deep",
        parent: coordinator.id,
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, worker1.id, "running");
      log(`Level 1 (worker): ${worker1.id}`);

      // Level 2: Sub-worker (child of worker1)
      const worker2 = await agentManager.spawn({
        task: "You are a leaf-level worker.",
        role: "worker",
        streamId: "cascade-deep",
        parent: worker1.id,
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, worker2.id, "running");
      log(`Level 2 (sub-worker): ${worker2.id}`);

      // Verify hierarchy
      expect(agentManager.get(worker1.id)?.parent).toBe(coordinator.id);
      expect(agentManager.get(worker2.id)?.parent).toBe(worker1.id);
      log("✓ 3-level hierarchy established");

      // Create cascade adapter that tracks termination order
      const cascadeAdapter: CascadeAgentManager = {
        getChildren(agentId: string): CascadeAgent[] {
          const allAgents = agentManager.list();
          return allAgents
            .filter((agent) => agent.parent === agentId)
            .map((agent) => ({
              id: agent.id,
              state: agent.state === "running" ? "running" : "stopped",
              parent: agent.parent ?? undefined,
            }));
        },
        async terminate(agentId: string, reason: string): Promise<void> {
          terminationOrder.push(agentId);
          await agentManager.terminate(agentId, reason);
        },
      };

      // Get all descendants
      const descendants = getAllDescendants(coordinator.id, cascadeAdapter);
      expect(descendants.length).toBe(2);
      log(`✓ Found ${descendants.length} descendants`);

      // Trigger cascade from coordinator
      log("Triggering cascade termination...");
      const result = await cascadeTerminateChildren(
        coordinator.id,
        cascadeAdapter,
        { reason: "coordinator_terminated" }
      );

      // Verify depth-first order: worker2 (deepest) → worker1
      expect(result.childrenTerminated).toBe(2);
      expect(terminationOrder).toEqual([worker2.id, worker1.id]);
      log(`✓ Termination order: ${terminationOrder.join(" → ")}`);
      log("✓ Depth-first order verified (deepest first)");

      // Verify all descendants are stopped
      expect(agentManager.get(worker1.id)?.state).toBe("stopped");
      expect(agentManager.get(worker2.id)?.state).toBe("stopped");

      // Cleanup coordinator
      await agentManager.terminate(coordinator.id, "test_complete");
      log("✓ Test complete");
    },
    { timeout: TIMEOUT.MULTI_AGENT }
  );

  // ─────────────────────────────────────────────────────────────────
  // Test: Partial Cascade (some children already stopped)
  // ─────────────────────────────────────────────────────────────────

  testFn(
    "should skip already-stopped children during cascade",
    async () => {
      log("Spawning parent and children...");

      const parent = await agentManager.spawn({
        task: "You are a coordinator.",
        role: "coordinator",
        streamId: "cascade-partial",
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, parent.id, "running");
      log(`Parent: ${parent.id}`);

      // Spawn two children
      const child1 = await agentManager.spawn({
        task: "You are worker 1.",
        role: "worker",
        streamId: "cascade-partial",
        parent: parent.id,
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, child1.id, "running");
      log(`Child 1: ${child1.id}`);

      const child2 = await agentManager.spawn({
        task: "You are worker 2.",
        role: "worker",
        streamId: "cascade-partial",
        parent: parent.id,
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, child2.id, "running");
      log(`Child 2: ${child2.id}`);

      // Manually terminate child1 (simulating it finished its work)
      log("Terminating child 1 manually...");
      await agentManager.terminate(child1.id, "work_complete");
      await waitForAgentState(agentManager, child1.id, "stopped", 10000);
      log("✓ Child 1 stopped");

      // Verify states: child1 stopped, child2 running
      expect(agentManager.get(child1.id)?.state).toBe("stopped");
      expect(agentManager.get(child2.id)?.state).toBe("running");

      // Create cascade adapter
      const cascadeAdapter = createCascadeAdapter(agentManager);

      // Cascade should still be needed (child2 is running)
      expect(needsCascadeTermination(parent.id, cascadeAdapter)).toBe(true);

      // Trigger cascade
      log("Triggering cascade termination...");
      const result = await cascadeTerminateChildren(
        parent.id,
        cascadeAdapter,
        { reason: "parent_terminated" }
      );

      // Only child2 should be terminated (child1 was already stopped)
      expect(result.childrenTerminated).toBe(1);
      expect(result.terminatedIds).toContain(child2.id);
      expect(result.terminatedIds).not.toContain(child1.id);
      log(`✓ Only running child (child2) was terminated`);

      // Verify both are now stopped
      expect(agentManager.get(child1.id)?.state).toBe("stopped");
      expect(agentManager.get(child2.id)?.state).toBe("stopped");

      // Cleanup parent
      await agentManager.terminate(parent.id, "test_complete");
      log("✓ Test complete");
    },
    { timeout: TIMEOUT.CASCADE }
  );

  // ─────────────────────────────────────────────────────────────────
  // Test: No Cascade Needed
  // ─────────────────────────────────────────────────────────────────

  testFn(
    "should report no cascade needed when all children already stopped",
    async () => {
      log("Spawning parent and children...");

      const parent = await agentManager.spawn({
        task: "You are a coordinator.",
        role: "coordinator",
        streamId: "cascade-none",
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, parent.id, "running");
      log(`Parent: ${parent.id}`);

      // Spawn and immediately terminate children
      const child1 = await agentManager.spawn({
        task: "Quick worker 1.",
        role: "worker",
        streamId: "cascade-none",
        parent: parent.id,
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, child1.id, "running");
      await agentManager.terminate(child1.id, "done");
      await waitForAgentState(agentManager, child1.id, "stopped", 10000);
      log(`Child 1 spawned and terminated: ${child1.id}`);

      const child2 = await agentManager.spawn({
        task: "Quick worker 2.",
        role: "worker",
        streamId: "cascade-none",
        parent: parent.id,
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, child2.id, "running");
      await agentManager.terminate(child2.id, "done");
      await waitForAgentState(agentManager, child2.id, "stopped", 10000);
      log(`Child 2 spawned and terminated: ${child2.id}`);

      // Create cascade adapter
      const cascadeAdapter = createCascadeAdapter(agentManager);

      // Verify no cascade needed
      expect(needsCascadeTermination(parent.id, cascadeAdapter)).toBe(false);
      log("✓ needsCascadeTermination returns false");

      // Cascade should be a no-op
      const result = await cascadeTerminateChildren(
        parent.id,
        cascadeAdapter,
        { reason: "parent_terminated" }
      );

      expect(result.childrenTerminated).toBe(0);
      expect(result.terminatedIds).toEqual([]);
      log("✓ Cascade returned 0 terminated (as expected)");

      // Cleanup parent
      await agentManager.terminate(parent.id, "test_complete");
      log("✓ Test complete");
    },
    { timeout: TIMEOUT.CASCADE }
  );
});
