/**
 * Unit tests for `evaluatePermission` — the per-tool-call decision
 * function used by the PreToolUse hook to enforce dispatch-supplied
 * loadout permissions.
 */

import { describe, it, expect } from "vitest";
import {
  evaluatePermission,
  matchRule,
} from "../permission-evaluator.js";
import type { OverlayPermissions } from "../permission-overlay.js";

// ────────────────────────────────────────────────────────────────────
// matchRule — single-rule pattern matching
// ────────────────────────────────────────────────────────────────────

describe("matchRule", () => {
  it("matches a bare rule (no parens) against any tool input", () => {
    expect(matchRule("Bash", "Bash", { command: "anything" }).matched).toBe(true);
    expect(matchRule("Bash", "Bash", { command: "" }).matched).toBe(true);
    expect(matchRule("Read", "Bash", { command: "x" }).matched).toBe(false);
  });

  it("matches a rule with empty parens (Bash()) — same as bare", () => {
    expect(matchRule("Bash()", "Bash", { command: "echo hi" }).matched).toBe(true);
  });

  it("matches a literal pattern against the primary input field", () => {
    expect(
      matchRule("Bash(rm -rf /tmp/foo)", "Bash", { command: "rm -rf /tmp/foo" }).matched,
    ).toBe(true);
    expect(
      matchRule("Bash(rm -rf /tmp/foo)", "Bash", { command: "rm -rf /tmp/bar" }).matched,
    ).toBe(false);
  });

  it("treats `*` as glob (any sequence)", () => {
    expect(
      matchRule("Bash(echo perm-deny-test:*)", "Bash", {
        command: "echo perm-deny-test:hello-world",
      }).matched,
    ).toBe(true);
    expect(
      matchRule("Bash(echo perm-deny-test:*)", "Bash", {
        command: "echo perm-allow-test:other",
      }).matched,
    ).toBe(false);
  });

  it("treats multiple `*` as multiple globs", () => {
    expect(
      matchRule("Bash(*node *.js)", "Bash", { command: "/usr/bin/node script.js" }).matched,
    ).toBe(true);
    expect(
      matchRule("Bash(*node *.js)", "Bash", { command: "/usr/bin/python script.py" }).matched,
    ).toBe(false);
  });

  it("escapes regex specials in the pattern", () => {
    // `.` is a regex special; should match literally, not as "any char".
    expect(
      matchRule("Write(.env)", "Write", { file_path: ".env" }).matched,
    ).toBe(true);
    // Without escaping, `.` would match `aenv` too — but this MUST not match:
    expect(
      matchRule("Write(.env)", "Write", { file_path: "aenv" }).matched,
    ).toBe(false);
  });

  it("matches `**` like single `*` (no path-segment distinction)", () => {
    expect(
      matchRule("Read(**)", "Read", { file_path: "/etc/passwd" }).matched,
    ).toBe(true);
  });

  it("returns no match when the tool name doesn't match the rule's tool", () => {
    expect(matchRule("Bash(*)", "Read", { file_path: "/x" }).matched).toBe(false);
  });

  it("uses the right primary field per tool", () => {
    expect(matchRule("Read(/etc/*)", "Read", { file_path: "/etc/passwd" }).field).toBe("file_path");
    expect(matchRule("Bash(*)", "Bash", { command: "x" }).field).toBe("command");
    expect(matchRule("Grep(TODO)", "Grep", { pattern: "TODO" }).field).toBe("pattern");
  });

  it("returns no match for tools without a defined primary field when a pattern is given", () => {
    // FakeTool has no PRIMARY_INPUT_FIELD entry; pattern-bearing rules
    // can't match. Bare `FakeTool` rules WOULD still match (covered by
    // the first test).
    expect(matchRule("FakeTool(*)", "FakeTool", { x: "y" }).matched).toBe(false);
  });

  it("returns no match when the input doesn't have the expected field", () => {
    expect(matchRule("Bash(*)", "Bash", {}).matched).toBe(false);
    expect(matchRule("Bash(*)", "Bash", { command: 42 }).matched).toBe(false);
  });

  it("returns no match for malformed rules", () => {
    expect(matchRule("", "Bash", { command: "x" }).matched).toBe(false);
    expect(matchRule("(", "Bash", { command: "x" }).matched).toBe(false);
    expect(matchRule("Bash(unclosed", "Bash", { command: "x" }).matched).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// evaluatePermission — overlay-level decision precedence
// ────────────────────────────────────────────────────────────────────

describe("evaluatePermission", () => {
  it("returns 'pass-through' when overlay has no rules", () => {
    expect(
      evaluatePermission("Bash", { command: "echo" }, {}).decision,
    ).toBe("pass-through");
  });

  it("returns 'pass-through' when no rule matches the call", () => {
    const overlay: OverlayPermissions = {
      deny: ["Bash(rm -rf:*)"],
      allow: ["Read(**)"],
    };
    expect(
      evaluatePermission("Write", { file_path: "/tmp/x" }, overlay).decision,
    ).toBe("pass-through");
  });

  it("returns 'deny' when a deny rule matches", () => {
    const overlay: OverlayPermissions = {
      deny: ["Bash(echo perm-deny-test:*)"],
    };
    const result = evaluatePermission(
      "Bash",
      { command: "echo perm-deny-test:hello" },
      overlay,
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("Bash(echo perm-deny-test:*)");
    expect(result.matchedField).toBe("command");
  });

  it("returns 'allow' when an allow rule matches and no deny matches", () => {
    const overlay: OverlayPermissions = {
      allow: ["Read(/safe/**)"],
      deny: ["Bash(*)"],
    };
    const result = evaluatePermission(
      "Read",
      { file_path: "/safe/foo.txt" },
      overlay,
    );
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBe("Read(/safe/**)");
  });

  it("deny takes precedence over allow when both match", () => {
    const overlay: OverlayPermissions = {
      // Pattern uses `*` glob to cover the suffix; the colon convention
      // (`Bash(rm -rf:*)`) is also legal but the test exercises the
      // simpler suffix-glob form against a real space-separated command.
      deny: ["Bash(rm -rf*)"],
      allow: ["Bash(*)"],
    };
    expect(
      evaluatePermission("Bash", { command: "rm -rf /tmp" }, overlay).decision,
    ).toBe("deny");
  });

  it("first matching deny rule wins (matchedRule reports it)", () => {
    const overlay: OverlayPermissions = {
      deny: ["Bash(echo *)", "Bash(*)"],
    };
    const result = evaluatePermission(
      "Bash",
      { command: "echo hi" },
      overlay,
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("Bash(echo *)");
  });

  it("matches against the live test's exact rule shape (regression target)", () => {
    // This is the exact rule the live-mail-reuse-dispatch.test.ts ships
    // on the wire; the evaluator MUST match it for the live test's
    // PERM_DENIED assertion to pass.
    const overlay: OverlayPermissions = {
      deny: ["Bash(echo perm-deny-test:*)"],
    };
    expect(
      evaluatePermission(
        "Bash",
        { command: "echo perm-deny-test:hello-world" },
        overlay,
      ).decision,
    ).toBe("deny");
  });
});
