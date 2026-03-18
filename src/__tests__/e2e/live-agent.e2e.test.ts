/**
 * Live Agent E2E Tests (V2)
 *
 * Tests that spawn REAL Claude Code agents via acp-factory.
 * These require authenticated Claude Code and hit the API.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/live-agent.e2e.test.ts
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execSync } from "child_process";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const describeFn = RUN_FULL_AGENT ? describe : describe.skip;

const TIMEOUT = {
  SPAWN: 60_000,
  PROMPT: 90_000,
  MULTI: 180_000,
};

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function createTestRepo(prefix: string): { path: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `live-agent-${prefix}-`)
  );
  const repoPath = path.join(tmpDir, "test-repo");
  fs.mkdirSync(repoPath);
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repo\n");
  execSync("git add -A", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: "pipe" });

  return {
    path: repoPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function log(msg: string): void {
  console.log(`[LIVE-E2E] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Live Agent E2E (V2)", () => {
  let system: MacroAgentSystemV2;
  let testRepo: { path: string; cleanup: () => void };
  let baseDir: string;

  beforeEach(async () => {
    testRepo = createTestRepo("v2");
    baseDir = path.join(testRepo.path, ".macro-agent");
    fs.mkdirSync(baseDir, { recursive: true });

    // Boot V2 with real acp-factory (no mocking)
    system = await bootV2({
      cwd: testRepo.path,
      baseDir,
      defaultPermissionMode: "auto-approve",
      inbox: {
        socketPath: path.join(baseDir, "inbox.sock"),
      },
    });
    log("System booted");
  });

  afterEach(async () => {
    if (system) {
      try {
        // Terminate all running agents
        const running = system.agentManager.list({ state: "running" });
        for (const agent of running) {
          try {
            await system.agentManager.terminate(agent.id, "cancelled");
          } catch {
            // Best effort
          }
        }
        await system.shutdown();
      } catch {
        // Best effort
      }
    }
    testRepo?.cleanup();
    log("Cleanup complete");
  });

  // ── Spawn & Prompt ──────────────────────────────────────────

  it(
    "should spawn a real agent and receive a prompt response",
    async () => {
      log("Spawning real agent...");
      const agent = await system.agentManager.spawn({
        task: "Reply with exactly: HELLO_FROM_AGENT",
        role: "worker",
        cwd: testRepo.path,
      });

      log(`Agent spawned: ${agent.id}`);
      expect(agent.id).toBeDefined();
      expect(agent.session).toBeDefined();

      // Verify in store
      const record = system.agentStore.getAgent(agent.id);
      expect(record).not.toBeNull();
      expect(record!.state).toBe("running");

      // Verify in inbox
      const inbox = (system.inboxAdapter as any).getInbox();
      const inboxAgent = inbox.storage.getAgent(agent.id);
      expect(inboxAgent).toBeDefined();
      expect(inboxAgent.status).toBe("active");

      log("Prompting agent...");
      const updates: any[] = [];
      for await (const update of system.agentManager.prompt(
        agent.id,
        'Say exactly "HELLO_FROM_AGENT" and nothing else.'
      )) {
        updates.push(update);
      }

      log(`Got ${updates.length} updates from prompt`);
      expect(updates.length).toBeGreaterThan(0);

      // Check that at least one update has text content
      const hasContent = updates.some(
        (u) =>
          u.type === "assistant" ||
          u.type === "text" ||
          (u as any).content !== undefined
      );
      expect(hasContent).toBe(true);

      log("Terminating agent...");
      await system.agentManager.terminate(agent.id, "completed");

      const stopped = system.agentStore.getAgent(agent.id);
      expect(stopped!.state).toBe("stopped");

      // Verify deregistered from inbox
      const afterStop = inbox.storage.getAgent(agent.id);
      expect(afterStop.status).toBe("offline");

      log("Test complete");
    },
    TIMEOUT.PROMPT
  );

  // ── Parent-Child with Real Agents ───────────────────────────

  it(
    "should spawn parent and child agents with real processes",
    async () => {
      log("Spawning coordinator...");
      const coordinator = await system.agentManager.spawn({
        task: "You are a coordinator. Wait for instructions.",
        role: "coordinator",
        cwd: testRepo.path,
      });

      log(`Coordinator spawned: ${coordinator.id}`);
      expect(coordinator.id).toBeDefined();

      log("Spawning worker under coordinator...");
      const worker = await system.agentManager.spawn({
        task: "You are a worker. Reply with WORKER_READY.",
        role: "worker",
        parent: coordinator.id,
        cwd: testRepo.path,
      });

      log(`Worker spawned: ${worker.id}`);
      expect(worker.id).toBeDefined();
      expect(worker.agent.parent).toBe(coordinator.id);

      // Verify hierarchy
      const children = system.agentManager.getChildren(coordinator.id);
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(worker.id);

      const hierarchy = system.agentManager.getHierarchy(coordinator.id);
      expect(hierarchy!.totalAgents).toBe(2);

      log("Terminating coordinator (should cascade)...");
      await system.agentManager.terminate(coordinator.id, "completed");

      // Both should be stopped
      expect(system.agentStore.getAgent(coordinator.id)!.state).toBe("stopped");
      expect(system.agentStore.getAgent(worker.id)!.state).toBe("stopped");

      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── Inter-Agent Messaging with Real Agents ──────────────────

  it(
    "should deliver inbox messages between real agents",
    async () => {
      log("Spawning two agents...");
      const a = await system.agentManager.spawn({
        task: "Agent A. Wait for instructions.",
        role: "coordinator",
        cwd: testRepo.path,
      });

      const b = await system.agentManager.spawn({
        task: "Agent B. Wait for instructions.",
        role: "worker",
        parent: a.id,
        cwd: testRepo.path,
      });

      log("Sending message A → B via inbox...");
      const msgId = await system.inboxAdapter.send(
        a.id,
        b.id,
        "Hello from coordinator",
        { threadTag: "live-test", importance: "normal" }
      );
      expect(msgId).toBeTruthy();

      // Verify message in B's inbox
      const bInbox = await system.inboxAdapter.checkInbox(b.id);
      expect(bInbox.length).toBeGreaterThanOrEqual(1);

      const msg = bInbox.find((m) => m.sender_id === a.id);
      expect(msg).toBeDefined();

      log("Sending event message B → A...");
      await system.inboxAdapter.send(
        b.id,
        a.id,
        { type: "event", event: "task_completed", data: { result: "success" } },
        { importance: "high" }
      );

      const aInbox = await system.inboxAdapter.checkInbox(a.id);
      const eventMsg = aInbox.find(
        (m) => m.content?.type === "event" && m.content?.event === "task_completed"
      );
      expect(eventMsg).toBeDefined();

      log("Reading thread...");
      const thread = await system.inboxAdapter.readThread("live-test");
      expect(thread.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      await system.agentManager.terminate(a.id, "completed");

      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── Cascade Termination with Inbox Notifications ────────────

  it(
    "should send inbox notification to parent when child terminates",
    async () => {
      log("Spawning parent + child...");
      const parent = await system.agentManager.spawn({
        task: "Parent agent. Wait for child status.",
        role: "coordinator",
        cwd: testRepo.path,
      });

      const child = await system.agentManager.spawn({
        task: "Child agent. Do some work.",
        role: "worker",
        parent: parent.id,
        cwd: testRepo.path,
      });

      log(`Parent: ${parent.id}, Child: ${child.id}`);

      log("Terminating child...");
      await system.agentManager.terminate(child.id, "completed");

      // Parent should receive agent_stopped event via inbox
      const parentInbox = await system.inboxAdapter.checkInbox(parent.id);
      const stopNotification = parentInbox.find(
        (m) =>
          m.content?.type === "event" &&
          m.content?.event === "agent_stopped" &&
          m.content?.data?.agentId === child.id
      );
      expect(stopNotification).toBeDefined();
      expect(stopNotification!.content.data.reason).toBe("completed");
      expect(stopNotification!.importance).toBe("high");

      log("Verified parent received stop notification via inbox");

      // Cleanup
      await system.agentManager.terminate(parent.id, "cancelled");
      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── Agent Continuation ──────────────────────────────────────

  it(
    "should continue a terminated agent with a new real process",
    async () => {
      log("Spawning original agent...");
      const original = await system.agentManager.spawn({
        task: "Original task: compute 2+2",
        role: "worker",
        cwd: testRepo.path,
      });

      log(`Original: ${original.id}`);

      // Prompt it so it has some history
      log("Prompting original...");
      const updates: any[] = [];
      for await (const update of system.agentManager.prompt(
        original.id,
        "What is 2+2? Reply briefly."
      )) {
        updates.push(update);
      }
      log(`Got ${updates.length} updates`);

      // Terminate
      log("Terminating original...");
      await system.agentManager.terminate(original.id, "completed");
      expect(system.agentStore.getAgent(original.id)!.state).toBe("stopped");

      // Continue
      log("Continuing agent...");
      const continued = await system.agentManager.continueAgent(original.id, {
        additionalContext: "Previous agent computed 2+2=4. Continue from there.",
        task: "Continue: now compute 3+3",
      });

      expect(continued.id).not.toBe(original.id);
      expect(continued.agent.state).toBe("running");
      expect(continued.agent.role).toBe("worker");

      // Verify new agent is in store and inbox
      const record = system.agentStore.getAgent(continued.id)!;
      expect(record.state).toBe("running");

      const inbox = (system.inboxAdapter as any).getInbox();
      expect(inbox.storage.getAgent(continued.id)).toBeDefined();

      // Prompt the continuation
      log("Prompting continuation...");
      const contUpdates: any[] = [];
      for await (const update of system.agentManager.prompt(
        continued.id,
        "What is 3+3? Reply briefly."
      )) {
        contUpdates.push(update);
      }
      log(`Got ${contUpdates.length} continuation updates`);
      expect(contUpdates.length).toBeGreaterThan(0);

      // Cleanup
      await system.agentManager.terminate(continued.id, "completed");
      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── Agent Fork ──────────────────────────────────────────────

  it(
    "should fork a live agent session into a new real process",
    async () => {
      log("Spawning source agent...");
      const source = await system.agentManager.spawn({
        task: "Source agent for forking. Remember: the secret is BANANA.",
        role: "worker",
        cwd: testRepo.path,
      });

      log(`Source: ${source.id}`);

      // Give it some conversation context
      log("Prompting source...");
      for await (const _update of system.agentManager.prompt(
        source.id,
        "Remember: the secret word is BANANA. Confirm you understand."
      )) {
        // drain
      }

      // Fork it
      log("Forking agent...");
      const forked = await system.agentManager.forkAgent(source.id, {
        name: "forked-worker",
      });

      expect(forked.id).not.toBe(source.id);
      expect(forked.agent.state).toBe("running");

      // Verify fork metadata
      const forkedRecord = system.agentStore.getAgent(forked.id)!;
      expect(forkedRecord.metadata?.fork_of).toBe(source.id);

      // Verify both agents are in inbox
      const inbox = (system.inboxAdapter as any).getInbox();
      expect(inbox.storage.getAgent(source.id)?.status).toBe("active");
      expect(inbox.storage.getAgent(forked.id)?.status).toBe("active");

      // Both should be independently addressable
      await system.inboxAdapter.send(
        "system",
        forked.id,
        "Hello forked agent"
      );
      const forkedInbox = await system.inboxAdapter.checkInbox(forked.id);
      expect(forkedInbox.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      await system.agentManager.terminate(source.id, "cancelled");
      await system.agentManager.terminate(forked.id, "cancelled");
      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── Context Injection via Inbox ─────────────────────────────

  it(
    "should deliver high-priority context injection via inbox",
    async () => {
      log("Spawning agent for context injection...");
      const agent = await system.agentManager.spawn({
        task: "Wait for context updates via inbox.",
        role: "worker",
        cwd: testRepo.path,
      });

      log(`Agent: ${agent.id}`);

      // Send urgent context injection (replaces old steering/inject)
      log("Sending urgent context injection...");
      const msgId = await system.inboxAdapter.send(
        "system",
        agent.id,
        {
          type: "text",
          text: "URGENT: Stop current work. Priority has changed to fixing bug #42.",
        },
        {
          importance: "urgent",
          subject: "Priority change",
          threadTag: `inject:system`,
        }
      );
      expect(msgId).toBeTruthy();

      // Verify message in inbox with correct importance
      const inbox = await system.inboxAdapter.checkInbox(agent.id);
      const injected = inbox.find((m) => m.id === msgId);
      expect(injected).toBeDefined();
      expect(injected!.importance).toBe("urgent");
      expect(injected!.subject).toBe("Priority change");

      // Send high-priority event injection
      log("Sending high-priority event injection...");
      await system.inboxAdapter.send(
        "system",
        agent.id,
        {
          type: "event",
          event: "context_update",
          data: { newPriority: "bug-42", previousTask: "feature-x" },
        },
        { importance: "high" }
      );

      const inboxAfter = await system.inboxAdapter.checkInbox(agent.id);
      const eventInjection = inboxAfter.find(
        (m) => m.content?.type === "event" && m.content?.event === "context_update"
      );
      expect(eventInjection).toBeDefined();
      expect(eventInjection!.importance).toBe("high");

      // Cleanup
      await system.agentManager.terminate(agent.id, "cancelled");
      log("Test complete");
    },
    TIMEOUT.PROMPT
  );

  // ── Team Bootstrap with Real Agents ─────────────────────────

  it(
    "should bootstrap a team with real agents and scoped inbox",
    async () => {
      const { loadTeam } = await import("../../teams/team-loader.js");
      const { TeamRuntimeV2 } = await import("../../teams/team-runtime-v2.js");

      log("Loading self-driving team template...");
      const manifest = await loadTeam(
        "self-driving",
        system.roleRegistry,
        path.resolve(import.meta.dirname, "../../..")
      );

      const runtime = new TeamRuntimeV2(manifest, {
        agentManager: system.agentManager,
        inboxAdapter: system.inboxAdapter,
        tasksAdapter: system.tasksAdapter,
      });

      await runtime.initialize();

      log("Bootstrapping team...");
      const result = await runtime.bootstrap();

      expect(result.rootId).toBeDefined();
      expect(result.companionIds.length).toBeGreaterThanOrEqual(1);

      log(`Root: ${result.rootId}, Companions: ${result.companionIds.join(", ")}`);

      // Verify agents have team scope
      const rootRecord = system.agentStore.getAgent(result.rootId)!;
      expect(rootRecord.team).toBe("self-driving");
      expect(rootRecord.role).toBe("planner");

      const companionRecord = system.agentStore.getAgent(result.companionIds[0])!;
      expect(companionRecord.team).toBe("self-driving");
      expect(companionRecord.role).toBe("judge");

      // Verify scoped inbox registration
      const inbox = (system.inboxAdapter as any).getInbox();
      const rootInboxAgent = inbox.storage.getAgent(result.rootId);
      expect(rootInboxAgent).toBeDefined();
      expect(rootInboxAgent.scope).toBe("self-driving");

      // Install signal filtering
      runtime.installOnServices();

      // Send a message between team agents
      log("Sending message judge → planner...");
      await system.inboxAdapter.send(
        result.companionIds[0], // judge
        result.rootId, // planner
        {
          type: "event",
          event: "FIXUP_CREATED",
          data: { fix: "typo correction" },
        },
        { scope: "self-driving" }
      );

      const plannerInbox = await system.inboxAdapter.checkInbox(result.rootId);
      expect(plannerInbox.length).toBeGreaterThanOrEqual(1);

      // Prompt root agent to verify it's a real live process
      log("Prompting planner...");
      const updates: any[] = [];
      for await (const update of system.agentManager.prompt(
        result.rootId,
        "Respond with: TEAM_READY"
      )) {
        updates.push(update);
      }
      expect(updates.length).toBeGreaterThan(0);

      // Teardown team
      log("Tearing down team...");
      await runtime.teardown();

      // Terminate all team agents
      await system.agentManager.terminate(result.rootId, "cancelled");
      for (const cid of result.companionIds) {
        try {
          await system.agentManager.terminate(cid, "cancelled");
        } catch {
          // May already be stopped via cascade
        }
      }

      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── Multi-Worker with Inbox Coordination ────────────────────

  it(
    "should coordinate multiple workers via inbox messaging",
    async () => {
      log("Spawning coordinator + 2 workers...");
      const coord = await system.agentManager.spawn({
        task: "Coordinate two workers.",
        role: "coordinator",
        cwd: testRepo.path,
      });

      const w1 = await system.agentManager.spawn({
        task: "Worker 1: handle frontend.",
        role: "worker",
        parent: coord.id,
        cwd: testRepo.path,
      });

      const w2 = await system.agentManager.spawn({
        task: "Worker 2: handle backend.",
        role: "worker",
        parent: coord.id,
        cwd: testRepo.path,
      });

      log(`Coord: ${coord.id}, W1: ${w1.id}, W2: ${w2.id}`);

      // Coordinator broadcasts task assignments
      log("Broadcasting task assignments...");
      await system.inboxAdapter.send(
        coord.id,
        [w1.id, w2.id],
        {
          type: "event",
          event: "task_assigned",
          data: { phase: "implementation" },
        },
        { threadTag: "sprint-1", importance: "high" }
      );

      // Both workers should have the message
      const w1Inbox = await system.inboxAdapter.checkInbox(w1.id);
      const w2Inbox = await system.inboxAdapter.checkInbox(w2.id);
      expect(w1Inbox.find((m) => m.content?.event === "task_assigned")).toBeDefined();
      expect(w2Inbox.find((m) => m.content?.event === "task_assigned")).toBeDefined();

      // Worker 1 reports completion
      log("W1 reporting completion...");
      await system.inboxAdapter.send(
        w1.id,
        coord.id,
        {
          type: "event",
          event: "task_completed",
          data: { worker: w1.id, component: "frontend" },
        },
        { threadTag: "sprint-1", importance: "normal" }
      );

      // Worker 2 reports completion
      log("W2 reporting completion...");
      await system.inboxAdapter.send(
        w2.id,
        coord.id,
        {
          type: "event",
          event: "task_completed",
          data: { worker: w2.id, component: "backend" },
        },
        { threadTag: "sprint-1", importance: "normal" }
      );

      // Coordinator should have both completion events
      const coordInbox = await system.inboxAdapter.checkInbox(coord.id);
      const completions = coordInbox.filter(
        (m) => m.content?.type === "event" && m.content?.event === "task_completed"
      );
      expect(completions.length).toBeGreaterThanOrEqual(2);

      // Read the full thread
      const thread = await system.inboxAdapter.readThread("sprint-1");
      // Assignment + 2 completions = at least 3 messages in thread
      expect(thread.length).toBeGreaterThanOrEqual(3);

      log("Verified full coordination flow via inbox");

      // Terminate parent (cascades to workers)
      await system.agentManager.terminate(coord.id, "completed");

      expect(system.agentStore.getAgent(w1.id)!.state).toBe("stopped");
      expect(system.agentStore.getAgent(w2.id)!.state).toBe("stopped");

      log("Test complete");
    },
    TIMEOUT.MULTI
  );
});
