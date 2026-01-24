/**
 * Built-in Role Exports
 *
 * All core roles defined by the framework.
 */

export { WorkerRole, ResolverWorkerRole } from "./worker.js";
export { IntegratorRole } from "./integrator.js";
export { CoordinatorRole } from "./coordinator.js";
export { MonitorRole } from "./monitor.js";
export { GenericRole } from "./generic.js";

import type { RoleDefinition } from "../types.js";
import { WorkerRole, ResolverWorkerRole } from "./worker.js";
import { IntegratorRole } from "./integrator.js";
import { CoordinatorRole } from "./coordinator.js";
import { MonitorRole } from "./monitor.js";
import { GenericRole } from "./generic.js";

/**
 * Map of all built-in roles by name
 */
export const BUILTIN_ROLES: Map<string, RoleDefinition> = new Map([
  [WorkerRole.name, WorkerRole],
  [ResolverWorkerRole.name, ResolverWorkerRole],
  [IntegratorRole.name, IntegratorRole],
  [CoordinatorRole.name, CoordinatorRole],
  [MonitorRole.name, MonitorRole],
  [GenericRole.name, GenericRole],
]);

/**
 * Get a built-in role by name
 */
export function getBuiltinRole(name: string): RoleDefinition | undefined {
  return BUILTIN_ROLES.get(name);
}

/**
 * Check if a role name is a built-in role
 */
export function isBuiltinRole(name: string): boolean {
  return BUILTIN_ROLES.has(name);
}

/**
 * List all built-in role names
 */
export function listBuiltinRoleNames(): string[] {
  return Array.from(BUILTIN_ROLES.keys());
}
