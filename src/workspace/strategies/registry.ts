/**
 * Integration Strategy Registry
 *
 * Factory registry for creating named integration strategies.
 * Supports registration of custom strategies alongside built-in ones.
 *
 * @module workspace/strategies/registry
 */

import type {
  IntegrationStrategy,
  IntegrationStrategyFactory,
} from "./types.js";
import { QueueIntegrationStrategy } from "./queue.js";
import { TrunkIntegrationStrategy } from "./trunk.js";
import { OptimisticIntegrationStrategy } from "./optimistic.js";

// =============================================================================
// Registry
// =============================================================================

export class IntegrationStrategyRegistry {
  private factories = new Map<string, IntegrationStrategyFactory>();

  /**
   * Register a strategy factory under a name.
   */
  register(name: string, factory: IntegrationStrategyFactory): void {
    this.factories.set(name, factory);
  }

  /**
   * Create a strategy instance by name.
   *
   * @throws Error if the strategy name is not registered
   */
  get(name: string, config?: Record<string, unknown>): IntegrationStrategy {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(
        `Unknown integration strategy: '${name}'. Available: ${this.list().join(", ")}`
      );
    }
    return factory(config);
  }

  /**
   * Check if a strategy is registered.
   */
  has(name: string): boolean {
    return this.factories.has(name);
  }

  /**
   * List registered strategy names.
   */
  list(): string[] {
    return Array.from(this.factories.keys());
  }
}

// =============================================================================
// Default Registry
// =============================================================================

/**
 * Create a registry with all built-in strategies registered.
 */
export function createDefaultStrategyRegistry(): IntegrationStrategyRegistry {
  const registry = new IntegrationStrategyRegistry();

  registry.register(
    "queue",
    (config) => new QueueIntegrationStrategy(config)
  );
  registry.register(
    "trunk",
    (config) => new TrunkIntegrationStrategy(config)
  );
  registry.register(
    "optimistic",
    (config) => new OptimisticIntegrationStrategy(config)
  );

  return registry;
}

/** Singleton default registry */
export const defaultStrategyRegistry = createDefaultStrategyRegistry();
