/**
 * Event schema migrations
 *
 * This module handles migrating events from older schema versions to the current version.
 * Each migration function transforms an event from version N to version N+1.
 *
 * When adding a new migration:
 * 1. Increment CURRENT_EVENT_VERSION in types/events.ts
 * 2. Add a migration function: migrateVNtoVN+1
 * 3. Register it in the MIGRATIONS array
 */

import type { Event } from "./types/index.js";
import { CURRENT_EVENT_VERSION } from "./types/events.js";

/**
 * Migration function type
 * Takes an event at version N and returns it at version N+1
 */
type MigrationFn = (event: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registry of migrations, indexed by source version
 * migrations[0] migrates from v0 (unversioned) to v1
 * migrations[1] migrates from v1 to v2
 * etc.
 */
const MIGRATIONS: MigrationFn[] = [
  // Migration from v0 (unversioned) to v1
  // This handles legacy events that don't have a version field
  migrateV0toV1,
];

/**
 * Migrate an event from v0 (no version field) to v1
 */
function migrateV0toV1(event: Record<string, unknown>): Record<string, unknown> {
  return {
    ...event,
    version: 1,
  };
}

/**
 * Example migration template for future use:
 *
 * function migrateV1toV2(event: Record<string, unknown>): Record<string, unknown> {
 *   // Transform payload structure, rename fields, etc.
 *   return {
 *     ...event,
 *     version: 2,
 *     // Add new required fields with defaults
 *     // newField: event.oldField ?? 'default',
 *   };
 * }
 */

/**
 * Migrate an event to the current schema version
 *
 * @param event - Raw event data (possibly from an older version)
 * @returns Event migrated to the current version
 */
export function migrateEvent(event: Record<string, unknown>): Event {
  let currentVersion = (event.version as number) ?? 0;
  let migratedEvent = { ...event };

  // Apply migrations sequentially until we reach the current version
  while (currentVersion < CURRENT_EVENT_VERSION) {
    const migration = MIGRATIONS[currentVersion];
    if (!migration) {
      throw new Error(
        `No migration found for version ${currentVersion} to ${currentVersion + 1}`
      );
    }
    migratedEvent = migration(migratedEvent);
    currentVersion++;
  }

  return migratedEvent as unknown as Event;
}

/**
 * Check if an event needs migration
 */
export function needsMigration(event: Record<string, unknown>): boolean {
  const version = (event.version as number) ?? 0;
  return version < CURRENT_EVENT_VERSION;
}

/**
 * Get the current event schema version
 */
export function getCurrentVersion(): number {
  return CURRENT_EVENT_VERSION;
}
