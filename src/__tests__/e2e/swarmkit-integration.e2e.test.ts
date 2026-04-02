/**
 * Swarmkit Integration E2E Tests
 *
 * Verifies that the swarmkit integrations (minimem, skill-tree, sessionlog,
 * agentic-mesh, context injection) are properly wired through boot-v2 and
 * AgentManagerV2:
 *
 *   1. minimem MCP server registration on spawned agents
 *   2. Capabilities context injection into system prompts
 *   3. Skill-tree loadout injection per role
 *   4. Sessionlog enrichment of trajectory checkpoints
 *   5. Integration config wiring through boot-v2
 *
 * Run:
 *   npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/swarmkit-integration.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";

// ─────────────────────────────────────────────────────────────────
// Mock acp-factory — capture what gets passed to createSession
// ─────────────────────────────────────────────────────────────────

// Capture createSession calls for assertions. This array is declared
// at module scope so the hoisted vi.mock factory can reference it
// without temporal dead zone issues.
const capturedSessions: Array<{ cwd: string; opts: any }> = [];

vi.mock("acp-factory", () => {
  const createSession = vi.fn().mockImplementation((cwd: string, opts: any) => {
    capturedSessions.push({ cwd, opts });
    return {
      id: `session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      prompt: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true, value: undefined }),
        }),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });

  return {
    AgentFactory: {
      spawn: vi.fn().mockResolvedValue({
        createSession,
        loadSession: vi.fn().mockResolvedValue({
          id: `loaded-${Date.now()}`,
        }),
        close: vi.fn().mockResolvedValue(undefined),
        isRunning: vi.fn().mockReturnValue(true),
      }),
    },
  };
});

vi.mock("opentasks", () => ({
  OpenTasksClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error("No daemon")),
    disconnect: vi.fn(),
    query: vi.fn().mockResolvedValue({ items: [] }),
    link: vi.fn().mockResolvedValue({ success: true }),
    task: vi.fn().mockResolvedValue({ id: "t-1" }),
  })),
}));

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarmkit-e2e-"));
}

/** Wait for async operations to settle */
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

/** Clear captured sessions and return a function to get the latest */
function clearCaptures(): void {
  capturedSessions.length = 0;
}

/** Get the opts from the last captured createSession call */
function lastOpts(): any {
  return capturedSessions[capturedSessions.length - 1]?.opts;
}

// =================================================================
// Test Suite 1: minimem MCP registration
// =================================================================

describe("minimem MCP registration", () => {
  let system: MacroAgentSystemV2;
  let testDir: string;

  beforeAll(async () => {
    testDir = createTestDir();
    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(testDir, "inbox.sock") },
      minimem: {
        enabled: true,
        dir: ".swarm/minimem/",
        provider: "local",
      },
    });
  }, 30000);

  afterAll(async () => {
    try { await system?.shutdown(); } catch { /* ignore */ }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => clearCaptures());

  it("spawned agent includes minimem MCP server", async () => {
    await system.agentManager.spawn({
      task: "Test minimem registration",
      role: "worker",
    });
    await settle();

    expect(capturedSessions.length).toBeGreaterThan(0);
    const opts = lastOpts();
    const mcpServers = opts?.mcpServers ?? [];
    const minimemServer = mcpServers.find((s: any) => s.name === "minimem");

    expect(minimemServer).toBeDefined();
    expect(minimemServer.command).toBe("minimem");
    expect(minimemServer.args).toContain("mcp");
    expect(minimemServer.args).toContain("--dir");
    expect(minimemServer.args).toContain(".swarm/minimem/");
    expect(minimemServer.args).toContain("--provider");
    expect(minimemServer.args).toContain("local");
  });

  it("minimem server args include --global when configured", async () => {
    try { await system.shutdown(); } catch { /* ignore */ }

    const dir2 = createTestDir();
    const system2 = await bootV2({
      cwd: dir2,
      baseDir: dir2,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(dir2, "inbox2.sock") },
      minimem: { enabled: true, global: true },
    });

    clearCaptures();
    await system2.agentManager.spawn({ task: "Global minimem test", role: "worker" });
    await settle();

    const opts = lastOpts();
    const mcpServers = opts?.mcpServers ?? [];
    const minimemServer = mcpServers.find((s: any) => s.name === "minimem");

    expect(minimemServer).toBeDefined();
    expect(minimemServer.args).toContain("--global");

    try { await system2.shutdown(); } catch { /* ignore */ }
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("no minimem MCP server when minimem disabled", async () => {
    const dir3 = createTestDir();
    const system3 = await bootV2({
      cwd: dir3,
      baseDir: dir3,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(dir3, "inbox3.sock") },
    });

    clearCaptures();
    await system3.agentManager.spawn({ task: "No minimem test", role: "worker" });
    await settle();

    const opts = lastOpts();
    const mcpServers = opts?.mcpServers ?? [];
    const minimemServer = mcpServers.find((s: any) => s.name === "minimem");
    expect(minimemServer).toBeUndefined();

    try { await system3.shutdown(); } catch { /* ignore */ }
    try { fs.rmSync(dir3, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

// =================================================================
// Test Suite 2: Context injection
// =================================================================

describe("Context injection into system prompt", () => {
  let system: MacroAgentSystemV2;
  let testDir: string;

  beforeAll(async () => {
    testDir = createTestDir();
    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(testDir, "inbox.sock") },
      minimem: { enabled: true },
      skilltree: { enabled: true },
      sessionlog: { enabled: true, sync: "full" },
    });
  }, 30000);

  afterAll(async () => {
    try { await system?.shutdown(); } catch { /* ignore */ }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => clearCaptures());

  it("system prompt contains Swarm Capabilities header", async () => {
    await system.agentManager.spawn({
      task: "Context injection test",
      role: "worker",
    });
    await settle();

    expect(capturedSessions.length).toBeGreaterThan(0);
    const systemPrompt: string = lastOpts()?.systemPrompt ?? "";
    expect(systemPrompt).toContain("## Swarm Capabilities");
  });

  it("system prompt includes Memory section when minimem enabled", async () => {
    await system.agentManager.spawn({
      task: "Memory context test",
      role: "coordinator",
    });
    await settle();

    const systemPrompt: string = lastOpts()?.systemPrompt ?? "";
    expect(systemPrompt).toContain("### Memory");
    expect(systemPrompt).toContain("minimem MCP tools");
  });

  it("system prompt includes Skills section when skilltree enabled", async () => {
    await system.agentManager.spawn({
      task: "Skilltree context test",
      role: "worker",
    });
    await settle();

    const systemPrompt: string = lastOpts()?.systemPrompt ?? "";
    expect(systemPrompt).toContain("### Per-Role Skills");
  });

  it("system prompt includes inbox section (always enabled)", async () => {
    await system.agentManager.spawn({
      task: "Inbox context test",
      role: "worker",
    });
    await settle();

    const systemPrompt: string = lastOpts()?.systemPrompt ?? "";
    expect(systemPrompt).toContain("agent-inbox MCP tools");
  });

  it("system prompt excludes MAP section when no MAP server configured", async () => {
    await system.agentManager.spawn({
      task: "No MAP context test",
      role: "worker",
    });
    await settle();

    const systemPrompt: string = lastOpts()?.systemPrompt ?? "";
    // The section always appears but shows "No external observability configured"
    expect(systemPrompt).toContain("No external observability configured");
    expect(systemPrompt).not.toContain("MAP: connected");
  });
});

// =================================================================
// Test Suite 3: Skill-tree loadout injection
// =================================================================

describe("Skill-tree loadout injection", () => {
  let system: MacroAgentSystemV2;
  let testDir: string;

  beforeAll(async () => {
    testDir = createTestDir();
    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(testDir, "inbox.sock") },
      skilltree: { enabled: true },
    });
  }, 30000);

  afterAll(async () => {
    try { await system?.shutdown(); } catch { /* ignore */ }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => clearCaptures());

  it("injects skill loadout into system prompt for matching role", async () => {
    const skillContent = "You are a skilled TypeScript developer.\n\n- Use strict types\n- Prefer functional patterns";
    system.agentManager.setSkillLoadout("worker", skillContent);

    await system.agentManager.spawn({
      task: "Skill loadout test",
      role: "worker",
    });
    await settle();

    const systemPrompt: string = lastOpts()?.systemPrompt ?? "";
    expect(systemPrompt).toContain("## Skills");
    expect(systemPrompt).toContain("You are a skilled TypeScript developer.");
    expect(systemPrompt).toContain("Use strict types");
  });

  it("does not inject loadout for non-matching role", async () => {
    system.agentManager.setSkillLoadout("integrator", "Integrator-specific skills here");

    await system.agentManager.spawn({
      task: "Wrong role loadout test",
      role: "worker",
    });
    await settle();

    const systemPrompt: string = lastOpts()?.systemPrompt ?? "";
    expect(systemPrompt).not.toContain("Integrator-specific skills here");
  });

  it("supports multiple role loadouts simultaneously", async () => {
    system.agentManager.setSkillLoadout("worker", "Worker skill set A");
    system.agentManager.setSkillLoadout("coordinator", "Coordinator skill set B");

    await system.agentManager.spawn({
      task: "Multi-role loadout test",
      role: "coordinator",
    });
    await settle();

    const systemPrompt: string = lastOpts()?.systemPrompt ?? "";
    expect(systemPrompt).toContain("Coordinator skill set B");
    expect(systemPrompt).not.toContain("Worker skill set A");
  });
});

// =================================================================
// Test Suite 4: Sessionlog enrichment
// =================================================================

describe("Sessionlog trajectory enrichment", () => {
  let system: MacroAgentSystemV2;
  let testDir: string;

  beforeAll(async () => {
    testDir = createTestDir();

    // Create fake sessionlog state files
    const sessionId = "sess-enrichment-test";
    const sessionsDir = path.join(testDir, ".git", "sessionlog-sessions", sessionId);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "state.json"),
      JSON.stringify({
        sessionId,
        phase: "active",
        turnId: "turn-42",
        stepCount: 15,
        lastCheckpointId: "cp-7",
        tokenUsage: {
          inputTokens: 2500,
          outputTokens: 1200,
          cacheCreationTokens: 300,
          cacheReadTokens: 150,
          apiCallCount: 8,
        },
        filesTouched: ["src/enriched.ts", "package.json"],
        startedAt: "2026-03-28T14:00:00Z",
      }),
    );

    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(testDir, "inbox.sock") },
      sessionlog: { enabled: true, sync: "full" },
    });
  }, 30000);

  afterAll(async () => {
    try { await system?.shutdown(); } catch { /* ignore */ }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("enrichCheckpoint merges sessionlog state into checkpoint", async () => {
    const { findActiveSession, enrichCheckpoint } = await import(
      "../../integrations/sessionlog.js"
    );

    const session = findActiveSession(testDir);
    expect(session).not.toBeNull();
    expect(session!.turnId).toBe("turn-42");

    const base = {
      id: "cp-test",
      session_id: "s-test",
      agent: "test-agent",
      branch: "main" as string | null,
      files_touched: ["src/existing.ts"],
      checkpoints_count: 1,
      token_usage: { input_tokens: 100, output_tokens: 50 },
      metadata: { project: "test" },
    };

    const enriched = enrichCheckpoint(session!, base);

    // Token usage overridden by sessionlog
    expect(enriched.token_usage?.input_tokens).toBe(2500);
    expect(enriched.token_usage?.output_tokens).toBe(1200);

    // Files merged
    expect(enriched.files_touched).toContain("src/existing.ts");
    expect(enriched.files_touched).toContain("src/enriched.ts");
    expect(enriched.files_touched).toContain("package.json");

    // Metadata enriched
    expect(enriched.metadata?.turnId).toBe("turn-42");
    expect(enriched.metadata?.stepCount).toBe(15);
  });
});

// =================================================================
// Test Suite 5: Integration config wiring
// =================================================================

describe("Integration config wiring via boot-v2", () => {
  it("setIntegrationConfigs is reflected in agent MCP servers and prompt", async () => {
    const testDir = createTestDir();

    const system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(testDir, "inbox.sock") },
      minimem: { enabled: true, dir: "/custom/minimem", provider: "openai" },
      skilltree: { enabled: true, basePath: "/custom/skills" },
      sessionlog: { enabled: true, sync: "metrics" },
    });

    clearCaptures();
    await system.agentManager.spawn({ task: "Config wiring test", role: "worker" });
    await settle();

    // minimem should be registered with custom dir and provider
    const opts = lastOpts();
    const mcpServers = opts?.mcpServers ?? [];
    const minimemServer = mcpServers.find((s: any) => s.name === "minimem");

    expect(minimemServer).toBeDefined();
    expect(minimemServer.args).toContain("/custom/minimem");
    expect(minimemServer.args).toContain("openai");

    // Context should include integration sections
    const systemPrompt: string = opts?.systemPrompt ?? "";
    expect(systemPrompt).toContain("## Swarm Capabilities");
    expect(systemPrompt).toContain("### Memory");
    expect(systemPrompt).toContain("### Per-Role Skills");

    try { await system.shutdown(); } catch { /* ignore */ }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("boots cleanly with no integrations configured", async () => {
    const testDir = createTestDir();

    const system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(testDir, "inbox.sock") },
    });

    clearCaptures();
    await system.agentManager.spawn({ task: "No integrations test", role: "worker" });
    await settle();

    const opts = lastOpts();
    const mcpServers = opts?.mcpServers ?? [];

    // No minimem server
    expect(mcpServers.find((s: any) => s.name === "minimem")).toBeUndefined();

    // System prompt should not have integration-specific sections
    const systemPrompt: string = opts?.systemPrompt ?? "";
    expect(systemPrompt).not.toContain("### Memory");

    try { await system.shutdown(); } catch { /* ignore */ }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("mesh config passes through without boot errors", async () => {
    const testDir = createTestDir();

    // Boot with mesh enabled — sidecar will fail to connect (expected graceful degradation)
    const system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(testDir, "inbox.sock") },
      mesh: { enabled: true, peerId: "test-peer-123" },
      map: {
        enabled: true,
        server: "ws://127.0.0.1:1",
        reconnection: { enabled: false },
        reconnectIntervalMs: 999999,
      },
    });

    // System should boot without errors even with unreachable hub
    expect(system.agentManager).toBeDefined();

    try { await system.shutdown(); } catch { /* ignore */ }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("MAP server URL is reflected in agent context when mapServer enabled", async () => {
    const testDir = createTestDir();

    const system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(testDir, "inbox.sock") },
      mapServer: {
        enabled: true,
        port: 0,
        host: "127.0.0.1",
      },
      sessionlog: { enabled: true, sync: "full" },
    });

    clearCaptures();
    await system.agentManager.spawn({ task: "MAP context test", role: "worker" });
    await settle();

    const systemPrompt: string = lastOpts()?.systemPrompt ?? "";

    // MAP server URL was set, so observability section should appear
    expect(systemPrompt).toContain("### External Observability");
    expect(systemPrompt).toContain("MAP: connected");
    expect(systemPrompt).toContain("level: full");

    try { await system.shutdown(); } catch { /* ignore */ }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
