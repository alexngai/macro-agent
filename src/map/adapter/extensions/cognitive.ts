/**
 * Cognitive Extension Methods (_macro/cognitive/*)
 *
 * Exposes Atlas cognitive operations to external MAP clients.
 *
 * Methods:
 * - _macro/cognitive/command - Dispatch Atlas operations (extract, prune, query)
 * - _macro/cognitive/status  - Query Atlas availability
 * - _macro/cognitive/query   - Shorthand for synchronous memory query
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { AtlasInstance, CognitiveOperation } from "../../../cognitive/types.js";
import type { EventStore } from "../../../store/event-store.js";
import type { AgentId } from "../../../store/types/index.js";
import { RPCError } from "../rpc-handler.js";
import { nanoid } from "nanoid";

// =============================================================================
// Extension Services
// =============================================================================

export interface CognitiveExtensionServices {
  atlas: AtlasInstance;
  eventStore: EventStore;
}

// =============================================================================
// Request Types
// =============================================================================

interface CommandParams {
  operation: CognitiveOperation;
  config?: Record<string, unknown>;
  job_id?: string;
}

interface QueryParams {
  query: string;
  options?: {
    domains?: string[];
    includeExperiences?: boolean;
    includePlaybooks?: boolean;
  };
}

// =============================================================================
// Handler Implementations
// =============================================================================

function createCommandHandler(services: CognitiveExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { operation, config, job_id } = (params ?? {}) as CommandParams;

    if (!operation) {
      throw RPCError.invalidParams("operation is required");
    }

    const jobId = job_id ?? `cog_${nanoid(8)}`;

    switch (operation) {
      case "query": {
        const query = config?.query as string | undefined;
        if (!query) {
          throw RPCError.invalidParams("config.query is required for query operation");
        }
        const result = await services.atlas.queryMemory(query, {
          domains: config?.domains as string[] | undefined,
          includeExperiences: config?.includeExperiences as boolean | undefined,
          includePlaybooks: config?.includePlaybooks as boolean | undefined,
        });
        return { job_id: jobId, status: "completed", result };
      }

      case "extract": {
        // Fire-and-forget: start batch learning, emit event when done
        runAsyncOperation(services, jobId, async () => {
          return await services.atlas.runBatchLearning();
        });
        return { job_id: jobId, status: "started" };
      }

      case "team-extract": {
        if (!services.atlas.runTeamBatchLearning) {
          throw RPCError.invalidParams("team-extract is not supported by this Atlas instance");
        }
        const atlas = services.atlas;
        runAsyncOperation(services, jobId, async () => {
          return await atlas.runTeamBatchLearning!();
        });
        return { job_id: jobId, status: "started" };
      }

      case "prune": {
        if (!services.atlas.prune) {
          throw RPCError.invalidParams("prune is not supported by this Atlas instance");
        }
        const atlas = services.atlas;
        runAsyncOperation(services, jobId, async () => {
          return await atlas.prune!(config);
        });
        return { job_id: jobId, status: "started" };
      }

      default:
        throw RPCError.invalidParams(`Unknown operation: ${operation}`);
    }
  };
}

function createStatusHandler(services: CognitiveExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, _params: unknown) => {
    const operations: CognitiveOperation[] = ["extract", "query"];
    if (services.atlas.runTeamBatchLearning) {
      operations.push("team-extract");
    }
    if (services.atlas.prune) {
      operations.push("prune");
    }

    return {
      available: true,
      operations,
    };
  };
}

function createQueryHandler(services: CognitiveExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { query, options } = (params ?? {}) as QueryParams;

    if (!query) {
      throw RPCError.invalidParams("query is required");
    }

    const result = await services.atlas.queryMemory(query, options);
    return { result };
  };
}

// =============================================================================
// Async operation helper
// =============================================================================

function runAsyncOperation(
  services: CognitiveExtensionServices,
  jobId: string,
  fn: () => Promise<unknown>,
): void {
  // Fire-and-forget: run operation, emit result event when done
  fn()
    .then((result) => {
      try {
        services.eventStore.emit({
          type: "status",
          source: { agent_id: "cognitive-backend" as AgentId },
          payload: {
            status_type: "cognitive_result",
            job_id: jobId,
            status: "completed",
            result,
          },
        });
      } catch {
        // Best-effort event emission
      }
    })
    .catch((err) => {
      try {
        services.eventStore.emit({
          type: "status",
          source: { agent_id: "cognitive-backend" as AgentId },
          payload: {
            status_type: "cognitive_result",
            job_id: jobId,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          },
        });
      } catch {
        // Best-effort event emission
      }
    });
}

// =============================================================================
// Registration
// =============================================================================

export const COGNITIVE_EXTENSION_METHODS = [
  "_macro/cognitive/command",
  "_macro/cognitive/status",
  "_macro/cognitive/query",
] as const;

/**
 * Register cognitive extension methods with the MAPAdapter.
 */
export function registerCognitiveExtensions(
  adapter: MAPAdapter,
  services: CognitiveExtensionServices,
): void {
  adapter.registerExtension("_macro/cognitive/command", createCommandHandler(services));
  adapter.registerExtension("_macro/cognitive/status", createStatusHandler(services));
  adapter.registerExtension("_macro/cognitive/query", createQueryHandler(services));
}

/**
 * Unregister cognitive extension methods.
 */
export function unregisterCognitiveExtensions(adapter: MAPAdapter): void {
  for (const method of COGNITIVE_EXTENSION_METHODS) {
    adapter.unregisterExtension(method);
  }
}
