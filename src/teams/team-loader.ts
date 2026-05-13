/**
 * Team Template Loader
 *
 * Thin wrapper around openteams TemplateLoader that maps the result
 * into macro-agent's TeamManifest format with enforcement-enriched roles.
 *
 * @module teams/team-loader
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { TemplateLoader } from "openteams";
import type {
  ResolvedRole,
  TeamManifest as OpenTeamsManifest,
} from "openteams";
import type { RoleRegistry, RoleDefinition, Capability } from "../roles/types.js";
import {
  TeamLoadError,
  type TeamManifest,
  type TeamRoleMacroAgent,
  type MacroAgentExtensions,
  type ResolvedTeamRole,
  type CommunicationConfig,
} from "./types.js";

// =============================================================================
// Constants
// =============================================================================

const TEAMS_DIR = ".multiagent/teams";

// Bundled team templates shipped with the macro-agent package. Used as a
// fallback when a team name isn't present in the user's `.multiagent/teams/`
// — so a fresh project can `startTeam('self-driving', cwd)` without first
// running the seed step. User-local copies always win when present.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const BUNDLED_TEAMS_DIR = path.join(PACKAGE_ROOT, "templates", "teams");

// =============================================================================
// TeamLoader
// =============================================================================

/**
 * Load a team template from disk and resolve all references.
 *
 * Delegates to openteams TemplateLoader for YAML parsing, role resolution,
 * prompt loading, and MCP server config. Enriches the result with macro-agent
 * specific enforcement (workspace, lifecycle, spawn rules).
 *
 * @param teamName - Team name (directory name under .multiagent/teams/)
 * @param roleRegistry - Role registry for resolving extends chains
 * @param basePath - Project root (default: process.cwd())
 * @returns Fully resolved TeamManifest
 */
export async function loadTeam(
  teamName: string,
  roleRegistry: RoleRegistry,
  basePath?: string
): Promise<TeamManifest> {
  const root = basePath ?? process.cwd();
  const userTeamDir = path.join(root, TEAMS_DIR, teamName);
  // Prefer a user-customised template; fall back to the bundled default
  // shipped under `<package>/templates/teams/<name>/`. This lets fresh
  // projects use built-in teams without an explicit seed step, while
  // still honouring per-project overrides.
  const bundledTeamDir = path.join(BUNDLED_TEAMS_DIR, teamName);
  const teamDir = fs.existsSync(userTeamDir) ? userTeamDir : bundledTeamDir;

  // 1. Load via openteams TemplateLoader with hooks
  let template;
  try {
    template = await TemplateLoader.loadAsync(teamDir, {
      resolveExternalRole: (name) => mapRegistryRole(roleRegistry, name),
      postProcessRole: (role, manifest) =>
        enrichRoleWithSpawnRules(role, manifest),
    });
  } catch (err) {
    throw mapToTeamLoadError(err, teamName, teamDir);
  }

  return finalizeTemplate(template, teamName, roleRegistry);
}

/**
 * Load a team template from in-memory content (no filesystem).
 *
 * Wire-delivery counterpart to {@link loadTeam}: instead of reading
 * `team.yaml` + `roles/*.yaml` + `prompts/*` from disk, hydrate via
 * `TemplateLoader.fromObject` from a structured snapshot. Used by hosts
 * that ship the team config inline at boot — most prominently OpenHive's
 * spawn manager packing `bootstrap.openteams.team_content` into the
 * `OPENSWARM_BOOTSTRAP_TOKEN` env var.
 *
 * The result is structurally identical to `loadTeam`'s — same macro-
 * agent enrichment, same validation, same downstream contract.
 *
 * @param teamName - Logical team name (used for error messages + the
 *   returned manifest's `name` when the inlined manifest doesn't carry
 *   one of its own).
 * @param content - Inline team content. Same shape as openteams's
 *   `TemplateLoader.fromObject` input.
 * @param roleRegistry - Role registry for resolving extends chains.
 */
export async function loadTeamFromContent(
  teamName: string,
  content: {
    manifest: OpenTeamsManifest;
    roles?: Record<string, RoleDefinition>;
    loadouts?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  },
  roleRegistry: RoleRegistry,
): Promise<TeamManifest> {
  // openteams's `fromObject` was added after the v0.3.0 type bundle that
  // macro-agent's package.json pins. At runtime the host's `node_modules`
  // typically resolves openteams to a newer source (e.g. OpenHive uses the
  // workspace symlink to references/openteams), so the call works — we
  // just lose static typing here. Cast around the missing type until the
  // pinned version is bumped.
  // fromObject is synchronous in openteams source; we cast through unknown
  // because the pinned openteams version's type bundle doesn't yet export
  // the static. Runtime resolution via the host's workspace gives us the
  // version that does have it.
  const fromObject = (
    TemplateLoader as unknown as {
      fromObject?: (
        c: unknown,
        opts: unknown,
      ) => Awaited<ReturnType<typeof TemplateLoader.loadAsync>>;
    }
  ).fromObject;
  if (!fromObject) {
    throw mapToTeamLoadError(
      new Error(
        'openteams TemplateLoader.fromObject is unavailable — runtime openteams must be ≥ the version that exports `fromObject`',
      ),
      teamName,
      `<inline:${teamName}>`,
    );
  }
  let template;
  try {
    template = fromObject(content as never, {
      resolveExternalRole: (name: string) => mapRegistryRole(roleRegistry, name),
      postProcessRole: (
        role: ResolvedRole,
        manifest: OpenTeamsManifest,
      ) => enrichRoleWithSpawnRules(role, manifest),
    });
  } catch (err) {
    throw mapToTeamLoadError(err, teamName, `<inline:${teamName}>`);
  }
  return finalizeTemplate(template, teamName, roleRegistry);
}

/**
 * Shared post-load processing applied to whatever `TemplateLoader`
 * (sync or async, disk or in-memory) produces. Builds the enrichment-
 * enriched role map, assembles the multi-file prompt index, validates
 * communication, and returns the macro-agent `TeamManifest` shape.
 */
function finalizeTemplate(
  // Awaited form of `loadAsync` — same `ResolvedTemplate` shape that
  // `fromObject` returns (we just can't name it via `typeof
  // TemplateLoader.fromObject` until the pinned openteams version exports
  // the static).
  template: Awaited<ReturnType<typeof TemplateLoader.loadAsync>>,
  teamName: string,
  roleRegistry: RoleRegistry,
): TeamManifest {
  const manifest = template.manifest;
  const communication = (manifest.communication ?? {}) as CommunicationConfig;
  const macroAgent = parseMacroAgentExtensions(
    manifest.macro_agent as Record<string, unknown> | undefined,
  );

  // 2. Build enforcement-enriched roles
  const resolvedRoles = new Map<string, ResolvedTeamRole>();
  for (const [roleName, openteamsRole] of template.roles) {
    resolvedRoles.set(
      roleName,
      buildResolvedTeamRole(roleName, openteamsRole, roleRegistry)
    );
  }

  // 3. Build loaded prompts map (backward compat: path → assembled content)
  //    Assembles multi-file prompts (primary + additional sections) into a single
  //    string so the runtime can use it transparently.
  const loadedPrompts = new Map<string, string>();
  for (const [roleName, resolvedPrompts] of template.prompts) {
    if (!resolvedPrompts.primary) continue;
    const role = template.roles.get(roleName);

    // Assemble full prompt: primary + additional sections
    let fullPrompt = resolvedPrompts.primary;
    for (const section of resolvedPrompts.additional) {
      fullPrompt += `\n\n## ${section.name}\n\n${section.content}`;
    }

    // Store under role's promptFile key (used by getPromptForRole)
    if (role?.promptFile) {
      loadedPrompts.set(role.promptFile, fullPrompt);
    }

    // Store under topology node prompt keys (used by getPromptForTopologyNode)
    if (manifest.topology.root.role === roleName && manifest.topology.root.prompt) {
      loadedPrompts.set(manifest.topology.root.prompt, fullPrompt);
    }
    for (const comp of manifest.topology.companions ?? []) {
      if (comp.role === roleName && comp.prompt) {
        loadedPrompts.set(comp.prompt, fullPrompt);
      }
    }

    // Convention fallback key
    if (!role?.promptFile) {
      loadedPrompts.set(`prompts/${roleName}.md`, fullPrompt);
    }
  }

  // 4. Validate communication topology
  validateCommunication(communication, manifest.roles, teamName);

  return {
    name: manifest.name,
    description: (manifest.description as string) ?? "",
    version: manifest.version ?? 1,
    roles: manifest.roles,
    topology: manifest.topology,
    communication,
    macro_agent: macroAgent,
    _resolvedRoles: resolvedRoles,
    _loadedPrompts: loadedPrompts,
    _mcpServers: template.mcpServers,
  };
}

// =============================================================================
// Hook: Map RoleRegistry → openteams ResolvedRole
// =============================================================================

/**
 * Convert a macro-agent RoleRegistry entry to an openteams ResolvedRole.
 * Used as the resolveExternalRole hook for TemplateLoader.
 */
function mapRegistryRole(
  roleRegistry: RoleRegistry,
  name: string
): ResolvedRole | null {
  try {
    const rd = roleRegistry.resolveRole(name);
    return {
      name: rd.name,
      displayName: rd.displayName ?? rd.name,
      description: rd.description ?? `Role: ${rd.name}`,
      capabilities: [...rd.capabilities],
      raw: { name: rd.name, capabilities: [...rd.capabilities] },
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Hook: Enrich roles with spawn_rules capabilities
// =============================================================================

/**
 * Translate team topology spawn_rules into agent.spawn.* capabilities.
 * Used as the postProcessRole hook for TemplateLoader.
 */
function enrichRoleWithSpawnRules(
  role: ResolvedRole,
  manifest: OpenTeamsManifest
): ResolvedRole {
  const spawnRules = manifest.topology.spawn_rules;
  if (!spawnRules) return role;

  const allowedSpawns = spawnRules[role.name];
  if (!allowedSpawns || allowedSpawns.length === 0) return role;

  const capabilities = [...role.capabilities];
  for (const target of allowedSpawns) {
    const cap = `agent.spawn.${target}`;
    if (!capabilities.includes(cap)) {
      capabilities.push(cap);
    }
  }

  return { ...role, capabilities };
}

// =============================================================================
// Build ResolvedTeamRole
// =============================================================================

/**
 * Build a macro-agent ResolvedTeamRole from an openteams ResolvedRole.
 * Enriches with enforcement-specific fields (workspace, lifecycle, tools, etc.)
 * from the parent RoleDefinition and macro_agent overrides from role YAML.
 */
function buildResolvedTeamRole(
  roleName: string,
  openteamsRole: ResolvedRole,
  roleRegistry: RoleRegistry
): ResolvedTeamRole {
  const baseRoleName = openteamsRole.extends ?? roleName;

  let parentRole: RoleDefinition;
  try {
    parentRole = roleRegistry.resolveRole(baseRoleName);
  } catch {
    // Fallback for roles without a registry parent
    parentRole = {
      name: baseRoleName,
      displayName: baseRoleName,
      description: `Role: ${baseRoleName}`,
      capabilities: [],
    } as RoleDefinition;
  }

  const macroAgent = openteamsRole.raw.macro_agent as TeamRoleMacroAgent | undefined;
  let capabilities = openteamsRole.capabilities as Capability[];

  // If the role YAML had no capability specification (no capabilities,
  // capabilities_add, or capabilities_remove), openteams leaves capabilities
  // empty. In that case, inherit all parent capabilities. Spawn-rule enrichment
  // may have already added some caps, so merge with parent.
  const hasExplicitCapabilitySpec = openteamsRole.raw.capabilities !== undefined;
  if (!hasExplicitCapabilitySpec && parentRole.capabilities.length > 0) {
    const merged = new Set<string>([...parentRole.capabilities, ...capabilities]);
    capabilities = [...merged] as Capability[];
  }

  const roleDefinition: RoleDefinition = {
    name: roleName,
    displayName: openteamsRole.displayName,
    description: openteamsRole.description,
    capabilities,
    workspace: macroAgent?.workspace
      ? {
          type: (macroAgent.workspace.type ?? "own") as "own" | "shared" | "mount" | "none",
          branchPattern: macroAgent.workspace.branch_pattern,
          cleanupOnTerminate: macroAgent.workspace.cleanup_on_terminate,
        }
      : parentRole.workspace,
    lifecycle: macroAgent?.lifecycle
      ? {
          type: (macroAgent.lifecycle.type ?? "ephemeral") as "ephemeral" | "persistent" | "daemon" | "event-driven",
          cascadeTerminate: macroAgent.lifecycle.cascade_terminate,
          selfCleanup: macroAgent.lifecycle.self_cleanup,
          taskBound: macroAgent.lifecycle.task_bound,
          parentBound: macroAgent.lifecycle.parent_bound,
          maxDurationMs: macroAgent.lifecycle.max_duration_ms,
        }
      : parentRole.lifecycle,
    tools: parentRole.tools,
    protocol: parentRole.protocol,
    permissions: parentRole.permissions,
    extends: openteamsRole.extends,
    systemPrompt: parentRole.systemPrompt,
  };

  return {
    name: roleName,
    baseRole: baseRoleName,
    capabilities,
    prompt: openteamsRole.promptFile,
    roleDefinition,
  };
}

// =============================================================================
// Parse macro_agent extensions
// =============================================================================

/**
 * Parse the opaque macro_agent field from the manifest into typed extensions.
 */
function parseMacroAgentExtensions(
  raw: Record<string, unknown> | undefined
): MacroAgentExtensions {
  if (!raw) return {};
  return raw as MacroAgentExtensions;
}

// =============================================================================
// Error Mapping
// =============================================================================

/**
 * Map openteams loader errors to macro-agent TeamLoadError for backward compat.
 */
function mapToTeamLoadError(
  err: unknown,
  teamName: string,
  teamDir: string
): TeamLoadError {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes("not found") || message.includes("not exist")) {
    return new TeamLoadError(
      `Team directory or manifest not found: ${teamDir}`,
      "MANIFEST_NOT_FOUND",
      teamName
    );
  }

  if (message.includes("parse") || message.includes("YAML")) {
    return new TeamLoadError(
      `Failed to parse team manifest: ${message}`,
      "INVALID_MANIFEST",
      teamName
    );
  }

  if (message.includes("role") && message.includes("not in")) {
    return new TeamLoadError(
      message,
      "INVALID_MANIFEST",
      teamName
    );
  }

  if (message.includes("Circular")) {
    return new TeamLoadError(
      message,
      "INVALID_ROLE",
      teamName
    );
  }

  // Default: treat as invalid manifest
  return new TeamLoadError(
    `Failed to load team '${teamName}': ${message}`,
    "INVALID_MANIFEST",
    teamName
  );
}

// =============================================================================
// Communication Validation
// =============================================================================

/**
 * Validate communication topology references.
 */
function validateCommunication(
  communication: CommunicationConfig,
  roleNames: string[],
  teamName: string
): void {
  const channels = communication.channels ?? {};
  const channelNames = new Set(Object.keys(channels));
  const roleNameSet = new Set(roleNames);

  // Validate subscriptions reference existing channels and roles
  for (const [roleName, subs] of Object.entries(communication.subscriptions ?? {})) {
    if (!roleNameSet.has(roleName)) {
      throw new TeamLoadError(
        `Subscription references unknown role '${roleName}'`,
        "INVALID_COMMUNICATION",
        teamName
      );
    }
    for (const sub of subs) {
      if (!channelNames.has(sub.channel)) {
        throw new TeamLoadError(
          `Role '${roleName}' subscribes to unknown channel '${sub.channel}'`,
          "INVALID_COMMUNICATION",
          teamName
        );
      }
    }
  }

  // Validate emissions reference existing roles
  for (const roleName of Object.keys(communication.emissions ?? {})) {
    if (!roleNameSet.has(roleName)) {
      throw new TeamLoadError(
        `Emissions references unknown role '${roleName}'`,
        "INVALID_COMMUNICATION",
        teamName
      );
    }
  }

  // Validate peer connections
  for (const peer of communication.routing?.peers ?? []) {
    if (!roleNameSet.has(peer.from)) {
      throw new TeamLoadError(
        `Peer connection references unknown role '${peer.from}'`,
        "INVALID_COMMUNICATION",
        teamName
      );
    }
    if (!roleNameSet.has(peer.to)) {
      throw new TeamLoadError(
        `Peer connection references unknown role '${peer.to}'`,
        "INVALID_COMMUNICATION",
        teamName
      );
    }
  }
}
