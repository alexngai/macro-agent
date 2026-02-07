/**
 * Mail Full Agent E2E Tests
 *
 * Tests that real agent spawning via agentManager.spawn() correctly
 * creates mail conversations, wires the ConversationMap, and cleans
 * up on terminate.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable (and authenticated Claude Code)
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/mail/__tests__/mail-full-agent.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
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
  createTaskManager,
  type TaskManager,
} from "../../task/task-manager.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../router/message-router.js";
import {
  createCombinedServer,
  type CombinedServer,
  type CombinedServerServices,
} from "../../server/combined-server.js";
import type { MailService } from "../mail-service.js";
import type { ConversationMap } from "../conversation-map.js";
import type { AgentId } from "../../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Test Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;

const TIMEOUT = {
  SPAWN: 60000,
  MULTI_SPAWN: 180000,
  HIERARCHY: 120000,
};

function log(message: string): void {
  console.log(`[Mail E2E] ${message}`);
}

function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

/**
 * Create an isolated test git repo.
 */
function createTestRepo(): { path: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-agent-e2e-"));
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

// ─────────────────────────────────────────────────────────────────
// ACP WebSocket Client
// ─────────────────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class ACPTestClient {
  private ws!: WebSocket;
  private waiters: Map<number, (msg: JsonRpcMessage) => void> = new Map();
  private nextId = 1;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10000);
      this.ws.on("open", () => { clearTimeout(timeout); resolve(); });
      this.ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as JsonRpcMessage;
          if (msg.id !== undefined) {
            const waiter = this.waiters.get(msg.id);
            if (waiter) {
              this.waiters.delete(msg.id);
              waiter(msg);
            }
          }
        } catch { /* ignore */ }
      });
    });
  }

  async request(method: string, params?: unknown, timeoutMs = 30000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      this.waiters.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  }

  async initialize(): Promise<JsonRpcMessage> {
    return this.request("initialize", {
      protocolVersion: 1,
      capabilities: {},
      clientInfo: { name: "mail-e2e-test", version: "1.0.0" },
    });
  }

  async newSession(params: { cwd?: string } = {}): Promise<JsonRpcMessage> {
    return this.request("session/new", { mcpServers: [], ...params }, 60000);
  }

  async spawnAgent(parentId: string, task: string): Promise<JsonRpcMessage> {
    return this.request("_macro/spawnAgent", {
      task_description: task,
      parentId,
    }, 60000);
  }

  close(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("Mail Full Agent E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: CombinedServer;
  let mailService: MailService;
  let conversationMap: ConversationMap;
  let testRepo: { path: string; cleanup: () => void };
  let testPort: number;
  const clients: ACPTestClient[] = [];

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    testRepo = createTestRepo();
    testPort = getRandomPort();

    // File-based EventStore (required for MCP subprocess access)
    const instanceId = `mail-e2e-${Date.now()}`;
    eventStore = await createEventStore({
      instanceId,
      baseDir: testRepo.path,
    });
    messageRouter = createMessageRouter(eventStore);
    taskManager = createTaskManager(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: testRepo.path,
    });

    // CombinedServer auto-wires: mailService, conversationMap, turnRecorder
    const services: CombinedServerServices = {
      eventStore,
      agentManager,
      taskManager,
      messageRouter,
    };

    server = createCombinedServer(services, {
      port: testPort,
      host: "localhost",
      defaultCwd: testRepo.path,
    });
    await server.start();

    // Get the auto-wired mail services
    mailService = server.mailService!;
    conversationMap = server.conversationMap!;

    expect(mailService).toBeDefined();
    expect(conversationMap).toBeDefined();

    log(`Server started on port ${testPort}`);
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    for (const client of clients) {
      client.close();
    }
    clients.length = 0;

    // Terminate all agents
    try {
      const heads = agentManager.listHeadManagers();
      for (const head of heads) {
        try {
          await agentManager.terminate(head.id, "test_cleanup");
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    await server?.stop().catch(() => {});
    await agentManager?.close();
    await eventStore?.close();
    testRepo?.cleanup();
    log("Cleanup complete");
  });

  describe("Spawn creates mail conversations", () => {
    testFn(
      "creates task conversation when spawning child agent",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create head manager session
        const sessionResult = await client.newSession({ cwd: testRepo.path });
        expect(sessionResult.error).toBeUndefined();
        log("Head manager session created");

        const headManagers = agentManager.listHeadManagers();
        expect(headManagers.length).toBeGreaterThanOrEqual(1);
        const headId = headManagers[0].id;
        log(`Head manager: ${headId}`);

        // Verify head manager has a session conversation in conversationMap
        const sessionConvId = conversationMap.getSessionConversation(headId);
        // Note: session conversation is created by POST /api/init, not by ACP session/new
        // The ACP path doesn't create session conversations — that's fine for this test

        // Spawn child agent
        const spawnResult = await client.spawnAgent(headId, "Worker: process test data");
        expect(spawnResult.error).toBeUndefined();
        const childId = (spawnResult.result as any).agentId;
        expect(childId).toBeDefined();
        log(`Child spawned: ${childId}`);

        // Verify task conversation was created for child
        const childConvId = conversationMap.getAgentConversation(childId);
        expect(childConvId).toBeDefined();
        log(`Child task conversation: ${childConvId}`);

        // Verify conversation properties
        const childConv = mailService.getConversation(childConvId!);
        expect(childConv).not.toBeNull();
        expect(childConv!.type).toBe("task");
        expect(childConv!.status).toBe("active");
        expect(childConv!.subject).toBe("Worker: process test data");
        log(`Conversation type=${childConv!.type}, status=${childConv!.status}`);

        // Verify participants: parent + child
        const participants = mailService.listParticipants(childConvId!);
        expect(participants).toHaveLength(2);
        const participantIds = participants.map((p) => p.id);
        expect(participantIds).toContain(headId);
        expect(participantIds).toContain(childId);

        // Verify roles
        const parentParticipant = participants.find((p) => p.id === headId);
        const childParticipant = participants.find((p) => p.id === childId);
        expect(parentParticipant!.role).toBe("initiator");
        expect(childParticipant!.role).toBe("worker");
        log("Participants verified: initiator + worker");
      },
      { timeout: TIMEOUT.SPAWN },
    );

    testFn(
      "creates conversation tree with correct parentConversationId for 3-level hierarchy",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Level 0: head manager
        const sessionResult = await client.newSession({ cwd: testRepo.path });
        expect(sessionResult.error).toBeUndefined();
        const headId = agentManager.listHeadManagers()[0].id;
        log(`Level 0 (Head): ${headId}`);

        // Level 1: team lead
        const level1Result = await client.spawnAgent(headId, "Team Lead: coordinate workers");
        expect(level1Result.error).toBeUndefined();
        const level1Id = (level1Result.result as any).agentId;
        log(`Level 1 (Lead): ${level1Id}`);

        // Level 2: worker (child of Level 1)
        const level2Result = await client.spawnAgent(level1Id, "Worker: execute task");
        expect(level2Result.error).toBeUndefined();
        const level2Id = (level2Result.result as any).agentId;
        log(`Level 2 (Worker): ${level2Id}`);

        // Verify conversation chain
        const level1ConvId = conversationMap.getAgentConversation(level1Id)!;
        const level2ConvId = conversationMap.getAgentConversation(level2Id)!;
        expect(level1ConvId).toBeDefined();
        expect(level2ConvId).toBeDefined();

        const level1Conv = mailService.getConversation(level1ConvId);
        const level2Conv = mailService.getConversation(level2ConvId);

        // Level 2's parent conversation should be Level 1's task conversation
        expect(level2Conv!.parentConversationId).toBe(level1ConvId);
        log(`Level 2 parentConversationId → Level 1 task conv: correct`);

        // Level 1's parent conversation should be head manager's conversation (if it exists)
        const headConvId =
          conversationMap.getAgentConversation(headId) ??
          conversationMap.getSessionConversation(headId);
        if (headConvId) {
          expect(level1Conv!.parentConversationId).toBe(headConvId);
          log(`Level 1 parentConversationId → Head conv: correct`);
        } else {
          // Head manager has no conversation (ACP path doesn't create one)
          expect(level1Conv!.parentConversationId).toBeUndefined();
          log(`Level 1 parentConversationId → undefined (no head conv): correct`);
        }

        // Verify total conversations
        const allConvs = mailService.listConversations({ type: "task" });
        expect(allConvs.length).toBeGreaterThanOrEqual(2);
        log(`Total task conversations: ${allConvs.length}`);
      },
      { timeout: TIMEOUT.HIERARCHY },
    );

    testFn(
      "creates separate task conversations for multiple children",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        await client.newSession({ cwd: testRepo.path });
        const headId = agentManager.listHeadManagers()[0].id;

        // Spawn two children
        const child1Result = await client.spawnAgent(headId, "Worker A: first task");
        const child2Result = await client.spawnAgent(headId, "Worker B: second task");
        expect(child1Result.error).toBeUndefined();
        expect(child2Result.error).toBeUndefined();

        const child1Id = (child1Result.result as any).agentId;
        const child2Id = (child2Result.result as any).agentId;
        log(`Child 1: ${child1Id}, Child 2: ${child2Id}`);

        // Verify separate conversations
        const conv1Id = conversationMap.getAgentConversation(child1Id)!;
        const conv2Id = conversationMap.getAgentConversation(child2Id)!;
        expect(conv1Id).toBeDefined();
        expect(conv2Id).toBeDefined();
        expect(conv1Id).not.toBe(conv2Id);

        const conv1 = mailService.getConversation(conv1Id);
        const conv2 = mailService.getConversation(conv2Id);
        expect(conv1!.subject).toBe("Worker A: first task");
        expect(conv2!.subject).toBe("Worker B: second task");

        // Both should have same parent conversation
        expect(conv1!.parentConversationId).toBe(conv2!.parentConversationId);
        log("Both children share same parentConversationId");

        // Each conversation should have 2 participants (parent + child)
        expect(mailService.listParticipants(conv1Id)).toHaveLength(2);
        expect(mailService.listParticipants(conv2Id)).toHaveLength(2);
        log("Each conversation has 2 participants");
      },
      { timeout: TIMEOUT.MULTI_SPAWN },
    );
  });

  describe("Terminate cleans up mail conversations", () => {
    testFn(
      "closes task conversation on agent terminate",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();
        await client.newSession({ cwd: testRepo.path });
        const headId = agentManager.listHeadManagers()[0].id;

        // Spawn child
        const childResult = await client.spawnAgent(headId, "Ephemeral worker");
        const childId = (childResult.result as any).agentId;
        const childConvId = conversationMap.getAgentConversation(childId)!;

        // Verify conversation is active
        expect(mailService.getConversation(childConvId)!.status).toBe("active");
        log(`Child conv ${childConvId} is active`);

        // Terminate the child
        await agentManager.terminate(childId, "completed");
        log(`Child ${childId} terminated`);

        // Verify conversation is closed
        const closedConv = mailService.getConversation(childConvId);
        expect(closedConv!.status).toBe("completed");
        log(`Child conv status: ${closedConv!.status}`);

        // Verify agent removed from conversationMap
        expect(conversationMap.getAgentConversation(childId)).toBeUndefined();
        log("Agent removed from conversationMap");
      },
      { timeout: TIMEOUT.SPAWN },
    );

    testFn(
      "cascade terminate closes all descendant conversations",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();
        await client.newSession({ cwd: testRepo.path });
        const headId = agentManager.listHeadManagers()[0].id;

        // Build 3-level hierarchy
        const level1Result = await client.spawnAgent(headId, "Middle manager");
        const level1Id = (level1Result.result as any).agentId;
        const level1ConvId = conversationMap.getAgentConversation(level1Id)!;

        const level2Result = await client.spawnAgent(level1Id, "Leaf worker");
        const level2Id = (level2Result.result as any).agentId;
        const level2ConvId = conversationMap.getAgentConversation(level2Id)!;

        // All active
        expect(mailService.getConversation(level1ConvId)!.status).toBe("active");
        expect(mailService.getConversation(level2ConvId)!.status).toBe("active");
        log("All conversations active");

        // Terminate head manager (cascade terminates level1 and level2)
        await agentManager.terminate(headId, "completed");
        log("Head manager terminated (cascade)");

        // Wait a moment for cascade to complete
        await new Promise((r) => setTimeout(r, 500));

        // Both descendant conversations should be closed
        expect(mailService.getConversation(level1ConvId)!.status).not.toBe("active");
        expect(mailService.getConversation(level2ConvId)!.status).not.toBe("active");
        log(`Level 1 conv: ${mailService.getConversation(level1ConvId)!.status}`);
        log(`Level 2 conv: ${mailService.getConversation(level2ConvId)!.status}`);

        // Agents removed from conversationMap
        expect(conversationMap.getAgentConversation(level1Id)).toBeUndefined();
        expect(conversationMap.getAgentConversation(level2Id)).toBeUndefined();
        log("All agents removed from conversationMap");
      },
      { timeout: TIMEOUT.HIERARCHY },
    );
  });

  describe("Mail conversations visible via MAP protocol", () => {
    testFn(
      "task conversations created by spawn appear in mail/list",
      async () => {
        // ACP client for spawning
        const acpClient = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(acpClient);

        await acpClient.connect();
        await acpClient.initialize();
        await acpClient.newSession({ cwd: testRepo.path });
        const headId = agentManager.listHeadManagers()[0].id;

        // Spawn a child
        const childResult = await acpClient.spawnAgent(headId, "Visible worker");
        expect(childResult.error).toBeUndefined();
        const childId = (childResult.result as any).agentId;
        log(`Child spawned: ${childId}`);

        // MAP client to query conversations
        const mapWs = new WebSocket(`ws://localhost:${testPort}/map`);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("MAP timeout")), 5000);
          mapWs.on("open", () => { clearTimeout(timeout); resolve(); });
          mapWs.on("error", (e) => { clearTimeout(timeout); reject(e); });
        });

        // Send mail/list via MAP
        const listId = 1;
        mapWs.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "mail/list",
          params: { type: "task" },
          id: listId,
        }));

        const response = await new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("mail/list timeout")), 10000);
          mapWs.on("message", (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === listId) {
              clearTimeout(timeout);
              resolve(msg);
            }
          });
        });

        expect(response.error).toBeUndefined();
        expect(response.result.conversations.length).toBeGreaterThanOrEqual(1);

        // Find our child's conversation
        const childConvId = conversationMap.getAgentConversation(childId);
        const found = response.result.conversations.find(
          (c: any) => c.id === childConvId,
        );
        expect(found).toBeDefined();
        expect(found.type).toBe("task");
        expect(found.status).toBe("active");
        log(`Task conversation found via MAP mail/list`);

        mapWs.close();
      },
      { timeout: TIMEOUT.SPAWN },
    );
  });
});
