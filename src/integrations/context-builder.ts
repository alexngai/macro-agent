/**
 * Capabilities Context Builder
 *
 * Builds markdown context describing available swarmkit integrations
 * for injection into agent system prompts. Matches cc-swarm's
 * `buildCapabilitiesContext()` pattern from `context-output.mjs`.
 *
 * @module integrations/context-builder
 */

export interface CapabilitiesConfig {
  /** Agent role (null = orchestrator/main, string = spawned agent) */
  role?: string | null;
  /** Team name for context */
  teamName?: string;
  minimem?: { enabled: boolean; status?: string };
  skilltree?: { enabled: boolean; status?: string; profile?: string };
  sessionlog?: { enabled: boolean; sync?: string };
  mesh?: { enabled: boolean };
  map?: { enabled: boolean; scope?: string; status?: string };
  opentasks?: { enabled: boolean; status?: string };
  inbox?: { enabled: boolean };
}

/**
 * Build capabilities markdown for injection into agent system prompt.
 * Matches cc-swarm's context format for consistency.
 */
export function buildCapabilitiesContext(
  config: CapabilitiesConfig,
): string {
  const isAgent = config.role != null;
  const lines: string[] = ["## Swarm Capabilities", ""];

  // ── Team Orchestration ─────────────────────────────────────────
  lines.push("### Team Orchestration");
  lines.push("");
  if (isAgent && config.teamName) {
    lines.push(
      `You are part of the **${config.teamName}** team. The orchestrator spawns and coordinates all teammates — spawned agents cannot spawn other agents.`,
    );
  } else {
    lines.push(
      "Use `/swarm` to launch a team from the configured topology, or `/swarm <template>` to pick a different one.",
    );
    lines.push(
      "Available templates: **gsd**, **bmad-method**, **bug-fix-pipeline**, **docs-sync**, **security-audit**, and more.",
    );
    lines.push(
      "Only the orchestrator spawns teammates — spawned agents cannot spawn other agents.",
    );
  }
  lines.push("");

  // ── Task Management ────────────────────────────────────────────
  lines.push("### Task Management");
  lines.push("");
  const otActive =
    config.opentasks?.enabled &&
    (config.opentasks.status === "connected" ||
      config.opentasks.status === "enabled");
  if (otActive) {
    lines.push("Use **opentasks MCP tools** for task management:");
    lines.push(
      "- `opentasks__create_task` — create tasks with metadata and links",
    );
    lines.push(
      "- `opentasks__update_task` — claim, update status, annotate",
    );
    lines.push(
      "- `opentasks__list_tasks` / `opentasks__query` — check progress, filter by status/assignee",
    );
    lines.push(
      "Cross-system task graph supports linking (`opentasks__link`) and annotations.",
    );
    lines.push(
      "Native Claude tasks are auto-federated into the graph via the claude-tasks provider.",
    );
  } else {
    lines.push("Use Claude Code native task tools:");
    lines.push("- `TaskCreate` — create tasks for the team");
    lines.push("- `TaskUpdate` — claim (set owner), update status");
    lines.push("- `TaskList` — check progress");
    lines.push(
      "Tasks are shared team-wide when agents use the same `team_name`.",
    );
  }
  lines.push("");

  // ── Communication ──────────────────────────────────────────────
  lines.push("### Communication");
  lines.push("");
  lines.push(
    'Use `SendMessage` for quick same-team agent-to-agent messaging:',
  );
  lines.push(
    '- Direct: `SendMessage(recipient="<agent-name>", content="...")`',
  );
  lines.push(
    "- Broadcast only when truly necessary (messages every teammate).",
  );
  lines.push("");
  if (config.inbox?.enabled) {
    lines.push(
      "**Structured messaging** via agent-inbox MCP tools (persistent, threaded, cross-system):",
    );
    lines.push(
      "- `agent-inbox__check_inbox(agentId)` — check for new messages (auto-marks as read)",
    );
    lines.push(
      '- `agent-inbox__send_message(to, body, from)` — send to an agent, or `agent@system` for federated',
    );
    lines.push(
      "- `agent-inbox__read_thread(threadTag)` — read full conversation thread",
    );
    lines.push(
      "- `agent-inbox__list_agents()` — see who is registered (local + federated)",
    );
    lines.push("");
    lines.push(
      "Use inbox for: cross-system messages, threaded conversations, delivery tracking, messaging external observers.",
    );
    lines.push(
      "Use `SendMessage` for: quick same-team coordination that doesn't need persistence.",
    );
  }
  if (config.mesh?.enabled) {
    lines.push(
      "Encrypted P2P transport via MeshPeer with agent discovery.",
    );
  }
  lines.push("");

  // ── Memory (minimem) ───────────────────────────────────────────
  if (
    config.minimem?.enabled &&
    config.minimem.status !== "disabled"
  ) {
    lines.push("### Memory");
    lines.push("");
    const ready =
      !config.minimem.status || config.minimem.status === "ready";
    if (ready) {
      lines.push(
        "Use **minimem MCP tools** for persistent, searchable team memory. Memory is shared team-wide.",
      );
      lines.push("");
      lines.push("**Searching (two-phase workflow):**");
      lines.push(
        "1. `minimem__memory_search(query)` — returns compact index (path, score, preview)",
      );
      lines.push(
        '2. `minimem__memory_get_details(results)` — fetch full text for relevant results',
      );
      lines.push(
        'Use `detail: "full"` for quick lookups. Filter by type: `type: "decision"` (decision, bugfix, feature, discovery, context, note).',
      );
      lines.push("");
      lines.push("**Knowledge search** (structured metadata):");
      lines.push(
        "- `minimem__knowledge_search(query, { domain, entities, minConfidence })` — filter by domain/entity/confidence",
      );
      lines.push(
        "- `minimem__knowledge_graph(nodeId, depth)` — traverse knowledge relationships",
      );
      lines.push(
        "- `minimem__knowledge_path(fromId, toId)` — find path between knowledge nodes",
      );
      lines.push("");
      if (!isAgent) {
        lines.push(
          "**Storing memories** (use filesystem tools to write Markdown):",
        );
        lines.push(
          "- `MEMORY.md` — important decisions and architecture notes",
        );
        lines.push(
          "- `memory/YYYY-MM-DD.md` — daily logs and session notes",
        );
        lines.push("- `memory/<topic>.md` — topic-specific files");
        lines.push("");
        lines.push(
          "Format entries with a type comment for filtered search:",
        );
        lines.push("```");
        lines.push("### YYYY-MM-DD HH:MM");
        lines.push("<!-- type: decision -->");
        lines.push("<content>");
        lines.push("```");
        lines.push(
          "Types: `decision`, `bugfix`, `feature`, `discovery`, `context`, `note`.",
        );
        lines.push(
          "Wrap secrets in `<private>` tags to exclude from indexing.",
        );
        lines.push("");
        lines.push(
          "**Team strategy**: Search memory before spawning agents for prior context on the user's goal. After team completion, store key decisions and outcomes.",
        );
      } else {
        lines.push(
          "**Before major work**: Search memory for relevant prior decisions and context.",
        );
        lines.push(
          "**After completing work**: Store key decisions and findings using filesystem tools — write to `memory/` files with `<!-- type: decision -->` tags.",
        );
      }
    } else {
      lines.push(
        `Memory: ${config.minimem.status} (minimem installed but not fully ready).`,
      );
    }
    lines.push("");
  }

  // ── Per-Role Skills (skill-tree) ───────────────────────────────
  if (
    config.skilltree?.enabled &&
    config.skilltree.status !== "disabled"
  ) {
    lines.push("### Per-Role Skills");
    lines.push("");
    if (isAgent) {
      lines.push(
        "Your **skill loadout** is embedded in the `## Skills` section below. These are versioned, reusable patterns selected for your role.",
      );
      if (config.skilltree.profile) {
        lines.push(
          `Your loadout was compiled from the **${config.skilltree.profile}** profile.`,
        );
      }
      lines.push(
        "Read and apply these skills to guide your approach — they represent proven patterns for your type of work.",
      );
    } else {
      lines.push(
        "Each spawned agent receives a **skill loadout** compiled per-role and embedded in their system prompt.",
      );
      lines.push(
        "Skills are versioned, reusable patterns from the skill-tree library, selected based on role profiles.",
      );
      lines.push("");
      lines.push(
        "Loadouts are configured via the `skilltree:` block in team.yaml, or auto-inferred from role names.",
      );
      lines.push(
        "Built-in profiles: **code-review**, **implementation**, **debugging**, **security**, **testing**, **refactoring**, **documentation**, **devops**.",
      );
    }
    lines.push("");
  }

  // ── External Observability (MAP) ───────────────────────────────
  lines.push("### External Observability");
  lines.push("");
  if (config.map?.enabled) {
    if (isAgent) {
      lines.push(
        "MAP is active — lifecycle and task events are emitted automatically. No direct interaction needed.",
      );
    } else {
      lines.push(
        `MAP: ${config.map.status ?? "connected"} (scope: ${config.map.scope ?? "default"})`,
      );
      lines.push(
        "Agent lifecycle and task events are emitted automatically. No direct MAP interaction needed.",
      );
    }
    if (config.sessionlog?.sync && config.sessionlog.sync !== "off") {
      lines.push(
        `Session trajectory checkpoints synced to MAP (level: ${config.sessionlog.sync}).`,
      );
    }
  } else {
    lines.push("No external observability configured.");
  }
  lines.push("");

  return lines.join("\n");
}
