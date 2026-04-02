/**
 * MAP Sidecar E2E Tests
 *
 * Tests the full MAP sidecar flow with a real booted macro-agent system:
 *
 * 1. Boot macro-agent system with MAP sidecar enabled
 * 2. Verify sidecar connects (or gracefully degrades if no hub)
 * 3. Verify config wiring from bootV2() to sidecar
 * 4. Verify sidecar appears on the system object
 * 5. Verify clean shutdown
 *
 * Note: These tests do NOT require a running MAP hub. They test the
 * sidecar integration with bootV2 and graceful degradation when
 * the hub is unavailable.
 *
 * For full protocol testing with a real OpenHive hub, use the OpenHive
 * E2E test suite (src/__tests__/e2e/ in the openhive repo).
 *
 * Run:
 *   npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/map-sidecar.e2e.test.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "map-sidecar-e2e-"));

describe("MAP Sidecar E2E", () => {
  let system: MacroAgentSystemV2;

  afterAll(async () => {
    if (system) {
      await system.shutdown();
    }
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("boots with MAP sidecar config (graceful degradation when hub unavailable)", async () => {
    system = await bootV2({
      baseDir: TEST_DIR,
      cwd: TEST_DIR,
      defaultPermissionMode: "auto-approve",
      map: {
        enabled: true,
        server: "ws://127.0.0.1:1", // Unreachable — tests graceful degradation
        scope: "swarm:e2e-test",
        agentName: "e2e-sidecar",
        trajectorySyncLevel: "metrics",
        reconnection: { enabled: false },
        reconnectIntervalMs: 999999, // Don't retry during test
      },
    });

    // System should boot successfully even though MAP hub is unreachable
    expect(system).toBeDefined();
    expect(system.agentManager).toBeDefined();
    expect(system.agentStore).toBeDefined();

    // MAP sidecar should exist but be disconnected
    expect(system.mapSidecar).toBeDefined();
    expect(system.mapSidecar!.connected).toBe(false);
  }, 15000);

  it("reportCheckpoint returns null when disconnected", async () => {
    const result = await system.mapSidecar!.reportCheckpoint({
      id: "e2e-step-1",
      session_id: "e2e-session",
      agent: "e2e-sidecar",
      branch: "main",
      files_touched: ["test.ts"],
      checkpoints_count: 1,
      metadata: { project: "e2e-test" },
    });

    expect(result).toBeNull();
  });

  it("shuts down cleanly with sidecar", async () => {
    await system.shutdown();

    // Verify sidecar is disconnected after shutdown
    expect(system.mapSidecar!.connected).toBe(false);

    // Prevent double-shutdown in afterAll
    system = undefined!;
  });
});

describe("MAP Sidecar E2E - disabled", () => {
  let system: MacroAgentSystemV2;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-sidecar-disabled-"));

  afterAll(async () => {
    if (system) {
      await system.shutdown();
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("boots without MAP sidecar when disabled", async () => {
    system = await bootV2({
      baseDir: dir,
      cwd: dir,
      defaultPermissionMode: "auto-approve",
      // No map config — sidecar should not be created
    });

    expect(system).toBeDefined();
    expect(system.mapSidecar).toBeUndefined();
  }, 15000);

  it("boots without MAP sidecar when enabled but no server", async () => {
    await system.shutdown();

    system = await bootV2({
      baseDir: dir,
      cwd: dir,
      defaultPermissionMode: "auto-approve",
      map: {
        enabled: true,
        // No server URL — sidecar should not be created
      },
    });

    expect(system).toBeDefined();
    expect(system.mapSidecar).toBeUndefined();
  }, 15000);
});
