/**
 * Configuration type definitions
 *
 * @deprecated Import StoreConfig from '../instance.js' instead.
 * This file is maintained for backward compatibility.
 */

// Re-export the new StoreConfig from instance.ts
// The new StoreConfig is a superset of the old one
export type { StoreConfig } from '../instance.js';

/**
 * @deprecated Use StoreConfig from '../instance.js' instead.
 * Legacy store configuration interface.
 */
export interface LegacyStoreConfig {
  path?: string;
  inMemory?: boolean;
}
