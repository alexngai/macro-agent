/**
 * Skill-tree Integration
 *
 * Compiles per-role skill loadouts from skill-tree's SkillBank API.
 * Mirrors cc-swarm's `skilltree-client.mjs` but adapted for TypeScript
 * and macro-agent's AgentManager.setSkillLoadout() API.
 *
 * Gracefully degrades when skill-tree is not installed — all public
 * functions return null/empty rather than throwing.
 *
 * @module integrations/skilltree
 */

import { existsSync } from "node:fs";

// =============================================================================
// Types
// =============================================================================

/** Criteria for selecting skills into a loadout */
export interface LoadoutCriteria {
  profile?: string;
  tags?: string[];
  include?: string[];
  taskDescription?: string;
  maxSkills?: number;
}

/** Configuration for the skill-tree integration */
export interface SkillTreeConfig {
  enabled?: boolean;
  basePath?: string;
  defaultProfile?: string;
}

/** Result of compiling a role's loadout */
export interface CompiledLoadout {
  content: string;
  profile: string;
}

// =============================================================================
// Module cache
// =============================================================================

let _skillTreeModule: any = undefined;
let _loadAttempted = false;

/**
 * Dynamically load the skill-tree package.
 * Returns null if not available (graceful degradation).
 */
async function loadSkillTree(): Promise<any> {
  if (_loadAttempted) return _skillTreeModule ?? null;
  _loadAttempted = true;

  try {
    // @ts-ignore - optional peer dependency, may not be installed
    _skillTreeModule = await import("skill-tree");
    return _skillTreeModule;
  } catch {
    _skillTreeModule = null;
    return null;
  }
}

// Exposed for testing
export function _resetSkillTreeCache(): void {
  _skillTreeModule = undefined;
  _loadAttempted = false;
}

// =============================================================================
// Role → Profile mapping
// =============================================================================

const ROLE_PROFILE_MAP: Record<string, string> = {
  worker: "implementation",
  executor: "implementation",
  developer: "implementation",
  "quick-flow-dev": "implementation",
  debugger: "debugging",
  verifier: "testing",
  monitor: "testing",
  qa: "testing",
  "plan-checker": "code-review",
  "integration-checker": "code-review",
  integrator: "code-review",
  "tech-writer": "documentation",
  architect: "refactoring",
  coordinator: "implementation",
  "ux-designer": "documentation",
  "security-auditor": "security",
};

/**
 * Infer a skill-tree profile from a role name.
 * Returns empty string if no match found.
 */
export function inferProfileFromRole(roleName: string): string {
  // Direct match
  if (ROLE_PROFILE_MAP[roleName]) return ROLE_PROFILE_MAP[roleName];

  // Partial match (e.g., "senior-developer" matches "developer")
  for (const [pattern, profile] of Object.entries(ROLE_PROFILE_MAP)) {
    if (roleName.includes(pattern)) return profile;
  }

  return "";
}

// =============================================================================
// Compilation
// =============================================================================

/**
 * Compile a skill loadout for a single role.
 * Creates a SkillBank, sets the loadout from profile/criteria,
 * and returns the rendered markdown string.
 *
 * Returns null if skill-tree is not installed or compilation fails.
 */
export async function compileRoleLoadout(
  roleName: string,
  config: SkillTreeConfig = {},
): Promise<string | null> {
  const st = await loadSkillTree();
  if (!st?.createSkillBank) return null;

  const basePath = config.basePath ?? ".swarm/skill-tree";
  if (!existsSync(basePath)) return null;

  // Determine profile from config or inference
  const profile = config.defaultProfile || inferProfileFromRole(roleName);
  if (!profile) return null;

  try {
    const bank = st.createSkillBank({
      storage: { basePath },
    });
    await bank.initialize();

    try {
      const { server } = await bank.createServingLayer({
        outputFormat: "markdown",
      });

      try {
        await server.setLoadoutFromProfile(profile);
      } catch {
        // Profile not found — skip
        return null;
      }

      return server.renderSystemPrompt() as string;
    } finally {
      await bank.shutdown();
    }
  } catch {
    return null;
  }
}

/**
 * Compile skill loadouts for multiple roles.
 * Returns a Map of roleName → rendered markdown content.
 *
 * Roles that fail to compile are silently skipped.
 */
export async function compileAllRoleLoadouts(
  roles: string[],
  config: SkillTreeConfig = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const roleName of roles) {
    const content = await compileRoleLoadout(roleName, config);
    if (content) {
      result.set(roleName, content);
    }
  }

  return result;
}
