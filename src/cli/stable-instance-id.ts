import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * Generate a stable, deterministic instance ID from a directory path.
 *
 * This ensures the same project always uses the same EventStore,
 * so agents and sessions persist across server restarts.
 */
export function getStableInstanceId(cwd: string): string {
  const normalizedPath = resolve(cwd);
  const hash = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 12);
  return `inst_${hash}`;
}
