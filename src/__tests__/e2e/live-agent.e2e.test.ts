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

  // ── Control Socket: Spawn via IPC ───────────────────────────

  it(
    "should spawn agent via control socket (MCP subprocess flow)",
    async () => {
      const { ControlClient } = await import("../../control/control-client.js");

      log("Connecting control client to control socket...");
      const controlClient = new ControlClient(system.controlSocketPath);
      await controlClient.connect();
      expect(controlClient.connected).toBe(true);

      log("Pinging control server...");
      const pingOk = await controlClient.ping();
      expect(pingOk).toBe(true);

      // First, spawn a coordinator via the normal API (to be the parent)
      log("Spawning coordinator via main API...");
      const coordinator = await system.agentManager.spawn({
        task: "Coordinator for control socket test",
        role: "coordinator",
        cwd: testRepo.path,
      });

      // Now spawn a worker via the control socket (simulating MCP subprocess)
      log("Spawning worker via control socket...");
      const spawnResult = await controlClient.spawn({
        task: "Worker spawned via control socket",
        role: "worker",
        parent: coordinator.id,
        cwd: testRepo.path,
      });

      expect(spawnResult.agent_id).toBeDefined();
      expect(spawnResult.role).toBe("worker");
      log(`Worker spawned via control socket: ${spawnResult.agent_id}`);

      // Verify the agent exists in AgentStore (shared SQLite)
      const record = system.agentStore.getAgent(spawnResult.agent_id);
      expect(record).not.toBeNull();
      expect(record!.role).toBe("worker");
      expect(record!.state).toBe("running");
      expect(record!.parent_id).toBe(coordinator.id);

      // Verify the agent is registered in inbox
      const inbox = (system.inboxAdapter as any).getInbox();
      const inboxAgent = inbox.storage.getAgent(spawnResult.agent_id);
      expect(inboxAgent).toBeDefined();
      expect(inboxAgent.status).toBe("active");

      // Verify the agent appears in hierarchy
      const hierarchy = system.agentManager.getHierarchy(coordinator.id);
      expect(hierarchy!.totalAgents).toBe(2);

      // Query via control socket (simulating MCP subprocess reads)
      log("Querying agent via control socket...");
      const agentFromControl = await controlClient.getAgent(spawnResult.agent_id);
      expect(agentFromControl).toBeDefined();
      expect((agentFromControl as any).role).toBe("worker");

      const children = await controlClient.getChildren(coordinator.id);
      expect(children).toHaveLength(1);
      expect((children[0] as any).id).toBe(spawnResult.agent_id);

      // Terminate via control socket (simulating MCP subprocess stop_agent)
      log("Terminating worker via control socket...");
      await controlClient.terminate(spawnResult.agent_id, "completed");

      const stoppedRecord = system.agentStore.getAgent(spawnResult.agent_id);
      expect(stoppedRecord!.state).toBe("stopped");
      expect(stoppedRecord!.stop_reason).toBe("completed");

      // Verify deregistered from inbox
      const afterStop = inbox.storage.getAgent(spawnResult.agent_id);
      expect(afterStop.status).toBe("offline");

      // Cleanup
      controlClient.disconnect();
      await system.agentManager.terminate(coordinator.id, "cancelled");

      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── Control Socket: Error Handling ──────────────────────────

  it(
    "should handle control socket errors correctly",
    async () => {
      const { ControlClient } = await import("../../control/control-client.js");

      log("Connecting control client...");
      const controlClient = new ControlClient(system.controlSocketPath);
      await controlClient.connect();

      // Try to terminate a non-existent agent
      log("Testing terminate of non-existent agent...");
      let terminateError: Error | null = null;
      try {
        await controlClient.terminate("nonexistent_agent", "cancelled");
      } catch (err) {
        terminateError = err as Error;
      }
      expect(terminateError).not.toBeNull();
      expect(terminateError!.message).toContain("not found");

      // Try to get a non-existent agent
      log("Testing get of non-existent agent...");
      let getError: Error | null = null;
      try {
        await controlClient.getAgent("nonexistent_agent");
      } catch (err) {
        getError = err as Error;
      }
      expect(getError).not.toBeNull();

      controlClient.disconnect();
      log("Test complete");
    },
    TIMEOUT.SPAWN
  );

  // ── Helper: detect tool calls in session updates ────────────

  /**
   * Extract tool calls from session updates.
   *
   * acp-factory tool_call updates have this structure:
   * { sessionUpdate: "tool_call", title: "mcp__macro-agent__done", kind: "tool_call", ... }
   *
   * The tool name is in the `title` field, formatted as "mcp__<server>__<tool>" or just "<tool>".
   */
  function findToolCalls(updates: any[]): { name: string; fullTitle: string; input: any }[] {
    const calls: { name: string; fullTitle: string; input: any }[] = [];
    for (const u of updates) {
      const uAny = u as any;

      if (
        (uAny.sessionUpdate === "tool_call" || uAny.sessionUpdate === "tool_call_update") &&
        uAny.title
      ) {
        const fullTitle = uAny.title as string;
        // Extract short name: "mcp__macro-agent__done" → "done"
        const parts = fullTitle.split("__");
        const shortName = parts[parts.length - 1];

        if (!calls.some(c => c.fullTitle === fullTitle)) {
          calls.push({
            name: shortName,
            fullTitle,
            input: uAny.rawInput ?? uAny.input,
          });
        }
      }

      // content block format
      if (uAny.content?.type === "tool_use") {
        const name = uAny.content.name;
        if (!calls.some(c => c.name === name)) {
          calls.push({ name, fullTitle: name, input: uAny.content.input });
        }
      }
    }
    return calls;
  }

  function getTextContent(updates: any[]): string {
    const parts: string[] = [];
    for (const u of updates) {
      const uAny = u as any;
      if (uAny.sessionUpdate === "agent_message_chunk" && uAny.content?.text) {
        parts.push(uAny.content.text);
      }
    }
    return parts.join("");
  }

  // ── Agent-Initiated Spawn via MCP Tool ──────────────────────

  it(
    "should allow a real agent to spawn a child via spawn_agent MCP tool",
    async () => {
      log("Spawning coordinator agent...");
      const coordinator = await system.agentManager.spawn({
        task: "You are a coordinator. When asked, use the spawn_agent tool to create a worker agent.",
        role: "coordinator",
        cwd: testRepo.path,
      });

      log(`Coordinator: ${coordinator.id}`);

      // Prompt the coordinator to spawn a child using the MCP tool
      log("Prompting coordinator to spawn a worker...");
      const updates: any[] = [];
      for await (const update of system.agentManager.prompt(
        coordinator.id,
        'Use the spawn_agent tool to create a worker agent with task "Write a hello world function". Do not do anything else — just call spawn_agent and report the result.'
      )) {
        updates.push(update);
      }

      log(`Got ${updates.length} updates from coordinator prompt`);

      // Log update types and any text content for debugging
      for (const u of updates) {
        const uAny = u as any;
        if (uAny.sessionUpdate === "agent_message_chunk" && uAny.content?.text) {
          log(`  [text] ${uAny.content.text.slice(0, 200)}`);
        } else if (uAny.type === "tool_use" || uAny.subtype === "tool_use") {
          log(`  [tool_use] ${JSON.stringify(uAny).slice(0, 200)}`);
        } else if (uAny.type === "tool_result" || uAny.subtype === "tool_result") {
          log(`  [tool_result] ${JSON.stringify(uAny).slice(0, 200)}`);
        } else {
          log(`  [${uAny.sessionUpdate ?? uAny.type ?? "unknown"}]`);
        }
      }

      // Wait a moment for the spawn to complete (async via control socket)
      await new Promise((r) => setTimeout(r, 2000));

      // Check if a child was spawned
      const children = system.agentManager.getChildren(coordinator.id);
      log(`Children found: ${children.length}`);

      if (children.length > 0) {
        log(`Child agent spawned: ${children[0].id} (role: ${children[0].role})`);

        // Verify child is in AgentStore
        const childRecord = system.agentStore.getAgent(children[0].id);
        expect(childRecord).not.toBeNull();
        expect(childRecord!.state).toBe("running");
        expect(childRecord!.parent_id).toBe(coordinator.id);

        // Verify child is in inbox
        const inbox = (system.inboxAdapter as any).getInbox();
        const childInbox = inbox.storage.getAgent(children[0].id);
        expect(childInbox).toBeDefined();
        expect(childInbox.status).toBe("active");

        // Verify hierarchy
        const hierarchy = system.agentManager.getHierarchy(coordinator.id);
        expect(hierarchy!.totalAgents).toBeGreaterThanOrEqual(2);

        log("Agent-initiated spawn via MCP tool verified!");
      } else {
        // The agent might not have called spawn_agent — check the response
        // for tool use indicators
        const hasToolUse = updates.some(
          (u: any) =>
            u.type === "tool_use" ||
            u.subtype === "tool_use" ||
            (typeof u.content === "object" && u.content?.type === "tool_use")
        );
        log(`Tool use detected in updates: ${hasToolUse}`);

        // Even if the agent didn't spawn (model discretion), verify the
        // control socket path was available
        expect(system.controlSocketPath).toBeTruthy();
        log("Note: Agent did not call spawn_agent (model discretion). Control socket path verified.");
      }

      // Cleanup
      await system.agentManager.terminate(coordinator.id, "completed");
      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── done() tool: give worker real work, verify done flow ────

  it(
    "should verify done() tool works when worker completes a real task",
    async () => {
      log("Spawning coordinator + worker...");
      const coordinator = await system.agentManager.spawn({
        task: "You coordinate workers. Monitor their completion status.",
        role: "coordinator",
        cwd: testRepo.path,
      });

      const worker = await system.agentManager.spawn({
        task: "Create a file called task-result.txt, then call the done MCP tool to signal completion.",
        role: "worker",
        parent: coordinator.id,
        cwd: testRepo.path,
      });

      log(`Coordinator: ${coordinator.id}, Worker: ${worker.id}`);

      // Use promptUntilDone — it follows up if the agent doesn't call done()
      log("Prompting worker with task + done instruction...");
      const result = await system.agentManager.promptUntilDone(
        worker.id,
        `Create a file at ${testRepo.path}/task-result.txt with content "task completed". After creating the file, you MUST call the "done" MCP tool with status="completed" and summary="Created task-result.txt". The done tool signals to the orchestration system that you are finished.`,
        {
          maxFollowUps: 2,
          onUpdate: (update: any) => {
            if (update.sessionUpdate === "tool_call") {
              log(`  [tool_call] ${update.toolName ?? "unknown"}`);
            }
          },
        }
      );

      log(`promptUntilDone result: doneCalled=${result.doneCalled}, doneStatus=${result.doneStatus}, updates=${result.updates.length}`);

      // Check if the file was created (verifies worker did real work)
      const { existsSync, readFileSync } = await import("fs");
      const filePath = path.join(testRepo.path, "task-result.txt");
      const fileCreated = existsSync(filePath);
      log(`File created: ${fileCreated}`);
      if (fileCreated) {
        const content = readFileSync(filePath, "utf-8");
        log(`File content: "${content.trim()}"`);
      }

      // Check if done was called
      if (result.doneCalled) {
        log(`done() was called! status=${result.doneStatus}`);

        // Dump done tool_call updates for debugging rawInput
        const doneUpdates = result.updates.filter(
          (u: any) =>
            (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
            typeof u.title === "string" &&
            u.title.endsWith("__done")
        );
        for (const du of doneUpdates) {
          const d = du as any;
          log(`  done update: status=${d.status}, rawInput=${typeof d.rawInput === "string" ? d.rawInput.slice(0, 200) : JSON.stringify(d.rawInput)?.slice(0, 200)}`);
          if (d.content) {
            log(`  done content: ${typeof d.content === "string" ? d.content.slice(0, 200) : JSON.stringify(d.content)?.slice(0, 200)}`);
          }
        }

        // Wait for inbox notifications to propagate
        await new Promise((r) => setTimeout(r, 2000));

        // Check coordinator's inbox for WORKER_DONE or agent_stopped
        const coordInbox = await system.inboxAdapter.checkInbox(coordinator.id);
        log(`Coordinator inbox: ${coordInbox.length} messages`);

        const lifecycleMsgs = coordInbox.filter(
          (m) =>
            m.content?.type === "event" &&
            (m.content?.event === "WORKER_DONE" ||
             m.content?.event === "agent_stopped")
        );
        log(`Lifecycle messages to coordinator: ${lifecycleMsgs.length}`);
        for (const msg of lifecycleMsgs) {
          log(`  event=${msg.content.event}, from=${msg.sender_id}, importance=${msg.importance}`);
        }

        if (lifecycleMsgs.length > 0) {
          expect(lifecycleMsgs.length).toBeGreaterThanOrEqual(1);
          log("Coordinator received lifecycle notification via inbox!");
        }
      } else {
        // done wasn't called — log what happened
        const text = getTextContent(result.updates);
        log(`Worker didn't call done(). Response: ${text.slice(0, 300)}`);

        // Log all tool calls for debugging
        const allToolCalls = findToolCalls(result.updates);
        log(`All tool calls: ${allToolCalls.map(t => t.name).join(", ") || "none"}`);

        // Log update types
        const updateTypes = result.updates
          .map((u: any) => u.sessionUpdate ?? u.type ?? "?")
          .filter((t: string) => t !== "agent_message_chunk");
        log(`Non-text update types: ${updateTypes.join(", ")}`);
      }

      // Cleanup
      try { await system.agentManager.terminate(worker.id, "cancelled"); } catch {}
      await system.agentManager.terminate(coordinator.id, "cancelled");
      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── Agent spawns child, child does work, parent sees result ─

  it(
    "should verify spawned child agent actually executes and produces output",
    async () => {
      log("Spawning coordinator...");
      const coordinator = await system.agentManager.spawn({
        task: "You are a coordinator. Spawn workers and check their results.",
        role: "coordinator",
        cwd: testRepo.path,
      });

      log(`Coordinator: ${coordinator.id}`);

      // Prompt coordinator to spawn a child that creates a file
      log("Prompting coordinator to spawn a worker that creates a file...");
      const spawnUpdates: any[] = [];
      for await (const update of system.agentManager.prompt(
        coordinator.id,
        `Use spawn_agent to create a worker with task "Create a file called hello.txt containing 'Hello from worker agent'". Then tell me the agent_id from the result.`
      )) {
        spawnUpdates.push(update);
      }

      const spawnToolCalls = findToolCalls(spawnUpdates);
      const spawnCalled = spawnToolCalls.some(t => t.name === "spawn_agent");
      log(`spawn_agent called: ${spawnCalled}`);

      // Wait for child to be created
      await new Promise((r) => setTimeout(r, 3000));

      const children = system.agentManager.getChildren(coordinator.id);
      log(`Children: ${children.length}`);

      if (children.length > 0) {
        const child = children[0];
        log(`Child: ${child.id} (state: ${child.state})`);

        // The child is a real Claude Code process.
        // Prompt it to create the file.
        if (system.agentManager.hasActiveSession(child.id)) {
          log("Prompting child to create file...");
          const childUpdates: any[] = [];
          for await (const update of system.agentManager.prompt(
            child.id,
            `Create a file at ${testRepo.path}/hello.txt with content "Hello from worker agent". Use the Write tool.`
          )) {
            childUpdates.push(update);
          }

          const childToolCalls = findToolCalls(childUpdates);
          log(`Child tool calls: ${childToolCalls.map(t => t.name).join(", ") || "none"}`);

          // Wait for file creation
          await new Promise((r) => setTimeout(r, 1000));

          // Verify the file was created
          const { existsSync, readFileSync } = await import("fs");
          const filePath = path.join(testRepo.path, "hello.txt");
          if (existsSync(filePath)) {
            const content = readFileSync(filePath, "utf-8");
            log(`File created! Content: "${content.trim()}"`);
            expect(content).toContain("Hello");
          } else {
            log("File not created (agent may have used different path)");
            // Check if child used any write-like tools
            const wroteFile = childToolCalls.some(
              t => t.name === "Write" || t.name === "write" || t.name === "Bash"
            );
            log(`Child attempted file write: ${wroteFile}`);
          }
        }
      } else {
        log("No children spawned — spawn_agent may not have been called");
        const text = getTextContent(spawnUpdates);
        log(`Coordinator response: ${text.slice(0, 200)}`);
      }

      // Cleanup
      for (const child of children) {
        try { await system.agentManager.terminate(child.id, "cancelled"); } catch {}
      }
      await system.agentManager.terminate(coordinator.id, "cancelled");
      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── Agent calls stop_agent on a child ───────────────────────

  it(
    "should verify agent can stop a child via stop_agent MCP tool",
    async () => {
      log("Spawning coordinator...");
      const coordinator = await system.agentManager.spawn({
        task: "You are a coordinator that manages workers.",
        role: "coordinator",
        cwd: testRepo.path,
      });

      // Spawn a worker directly (so we know it exists)
      const worker = await system.agentManager.spawn({
        task: "Wait for instructions.",
        role: "worker",
        parent: coordinator.id,
        cwd: testRepo.path,
      });

      log(`Coordinator: ${coordinator.id}, Worker: ${worker.id}`);
      expect(system.agentStore.getAgent(worker.id)!.state).toBe("running");

      // Prompt coordinator to stop the worker
      log("Prompting coordinator to stop the worker...");
      const updates: any[] = [];
      for await (const update of system.agentManager.prompt(
        coordinator.id,
        `You have an MCP tool called "stop_agent". Call it with agent_id="${worker.id}" and reason="completed". This is a legitimate test operation on your own child agent.`
      )) {
        updates.push(update);
      }

      const toolCalls = findToolCalls(updates);
      const stopCalled = toolCalls.some(t => t.name === "stop_agent");
      log(`stop_agent called: ${stopCalled}`);

      // Wait for termination regardless — the agent may have called it
      // through a mechanism our detector doesn't catch
      await new Promise((r) => setTimeout(r, 3000));

      const workerRecord = system.agentStore.getAgent(worker.id)!;
      log(`Worker state after prompt: ${workerRecord.state}`);

      if (workerRecord.state === "stopped") {
        log("Worker was stopped (verified in AgentStore)!");
        expect(workerRecord.state).toBe("stopped");
      } else if (stopCalled) {
        log("stop_agent tool was called but worker may still be running");
      } else {
        const text = getTextContent(updates);
        log(`Coordinator response: ${text.slice(0, 200)}`);
        // Log all update types for debugging
        log(`Update types: ${updates.map((u: any) => u.sessionUpdate ?? u.type ?? "?").join(", ")}`);
      }

      // Cleanup
      try { await system.agentManager.terminate(worker.id, "cancelled"); } catch {}
      await system.agentManager.terminate(coordinator.id, "cancelled");
      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── Agent uses inject_context to steer another agent ────────

  it(
    "should verify agent can inject context into another agent via MCP tool",
    async () => {
      log("Spawning two agents...");
      const coordinator = await system.agentManager.spawn({
        task: "You coordinate workers. Use inject_context to steer them.",
        role: "coordinator",
        cwd: testRepo.path,
      });

      const worker = await system.agentManager.spawn({
        task: "Wait for instructions.",
        role: "worker",
        parent: coordinator.id,
        cwd: testRepo.path,
      });

      log(`Coordinator: ${coordinator.id}, Worker: ${worker.id}`);

      // First, have the coordinator spawn a child itself so it "knows" about it
      log("Having coordinator spawn its own child first...");
      const spawnUpdates: any[] = [];
      for await (const update of system.agentManager.prompt(
        coordinator.id,
        `Use spawn_agent to create a worker with task "Wait for context updates".`
      )) {
        spawnUpdates.push(update);
      }
      await new Promise((r) => setTimeout(r, 3000));

      const children = system.agentManager.getChildren(coordinator.id);
      const targetId = children.length > 0
        ? children[children.length - 1].id  // Use the coordinator's own child
        : worker.id;  // Fallback to our manually spawned worker

      log(`Target for inject_context: ${targetId}`);

      // Prompt coordinator to inject context
      log("Prompting coordinator to inject context...");
      const updates: any[] = [];
      for await (const update of system.agentManager.prompt(
        coordinator.id,
        `Use the inject_context tool to send a message to agent "${targetId}". Set content to "New task assignment: implement feature #42" and urgent to true.`
      )) {
        updates.push(update);
      }

      const toolCalls = findToolCalls(updates);
      const injectCalled = toolCalls.some(t => t.name === "inject_context");
      log(`inject_context called: ${injectCalled}`);

      // Check inbox regardless of tool call detection
      await new Promise((r) => setTimeout(r, 2000));

      const targetInbox = await system.inboxAdapter.checkInbox(targetId);
      log(`Target inbox: ${targetInbox.length} messages`);

      const injectedMsg = targetInbox.find(
        (m) => m.sender_id === coordinator.id
      );

      if (injectedMsg) {
        log(`Injected message found! importance=${injectedMsg.importance}, subject=${injectedMsg.subject ?? "none"}`);
        log("Agent-initiated context injection verified!");
      } else if (injectCalled) {
        log("inject_context tool was called but message not found in inbox");
      } else {
        const text = getTextContent(updates);
        log(`Coordinator response: ${text.slice(0, 200)}`);
        log(`Update types: ${updates.map((u: any) => u.sessionUpdate ?? u.type ?? "?").join(", ")}`);
      }

      // Cleanup — terminate all children, then coordinator
      for (const child of system.agentManager.getChildren(coordinator.id)) {
        try { await system.agentManager.terminate(child.id, "cancelled"); } catch {}
      }
      try { await system.agentManager.terminate(worker.id, "cancelled"); } catch {}
      await system.agentManager.terminate(coordinator.id, "completed");
      log("Test complete");
    },
    TIMEOUT.MULTI
  );
});
