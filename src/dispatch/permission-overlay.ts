/**
 * Permission Overlay Registry
 *
 * Process-singleton map of `agentId → Permissions` for in-flight
 * dispatches. The `PreToolUse` hook installed at spawn time consults
 * this registry on every tool call. Dispatch consumers (e.g., the
 * mail-inbound-reuse-consumer) set the overlay when claiming an
 * in-flight dispatch and clear it on resolution.
 *
 * Why a registry rather than a per-spawn argument:
 *   - The session is created with permissive rules at boot. The
 *     dispatch's narrower deny rules need to apply at *call time*, not
 *     at spawn time, because the agent already exists when the dispatch
 *     arrives. The hook closure captures `agentId` and reads the
 *     registry per-call so updates propagate without recreating the
 *     session.
 *
 * Semantics:
 *   - Intersection-only: the overlay can ADD denies to a session but
 *     cannot grant new allows. If the session was spawned with broad
 *     permissions and the overlay says `allow: [Read]`, the session's
 *     other tools still work — the overlay only tightens.
 *   - Single overlay per agent: `mail-inbound-reuse-consumer` already
 *     enforces one in-flight dispatch per agent (`recipient_busy`
 *     reject), so overwriting is safe.
 *
 * @module dispatch/permission-overlay
 */

export interface OverlayPermissions {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

const overlays = new Map<string, OverlayPermissions>();

/**
 * Apply a permission overlay for an agent. Subsequent tool calls by
 * that agent flow through the `PreToolUse` hook, which consults this
 * registry. Overwrites any prior overlay for the same agent.
 */
export function setPermissionOverlay(
  agentId: string,
  perms: OverlayPermissions,
): void {
  overlays.set(agentId, perms);
}

/**
 * Remove the active overlay for an agent. Subsequent tool calls fall
 * back to the session's static permission rules.
 */
export function clearPermissionOverlay(agentId: string): void {
  overlays.delete(agentId);
}

/**
 * Read the current overlay for an agent. Returns `undefined` when no
 * overlay is in effect — the hook treats that as pass-through.
 */
export function getPermissionOverlay(
  agentId: string,
): OverlayPermissions | undefined {
  return overlays.get(agentId);
}

/**
 * Clear all overlays. Used as defense-in-depth when a fresh consumer
 * starts (process startup); also exposed for test isolation.
 */
export function clearAllPermissionOverlays(): void {
  overlays.clear();
}

/**
 * Test helper — alias for `clearAllPermissionOverlays`. Kept distinct
 * so it's grep-able for "test-only" cleanup paths.
 */
export function _resetForTest(): void {
  overlays.clear();
}

/**
 * Test helper — number of overlays currently active.
 */
export function _sizeForTest(): number {
  return overlays.size;
}
