/**
 * Cognitive ACP Extension Methods (_macro/cognitive/*)
 *
 * Exposes Atlas cognitive operations as ACP extension methods.
 * These handler functions can be registered via extMethod in the
 * MacroAgent ACP handler.
 *
 * Methods:
 * - _macro/cognitive/command - Dispatch Atlas operations (extract, prune, query)
 * - _macro/cognitive/status  - Query Atlas availability
 * - _macro/cognitive/query   - Shorthand for synchronous memory query
 *
 * V2 port: Standalone handler functions (no MAP adapter dependency).
 * Uses InboxAdapter for async result notifications instead of EventStore.
 */

import type { AtlasInstance, CognitiveOperation } from "./types.js";
import type { InboxAdapter } from "../adapters/types.js";
import { nanoid } from "nanoid";

// =============================================================================
// Extension Services
// =============================================================================

export interface CognitiveExtensionServices {
  atlas: AtlasInstance;
  inboxAdapter?: InboxAdapter;
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

/**
 * Handle _macro/cognitive/command requests.
 * Dispatches Atlas operations: extract, prune, team-extract, query.
 */
export async function handleCognitiveCommand(
  services: CognitiveExtensionServices,
  params: unknown,
): Promise<unknown> {
  const { operation, config, job_id } = (params ?? {}) as CommandParams;

  if (!operation) {
    throw new Error("operation is required");
  }

  const jobId = job_id ?? `cog_${nanoid(8)}`;

  switch (operation) {
    case "query": {
      const query = config?.query as string | undefined;
      if (!query) {
        throw new Error("config.query is required for query operation");
      }
      const result = await services.atlas.queryMemory(query, {
        domains: config?.domains as string[] | undefined,
        includeExperiences: config?.includeExperiences as boolean | undefined,
        includePlaybooks: config?.includePlaybooks as boolean | undefined,
      });
      return { job_id: jobId, status: "completed", result };
    }

    case "extract": {
      // Fire-and-forget: start batch learning, notify when done
      runAsyncOperation(services, jobId, async () => {
        return await services.atlas.runBatchLearning();
      });
      return { job_id: jobId, status: "started" };
    }

    case "team-extract": {
      if (!services.atlas.runTeamBatchLearning) {
        throw new Error("team-extract is not supported by this Atlas instance");
      }
      const atlas = services.atlas;
      runAsyncOperation(services, jobId, async () => {
        return await atlas.runTeamBatchLearning!();
      });
      return { job_id: jobId, status: "started" };
    }

    case "prune": {
      if (!services.atlas.prune) {
        throw new Error("prune is not supported by this Atlas instance");
      }
      const atlas = services.atlas;
      runAsyncOperation(services, jobId, async () => {
        return await atlas.prune!(config);
      });
      return { job_id: jobId, status: "started" };
    }

    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

/**
 * Handle _macro/cognitive/status requests.
 * Returns Atlas availability and supported operations.
 */
export async function handleCognitiveStatus(
  services: CognitiveExtensionServices,
  _params?: unknown,
): Promise<unknown> {
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
}

/**
 * Handle _macro/cognitive/query requests.
 * Shorthand for synchronous memory query.
 */
export async function handleCognitiveQuery(
  services: CognitiveExtensionServices,
  params: unknown,
): Promise<unknown> {
  const { query, options } = (params ?? {}) as QueryParams;

  if (!query) {
    throw new Error("query is required");
  }

  const result = await services.atlas.queryMemory(query, options);
  return { result };
}

// =============================================================================
// Async operation helper
// =============================================================================

function runAsyncOperation(
  services: CognitiveExtensionServices,
  jobId: string,
  fn: () => Promise<unknown>,
): void {
  // Fire-and-forget: run operation, send result notification when done
  fn()
    .then((result) => {
      if (services.inboxAdapter) {
        services.inboxAdapter.send(
          "cognitive-backend",
          "cognitive-backend",
          {
            type: "cognitive_result",
            job_id: jobId,
            status: "completed",
            result,
          },
          { subject: "cognitive_result" },
        ).catch(() => {});
      }
    })
    .catch((err) => {
      if (services.inboxAdapter) {
        services.inboxAdapter.send(
          "cognitive-backend",
          "cognitive-backend",
          {
            type: "cognitive_result",
            job_id: jobId,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          },
          { subject: "cognitive_result" },
        ).catch(() => {});
      }
    });
}

// =============================================================================
// Extension method names
// =============================================================================

export const COGNITIVE_EXTENSION_METHODS = [
  "_macro/cognitive/command",
  "_macro/cognitive/status",
  "_macro/cognitive/query",
] as const;
