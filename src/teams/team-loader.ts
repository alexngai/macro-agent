/**
 * Team Template Loader
 *
 * Reads .macro-agent/teams/<name>/ directories, parses team.yaml,
 * resolves role inheritance, loads prompts, and validates communication.
 *
 * @module teams/team-loader
 */

import * as fs from "fs";
import * as path from "path";
import yaml from "js-yaml";
import type { RoleRegistry, RoleDefinition, Capability } from "../roles/types.js";
import {
  TeamLoadError,
  type TeamManifest,
  type TeamTopology,
  type TeamCommunication,
  type MacroAgentExtensions,
  type TeamRoleDefinition,
  type ResolvedTeamRole,
  type McpServerEntry,
} from "./types.js";

// =============================================================================
// Constants
// =============================================================================

const TEAMS_DIR = ".macro-agent/teams";
const MANIFEST_FILE = "team.yaml";
const ROLES_DIR = "roles";
const PROMPTS_DIR = "prompts";
const TOOLS_DIR = "tools";
const MCP_SERVERS_FILE = "mcp-servers.json";

// =============================================================================
// TeamLoader
// =============================================================================

/**
 * Load a team template from disk and resolve all references.
 *
 * @param teamName - Team name (directory name under .macro-agent/teams/)
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
  const teamDir = path.join(root, TEAMS_DIR, teamName);

  // 1. Check team directory exists
  if (!fs.existsSync(teamDir)) {
    throw new TeamLoadError(
      `Team directory not found: ${teamDir}`,
      "MANIFEST_NOT_FOUND",
      teamName
    );
  }

  // 2. Read and parse team.yaml
  const manifestPath = path.join(teamDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw new TeamLoadError(
      `Team manifest not found: ${manifestPath}`,
      "MANIFEST_NOT_FOUND",
      teamName
    );
  }

  const raw = fs.readFileSync(manifestPath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(raw) as Record<string, unknown>;
  } catch (err) {
    throw new TeamLoadError(
      `Failed to parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_MANIFEST",
      teamName
    );
  }

  // 3. Validate required fields
  validateManifest(parsed, teamName);

  const topology = parsed.topology as TeamTopology;
  const communication = (parsed.communication ?? {}) as TeamCommunication;
  const macroAgent = (parsed.macro_agent ?? {}) as MacroAgentExtensions;
  const roleNames = parsed.roles as string[];

  // 4. Resolve roles
  const resolvedRoles = new Map<string, ResolvedTeamRole>();
  const spawnRules = topology.spawn_rules ?? {};

  for (const roleName of roleNames) {
    const resolved = resolveTeamRole(
      roleName,
      teamDir,
      roleRegistry,
      spawnRules
    );
    resolvedRoles.set(roleName, resolved);
  }

  // 5. Load prompts
  const loadedPrompts = new Map<string, string>();

  // Load prompts from topology nodes
  const promptRefs = collectPromptRefs(topology, resolvedRoles);
  for (const promptPath of promptRefs) {
    const fullPath = path.join(teamDir, promptPath);
    if (!fs.existsSync(fullPath)) {
      throw new TeamLoadError(
        `Prompt file not found: ${fullPath}`,
        "PROMPT_NOT_FOUND",
        teamName
      );
    }
    loadedPrompts.set(promptPath, fs.readFileSync(fullPath, "utf-8"));
  }

  // 6. Load MCP server configs
  const mcpServers = loadMcpServers(teamDir);

  // 7. Validate communication topology
  validateCommunication(communication, roleNames, teamName);

  return {
    name: parsed.name as string,
    description: (parsed.description as string) ?? "",
    version: (parsed.version as number) ?? 1,
    roles: roleNames,
    topology,
    communication,
    macro_agent: macroAgent,
    _resolvedRoles: resolvedRoles,
    _loadedPrompts: loadedPrompts,
    _mcpServers: mcpServers,
  };
}

// =============================================================================
// Manifest Validation
// =============================================================================

function validateManifest(
  parsed: Record<string, unknown>,
  teamName: string
): void {
  if (!parsed || typeof parsed !== "object") {
    throw new TeamLoadError(
      "Team manifest must be a YAML object",
      "INVALID_MANIFEST",
      teamName
    );
  }

  if (!parsed.name || typeof parsed.name !== "string") {
    throw new TeamLoadError(
      "Team manifest requires a 'name' string field",
      "INVALID_MANIFEST",
      teamName
    );
  }

  if (!Array.isArray(parsed.roles) || parsed.roles.length === 0) {
    throw new TeamLoadError(
      "Team manifest requires a non-empty 'roles' array",
      "INVALID_MANIFEST",
      teamName
    );
  }

  if (!parsed.topology || typeof parsed.topology !== "object") {
    throw new TeamLoadError(
      "Team manifest requires a 'topology' object",
      "INVALID_MANIFEST",
      teamName
    );
  }

  const topology = parsed.topology as Record<string, unknown>;
  if (!topology.root || typeof topology.root !== "object") {
    throw new TeamLoadError(
      "Team topology requires a 'root' object",
      "INVALID_MANIFEST",
      teamName
    );
  }
}

// =============================================================================
// Role Resolution
// =============================================================================

/**
 * Resolve a single team role: load YAML if present, resolve extends,
 * compute capabilities, translate spawn rules.
 */
function resolveTeamRole(
  roleName: string,
  teamDir: string,
  roleRegistry: RoleRegistry,
  spawnRules: Record<string, string[]>
): ResolvedTeamRole {
  // Try to load role YAML from team directory
  const roleFilePath = path.join(teamDir, ROLES_DIR, `${roleName}.yaml`);
  let teamRoleDef: TeamRoleDefinition | null = null;

  if (fs.existsSync(roleFilePath)) {
    const raw = fs.readFileSync(roleFilePath, "utf-8");
    try {
      teamRoleDef = yaml.load(raw) as TeamRoleDefinition;
    } catch (err) {
      throw new TeamLoadError(
        `Failed to parse role file ${roleFilePath}: ${err instanceof Error ? err.message : String(err)}`,
        "INVALID_ROLE",
        roleName
      );
    }
  }

  // Determine base role
  const baseRoleName = teamRoleDef?.extends ?? roleName;
  let parentRole: RoleDefinition;
  try {
    parentRole = roleRegistry.resolveRole(baseRoleName);
  } catch {
    throw new TeamLoadError(
      `Base role '${baseRoleName}' not found for team role '${roleName}'`,
      "ROLE_NOT_FOUND",
      roleName
    );
  }

  // Compute capabilities
  let capabilities: Capability[];
  if (teamRoleDef?.capabilities) {
    // Full replacement
    capabilities = teamRoleDef.capabilities as Capability[];
  } else if (teamRoleDef?.capabilities_add || teamRoleDef?.capabilities_remove) {
    // Additive/subtractive
    const base = new Set(parentRole.capabilities);
    for (const cap of teamRoleDef.capabilities_add ?? []) {
      base.add(cap as Capability);
    }
    for (const cap of teamRoleDef.capabilities_remove ?? []) {
      base.delete(cap as Capability);
    }
    capabilities = Array.from(base);
  } else {
    // Inherit parent capabilities
    capabilities = [...parentRole.capabilities];
  }

  // Translate spawn_rules into capability additions (RD3)
  const allowedSpawns = spawnRules[roleName];
  if (allowedSpawns) {
    for (const targetRole of allowedSpawns) {
      const spawnCap = `agent.spawn.${targetRole}` as Capability;
      if (!capabilities.includes(spawnCap)) {
        capabilities.push(spawnCap);
      }
    }
  }

  // Build the resolved RoleDefinition for registry
  const roleDefinition: RoleDefinition = {
    name: roleName,
    displayName: teamRoleDef?.display_name ?? parentRole.displayName,
    description: teamRoleDef?.description ?? parentRole.description,
    capabilities,
    workspace: teamRoleDef?.macro_agent?.workspace
      ? {
          type: (teamRoleDef.macro_agent.workspace.type ?? "own") as "own" | "shared" | "mount" | "none",
          branchPattern: teamRoleDef.macro_agent.workspace.branch_pattern,
          cleanupOnTerminate: teamRoleDef.macro_agent.workspace.cleanup_on_terminate,
        }
      : parentRole.workspace,
    lifecycle: teamRoleDef?.macro_agent?.lifecycle
      ? {
          type: (teamRoleDef.macro_agent.lifecycle.type ?? "ephemeral") as "ephemeral" | "persistent" | "daemon" | "event-driven",
          cascadeTerminate: teamRoleDef.macro_agent.lifecycle.cascade_terminate,
          selfCleanup: teamRoleDef.macro_agent.lifecycle.self_cleanup,
          taskBound: teamRoleDef.macro_agent.lifecycle.task_bound,
          parentBound: teamRoleDef.macro_agent.lifecycle.parent_bound,
          maxDurationMs: teamRoleDef.macro_agent.lifecycle.max_duration_ms,
        }
      : parentRole.lifecycle,
    tools: parentRole.tools,
    protocol: parentRole.protocol,
    permissions: parentRole.permissions,
    extends: teamRoleDef?.extends,
    systemPrompt: parentRole.systemPrompt,
  };

  return {
    name: roleName,
    baseRole: baseRoleName,
    capabilities,
    prompt: teamRoleDef?.prompt,
    roleDefinition,
  };
}

// =============================================================================
// Prompt Collection
// =============================================================================

/**
 * Collect all prompt file paths referenced by topology and roles.
 */
function collectPromptRefs(
  topology: TeamTopology,
  resolvedRoles: Map<string, ResolvedTeamRole>
): Set<string> {
  const refs = new Set<string>();

  // From topology nodes
  if (topology.root.prompt) refs.add(topology.root.prompt);
  for (const companion of topology.companions ?? []) {
    if (companion.prompt) refs.add(companion.prompt);
  }

  // From role definitions
  for (const resolved of resolvedRoles.values()) {
    if (resolved.prompt) refs.add(resolved.prompt);
  }

  return refs;
}

// =============================================================================
// MCP Server Loading
// =============================================================================

/**
 * Load tools/mcp-servers.json if it exists.
 * Returns a map of role name → MCP server entries.
 */
function loadMcpServers(
  teamDir: string
): Map<string, McpServerEntry[]> {
  const result = new Map<string, McpServerEntry[]>();
  const mcpPath = path.join(teamDir, TOOLS_DIR, MCP_SERVERS_FILE);

  if (!fs.existsSync(mcpPath)) {
    return result;
  }

  const raw = fs.readFileSync(mcpPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<
    string,
    { servers: McpServerEntry[] }
  >;

  for (const [roleName, config] of Object.entries(parsed)) {
    if (config.servers && Array.isArray(config.servers)) {
      result.set(roleName, config.servers);
    }
  }

  return result;
}

// =============================================================================
// Communication Validation
// =============================================================================

/**
 * Validate communication topology references.
 */
function validateCommunication(
  communication: TeamCommunication,
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
