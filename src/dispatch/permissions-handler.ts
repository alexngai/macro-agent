/**
 * `x-dispatch/permissions.set` and `x-dispatch/permissions.clear` MAP
 * notification handlers — runtime-agnostic wire shape, macro-agent-specific
 * implementation.
 *
 * Called by OpenHive's orchestrator on the ACP+reuse dispatch path to apply
 * per-dispatch loadout deny/allow rules to a long-lived agent's session at
 * runtime, without recreating the session. The handler invokes
 * `setPermissionOverlay` (resp. `clearPermissionOverlay`); the prompt
 * iterator in `agent-manager-v2.ts` enforces the overlay against
 * `permission_request` ACP session updates.
 *
 * See `docs/PERMISSION_OVERLAY_ACP_DESIGN.md` for the four-process flow
 * diagram and rationale. The mail+reuse path uses the same overlay
 * registry but sets/clears it directly from `mail-inbound-reuse-consumer`
 * (which has a clean entry point on swarm side); ACP+reuse needs this MAP
 * wire because the dispatch's prompt arrives through the ACP server with
 * no equivalent consumer to bracket.
 *
 * Wire shape (set):
 *
 *   request:  { agent_id: string, deny?: string[], allow?: string[] }
 *   response: { ok: true } | { ok: false, error: string }
 *
 * Wire shape (clear):
 *
 *   request:  { agent_id: string }
 *   response: { ok: true } | { ok: false, error: string }
 *
 * Notification-pair pattern matches the existing `x-dispatch/spawn-agent`
 * handler (the MAP SDK's AgentConnection doesn't expose
 * setRequestHandler, so we use notifications with correlation_ids).
 */

import {
  setPermissionOverlay,
  clearPermissionOverlay,
} from "./permission-overlay.js";

export interface PermissionsSetRequest {
  agent_id: string;
  deny?: string[];
  allow?: string[];
}

export interface PermissionsClearRequest {
  agent_id: string;
}

export type PermissionsResponse =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Handle `x-dispatch/permissions.set.request`. Sets the per-agent overlay
 * registry entry that the prompt iterator consults when answering
 * `permission_request` session updates.
 *
 * Idempotent: re-setting on the same agent overwrites the prior overlay.
 * Safe: returns an error response (rather than throwing) for malformed
 * params or unknown agents — the orchestrator should log and proceed.
 */
export function handlePermissionsSet(
  params: PermissionsSetRequest,
  log: (msg: string) => void = console.log,
): PermissionsResponse {
  if (!params || typeof params.agent_id !== "string" || params.agent_id === "") {
    return { ok: false, error: "x-dispatch/permissions.set: missing or invalid 'agent_id'" };
  }
  if (params.deny !== undefined && !Array.isArray(params.deny)) {
    return { ok: false, error: "x-dispatch/permissions.set: 'deny' must be an array of strings" };
  }
  if (params.allow !== undefined && !Array.isArray(params.allow)) {
    return { ok: false, error: "x-dispatch/permissions.set: 'allow' must be an array of strings" };
  }

  const overlay = {
    ...(params.deny ? { deny: params.deny } : {}),
    ...(params.allow ? { allow: params.allow } : {}),
  };
  setPermissionOverlay(params.agent_id, overlay);
  log(
    `[x-dispatch/permissions.set] agent=${params.agent_id} ` +
      `deny=${params.deny?.length ?? 0} allow=${params.allow?.length ?? 0}`,
  );
  return { ok: true };
}

/**
 * Handle `x-dispatch/permissions.clear.request`. Removes any overlay set
 * on the named agent. Idempotent: clearing a non-existent overlay is a
 * no-op success. Always paired with a prior `set` from the same dispatch;
 * the orchestrator must guarantee `clear` runs even on dispatch failure.
 */
export function handlePermissionsClear(
  params: PermissionsClearRequest,
  log: (msg: string) => void = console.log,
): PermissionsResponse {
  if (!params || typeof params.agent_id !== "string" || params.agent_id === "") {
    return { ok: false, error: "x-dispatch/permissions.clear: missing or invalid 'agent_id'" };
  }
  clearPermissionOverlay(params.agent_id);
  log(`[x-dispatch/permissions.clear] agent=${params.agent_id}`);
  return { ok: true };
}

export const X_DISPATCH_PERMISSIONS_METHODS = {
  SET_REQUEST: "x-dispatch/permissions.set.request",
  SET_RESPONSE: "x-dispatch/permissions.set.response",
  CLEAR_REQUEST: "x-dispatch/permissions.clear.request",
  CLEAR_RESPONSE: "x-dispatch/permissions.clear.response",
} as const;
