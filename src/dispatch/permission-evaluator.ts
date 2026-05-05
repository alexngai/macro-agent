/**
 * Permission Evaluator
 *
 * Pure function: given a tool call (name + input) and an overlay's
 * permission rules, decide whether to deny, allow, or pass-through.
 * Used by the `PreToolUse` hook installed at spawn time to enforce
 * dispatch-supplied loadout permissions on a running session.
 *
 * Rule format (matches Claude Agent SDK convention):
 *
 *     <ToolName>                  — match any call to this tool
 *     <ToolName>(<glob-pattern>)  — match calls whose primary input
 *                                    field matches the glob pattern
 *
 * The "primary input field" is tool-specific:
 *
 *   Bash         → input.command
 *   Read         → input.file_path
 *   Write        → input.file_path
 *   Edit         → input.file_path
 *   Grep         → input.pattern
 *   <other>      → no field-level match; rule must be bare `<ToolName>`
 *
 * Glob: `*` matches any sequence of characters (no path-segment
 * distinction). Other regex specials are escaped.
 *
 * Decision precedence:
 *
 *   1. If any rule in `deny` matches → 'deny'
 *   2. Else if any rule in `allow` matches → 'allow'
 *   3. Else → 'pass-through' (let the session's static rules decide)
 *
 * `ask` rules are not evaluated here — the consumer is expected to
 * collapse `ask` to either `allow` or `deny` before setting the
 * overlay (via `collapsePermissionsForAutonomous` based on the
 * spawn's `fullAutonomous` flag). The evaluator sees only collapsed
 * `allow` and `deny` lists.
 *
 * @module dispatch/permission-evaluator
 */

import type { OverlayPermissions } from "./permission-overlay.js";

export interface PermissionDecision {
  decision: "allow" | "deny" | "pass-through";
  matchedRule?: string;
  matchedField?: string;
}

/**
 * Tool-name → primary input field name. Add entries as needed for
 * additional tools. Tools not listed have no field-level matching;
 * only bare `<ToolName>` rules apply.
 */
const PRIMARY_INPUT_FIELD: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  Grep: "pattern",
  Glob: "pattern",
  NotebookRead: "notebook_path",
  NotebookEdit: "notebook_path",
};

/**
 * Evaluate a single tool call against an overlay's permission rules.
 *
 * Returns `'pass-through'` (the default) when no rule matches — the
 * caller should fall back to the session's static permission rules
 * for the final decision.
 */
export function evaluatePermission(
  toolName: string,
  toolInput: unknown,
  overlay: OverlayPermissions,
): PermissionDecision {
  // Deny rules win over allow.
  for (const rule of overlay.deny ?? []) {
    const match = matchRule(rule, toolName, toolInput);
    if (match.matched) {
      return {
        decision: "deny",
        matchedRule: rule,
        ...(match.field ? { matchedField: match.field } : {}),
      };
    }
  }

  for (const rule of overlay.allow ?? []) {
    const match = matchRule(rule, toolName, toolInput);
    if (match.matched) {
      return {
        decision: "allow",
        matchedRule: rule,
        ...(match.field ? { matchedField: match.field } : {}),
      };
    }
  }

  return { decision: "pass-through" };
}

interface RuleMatch {
  matched: boolean;
  field?: string;
}

/**
 * Test a single rule against a tool call. Returns whether the rule
 * matched and which input field (if any) was tested.
 *
 * Exported only for testability; production callers should use
 * `evaluatePermission`.
 */
export function matchRule(
  rule: string,
  toolName: string,
  toolInput: unknown,
): RuleMatch {
  const parsed = parseRule(rule);
  if (!parsed) return { matched: false };
  if (parsed.toolName !== toolName) return { matched: false };

  // No pattern → any call to this tool matches.
  if (parsed.pattern === undefined) return { matched: true };

  // Empty pattern (`Bash()`) — also any call to this tool. Conservative.
  if (parsed.pattern === "") return { matched: true };

  const fieldName = PRIMARY_INPUT_FIELD[toolName];
  if (!fieldName) {
    // No primary field defined for this tool → can't match a pattern.
    // Pattern-bearing rules for unknown tools never match (skip).
    return { matched: false };
  }

  const fieldValue = readField(toolInput, fieldName);
  if (typeof fieldValue !== "string") {
    return { matched: false };
  }

  const re = globToRegex(parsed.pattern);
  return {
    matched: re.test(fieldValue),
    field: fieldName,
  };
}

interface ParsedRule {
  toolName: string;
  /** undefined → bare `<ToolName>` rule (no parentheses) */
  pattern?: string;
}

function parseRule(rule: string): ParsedRule | null {
  // Tool names allow letters/digits/underscores AND hyphens — MCP tools use
  // hyphens in their server prefix (e.g., `mcp__agent-inbox__list_agents`).
  const m = rule.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\((.*)\))?$/);
  if (!m) return null;
  const [, toolName, pattern] = m;
  if (pattern === undefined) {
    return { toolName: toolName as string };
  }
  return { toolName: toolName as string, pattern };
}

function readField(input: unknown, field: string): unknown {
  if (!input || typeof input !== "object") return undefined;
  return (input as Record<string, unknown>)[field];
}

/**
 * Convert a Claude permission glob into a regex. Only `*` is special;
 * everything else is treated as a literal. The result is anchored
 * (`^...$`) for whole-string matching.
 */
function globToRegex(pattern: string): RegExp {
  let out = "^";
  for (const ch of pattern) {
    if (ch === "*") {
      out += ".*";
    } else {
      // Escape regex specials.
      out += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out);
}
