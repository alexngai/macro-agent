/**
 * MAP Server E2E Tests
 *
 * Boots macro-agent with MAP server enabled, connects via MAP SDK
 * ClientConnection, and verifies agent discovery and subscriptions.
 *
 * Run:
 *   npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/map-server.e2e.test.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";
import { ClientConnection } from "@multi-agent-protocol/sdk";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "map-server-e2e-"));

describe("MAP Server E2E", () => {
  let system: MacroAgentSystemV2;
  let client: ClientConnection | null = null;

  afterAll(async () => {
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
    }
    if (system) {
      await system.shutdown();
    }
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("boots with MAP server and accepts connections", async () => {
    system = await bootV2({
      baseDir: TEST_DIR,
      cwd: TEST_DIR,
      defaultPermissionMode: "auto-approve",
      mapServer: {
        enabled: true,
        port: 0, // Let OS pick a port
        host: "127.0.0.1",
      },
    });

    expect(system).toBeDefined();
    expect(system.mapServerInstance).toBeDefined();

    const url = system.mapServerInstance!.getUrl();
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/map$/);
  }, 15000);

  it("accepts MAP client connection", async () => {
    const url = system.mapServerInstance!.getUrl();

    client = await ClientConnection.connect(url, {
      name: "E2E Test Client",
      capabilities: {
        observation: { canObserve: true, canQuery: true },
        messaging: { canSend: true, canReceive: true },
        lifecycle: { canSpawn: true, canStop: true },
      },
    });

    expect(client).toBeDefined();
    expect(client.isConnected).toBe(true);
    expect(system.mapServerInstance!.getConnectionCount()).toBe(1);
  }, 10000);

  it("lists agents via MAP protocol", async () => {
    const result = await client!.listAgents();

    // No agents spawned yet, should be empty
    expect(result).toBeDefined();
    expect(result.agents).toBeDefined();
    expect(Array.isArray(result.agents)).toBe(true);
  });

  it("calls extension methods", async () => {
    // Call _macro/task/list extension
    const result = await client!.callExtension("_macro/task/list", {});
    expect(result).toBeDefined();
    expect((result as any).tasks).toBeDefined();
  });

  it("calls ping extension", async () => {
    const result = await client!.callExtension("ping", {});
    expect((result as any).pong).toBe(true);
  });

  it("disconnects cleanly", async () => {
    await client!.disconnect();
    client = null;

    // Give a moment for disconnect to propagate
    await new Promise((r) => setTimeout(r, 100));

    expect(system.mapServerInstance!.getConnectionCount()).toBe(0);
  });

  it("shuts down cleanly", async () => {
    await system.shutdown();
    system = undefined!;
  });
});

describe("MAP Server E2E - disabled", () => {
  it("boots without MAP server when not configured", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-srv-disabled-"));
    const system = await bootV2({
      baseDir: dir,
      cwd: dir,
      defaultPermissionMode: "auto-approve",
    });

    expect(system.mapServerInstance).toBeUndefined();
    await system.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);
});
