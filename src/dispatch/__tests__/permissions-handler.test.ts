/**
 * Unit tests for the `x-dispatch/permissions.{set,clear}` MAP request
 * handlers. These verify the wire-shape contract — the OpenHive ACP+reuse
 * dispatch path calls these to inject loadout deny rules into a long-lived
 * agent's permission overlay before driving the prompt, and to clear them
 * after the dispatch completes.
 *
 * The actual enforcement is exercised end-to-end in the live test
 * (live-acp-reuse-dispatch.test.ts); here we just pin the handler's
 * input/output contract and the side effects on the overlay registry.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  handlePermissionsSet,
  handlePermissionsClear,
  X_DISPATCH_PERMISSIONS_METHODS,
} from "../permissions-handler.js";
import {
  getPermissionOverlay,
  clearPermissionOverlay,
} from "../permission-overlay.js";

describe("x-dispatch/permissions handlers", () => {
  const TEST_AGENT_ID = "agent_test_perm_handler_xyz";

  beforeEach(() => {
    clearPermissionOverlay(TEST_AGENT_ID);
  });

  afterEach(() => {
    clearPermissionOverlay(TEST_AGENT_ID);
  });

  describe("set", () => {
    it("accepts deny + allow, writes overlay, returns ok=true", () => {
      const result = handlePermissionsSet(
        {
          agent_id: TEST_AGENT_ID,
          deny: ["Read(/etc/secrets)"],
          allow: ["Read(/tmp/*)"],
        },
        () => {},
      );
      expect(result).toEqual({ ok: true });
      const overlay = getPermissionOverlay(TEST_AGENT_ID);
      expect(overlay).toEqual({
        deny: ["Read(/etc/secrets)"],
        allow: ["Read(/tmp/*)"],
      });
    });

    it("accepts deny only", () => {
      const result = handlePermissionsSet(
        { agent_id: TEST_AGENT_ID, deny: ["Bash(rm -rf:*)"] },
        () => {},
      );
      expect(result).toEqual({ ok: true });
      expect(getPermissionOverlay(TEST_AGENT_ID)).toEqual({
        deny: ["Bash(rm -rf:*)"],
      });
    });

    it("accepts allow only", () => {
      const result = handlePermissionsSet(
        { agent_id: TEST_AGENT_ID, allow: ["Read(*)"] },
        () => {},
      );
      expect(result).toEqual({ ok: true });
      expect(getPermissionOverlay(TEST_AGENT_ID)).toEqual({
        allow: ["Read(*)"],
      });
    });

    it("re-setting overwrites the prior overlay (idempotent)", () => {
      handlePermissionsSet(
        { agent_id: TEST_AGENT_ID, deny: ["Read(/old)"] },
        () => {},
      );
      handlePermissionsSet(
        { agent_id: TEST_AGENT_ID, deny: ["Read(/new)"] },
        () => {},
      );
      expect(getPermissionOverlay(TEST_AGENT_ID)).toEqual({
        deny: ["Read(/new)"],
      });
    });

    it("rejects missing agent_id", () => {
      // @ts-expect-error - testing runtime validation
      const result = handlePermissionsSet({ deny: [] }, () => {});
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toMatch(/agent_id/);
    });

    it("rejects non-string agent_id", () => {
      const result = handlePermissionsSet(
        // @ts-expect-error - testing runtime validation
        { agent_id: 42, deny: [] },
        () => {},
      );
      expect(result.ok).toBe(false);
    });

    it("rejects non-array deny", () => {
      const result = handlePermissionsSet(
        // @ts-expect-error - testing runtime validation
        { agent_id: TEST_AGENT_ID, deny: "Read(*)" },
        () => {},
      );
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toMatch(/deny/);
    });

    it("rejects non-array allow", () => {
      const result = handlePermissionsSet(
        // @ts-expect-error - testing runtime validation
        { agent_id: TEST_AGENT_ID, allow: { 0: "x" } },
        () => {},
      );
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toMatch(/allow/);
    });
  });

  describe("clear", () => {
    it("removes a previously-set overlay", () => {
      handlePermissionsSet(
        { agent_id: TEST_AGENT_ID, deny: ["Read(/secret)"] },
        () => {},
      );
      expect(getPermissionOverlay(TEST_AGENT_ID)).toBeTruthy();

      const result = handlePermissionsClear(
        { agent_id: TEST_AGENT_ID },
        () => {},
      );
      expect(result).toEqual({ ok: true });
      expect(getPermissionOverlay(TEST_AGENT_ID)).toBeUndefined();
    });

    it("idempotent — clearing a non-existent overlay returns ok=true", () => {
      const result = handlePermissionsClear(
        { agent_id: TEST_AGENT_ID },
        () => {},
      );
      expect(result).toEqual({ ok: true });
    });

    it("rejects missing agent_id", () => {
      // @ts-expect-error - testing runtime validation
      const result = handlePermissionsClear({}, () => {});
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toMatch(/agent_id/);
    });
  });

  describe("method names — pinning the wire contract", () => {
    it("matches the namespaced x-dispatch/permissions.* convention", () => {
      expect(X_DISPATCH_PERMISSIONS_METHODS).toEqual({
        SET_REQUEST: "x-dispatch/permissions.set.request",
        SET_RESPONSE: "x-dispatch/permissions.set.response",
        CLEAR_REQUEST: "x-dispatch/permissions.clear.request",
        CLEAR_RESPONSE: "x-dispatch/permissions.clear.response",
      });
    });
  });
});
