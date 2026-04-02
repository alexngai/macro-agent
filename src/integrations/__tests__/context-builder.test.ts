/**
 * Unit Tests for Capabilities Context Builder
 *
 * Tests `buildCapabilitiesContext()` which generates markdown describing
 * available swarmkit integrations for injection into agent system prompts.
 *
 * Run:
 *   npx vitest run src/integrations/__tests__/context-builder.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  buildCapabilitiesContext,
  type CapabilitiesConfig,
} from "../context-builder.js";

describe("buildCapabilitiesContext", () => {
  it("returns non-empty string with default sections even when no integrations enabled", () => {
    const result = buildCapabilitiesContext({});

    // Should still include the base sections (Task Management, Communication)
    expect(result).toContain("## Swarm Capabilities");
    expect(result).toContain("### Task Management");
    expect(result).toContain("### Communication");
  });

  it("does not include memory section when minimem disabled", () => {
    const result = buildCapabilitiesContext({
      minimem: { enabled: false },
    });

    expect(result).not.toContain("### Memory");
    expect(result).not.toContain("minimem");
  });

  it("includes memory section when minimem enabled", () => {
    const result = buildCapabilitiesContext({
      minimem: { enabled: true, status: "ready" },
    });

    expect(result).toContain("### Memory");
    expect(result).toContain("minimem MCP tools");
    expect(result).toContain("minimem__memory_search");
    expect(result).toContain("minimem__memory_get_details");
    expect(result).toContain("minimem__knowledge_search");
    expect(result).toContain("team-wide");
  });

  it("includes opentasks section when opentasks connected", () => {
    const result = buildCapabilitiesContext({
      opentasks: { enabled: true, status: "connected" },
    });

    expect(result).toContain("opentasks MCP tools");
    expect(result).toContain("opentasks__create_task");
    expect(result).toContain("opentasks__update_task");
    expect(result).toContain("opentasks__list_tasks");
  });

  it("does not include opentasks section when opentasks disabled", () => {
    const result = buildCapabilitiesContext({
      opentasks: { enabled: false },
    });

    expect(result).not.toContain("opentasks MCP tools");
    expect(result).not.toContain("opentasks__create_task");
  });

  it("includes inbox section when inbox enabled", () => {
    const result = buildCapabilitiesContext({
      inbox: { enabled: true },
    });

    expect(result).toContain("agent-inbox MCP tools");
    expect(result).toContain("agent-inbox__check_inbox");
    expect(result).toContain("agent-inbox__send_message");
    expect(result).toContain("agent-inbox__read_thread");
    expect(result).toContain("agent-inbox__list_agents");
  });

  it("does not include inbox section when inbox disabled", () => {
    const result = buildCapabilitiesContext({
      inbox: { enabled: false },
    });

    expect(result).not.toContain("agent-inbox MCP tools");
  });

  it("includes MAP observability section when map enabled", () => {
    const result = buildCapabilitiesContext({
      map: { enabled: true, status: "connected" },
      sessionlog: { enabled: true, sync: "metrics" },
    });

    expect(result).toContain("### External Observability");
    expect(result).toContain("MAP: connected");
    expect(result).toContain("trajectory checkpoints synced to MAP");
  });

  it("includes MAP scope in output", () => {
    const result = buildCapabilitiesContext({
      map: { enabled: true, scope: "swarm:worker-1" },
    });

    expect(result).toContain("scope: swarm:worker-1");
  });

  it("uses default scope when map.scope not provided", () => {
    const result = buildCapabilitiesContext({
      map: { enabled: true },
    });

    expect(result).toContain("scope: default");
  });

  it("shows no observability when map disabled", () => {
    const result = buildCapabilitiesContext({
      map: { enabled: false },
    });

    expect(result).toContain("No external observability configured");
    expect(result).not.toContain("MAP: connected");
  });

  it("includes skills section when skilltree enabled", () => {
    const result = buildCapabilitiesContext({
      skilltree: { enabled: true, status: "ready" },
    });

    expect(result).toContain("### Per-Role Skills");
    expect(result).toContain("skill loadout");
  });

  it("does not include skills section when skilltree disabled", () => {
    const result = buildCapabilitiesContext({
      skilltree: { enabled: false },
    });

    expect(result).not.toContain("### Skills");
  });

  it("includes sessionlog info in MAP section when both enabled", () => {
    const result = buildCapabilitiesContext({
      map: { enabled: true },
      sessionlog: { enabled: true, sync: "metrics" },
    });

    expect(result).toContain("### External Observability");
    expect(result).toContain("level: metrics");
  });

  it("shows custom sync level for sessionlog", () => {
    const result = buildCapabilitiesContext({
      map: { enabled: true },
      sessionlog: { enabled: true, sync: "full" },
    });

    expect(result).toContain("level: full");
  });

  it("does not mention sessionlog when sessionlog disabled and map enabled", () => {
    const result = buildCapabilitiesContext({
      map: { enabled: true },
      sessionlog: { enabled: false },
    });

    expect(result).toContain("### External Observability");
    expect(result).not.toContain("level:");
  });

  it("combines all sections correctly when everything enabled", () => {
    const config: CapabilitiesConfig = {
      minimem: { enabled: true, status: "ready" },
      skilltree: { enabled: true, status: "ready" },
      sessionlog: { enabled: true, sync: "full" },
      mesh: { enabled: true },
      map: { enabled: true, scope: "swarm:test", status: "connected" },
      opentasks: { enabled: true, status: "connected" },
      inbox: { enabled: true },
    };

    const result = buildCapabilitiesContext(config);

    // All sections present
    expect(result).toContain("## Swarm Capabilities");
    expect(result).toContain("### Team Orchestration");
    expect(result).toContain("### Task Management");
    expect(result).toContain("### Communication");
    expect(result).toContain("### Memory");
    expect(result).toContain("### Per-Role Skills");
    expect(result).toContain("### External Observability");
    expect(result).toContain("opentasks MCP tools");
    expect(result).toContain("agent-inbox MCP tools");
    expect(result).toContain("minimem MCP tools");
    expect(result).toContain("swarm:test");
    expect(result).toContain("level: full");

    // Verify ordering: Task Management before Memory before Skills before Observability
    const taskIdx = result.indexOf("### Task Management");
    const commIdx = result.indexOf("### Communication");
    const memIdx = result.indexOf("### Memory");
    const skillIdx = result.indexOf("### Per-Role Skills");
    const obsIdx = result.indexOf("### External Observability");

    expect(taskIdx).toBeLessThan(commIdx);
    expect(commIdx).toBeLessThan(memIdx);
    expect(memIdx).toBeLessThan(skillIdx);
    expect(skillIdx).toBeLessThan(obsIdx);
  });

  it("starts with the capabilities header", () => {
    const result = buildCapabilitiesContext({
      minimem: { enabled: true },
    });

    expect(result.startsWith("## Swarm Capabilities")).toBe(true);
  });
});
