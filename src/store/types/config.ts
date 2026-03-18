/**
 * Configuration type definitions (V2)
 *
 * The V1 StoreConfig from instance.ts has been removed.
 * This file provides a minimal replacement for backward compat.
 */

/** Store configuration (V2 minimal) */
export interface StoreConfig {
  path?: string;
  inMemory?: boolean;
}
