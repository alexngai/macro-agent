/**
 * Agent Detection Extension Methods
 *
 * Exposes CLI agent auto-detection to external MAP clients:
 * - `_macro/agents/available` — List detected CLI agents (cached)
 * - `_macro/agents/refresh` — Force a fresh detection scan
 *
 * Both methods are read-only queries gated by `canQuery`.
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type {
  DetectedAgent,
  DetectionResult,
} from "../../../agent-detection/types.js";

// =============================================================================
// Request/Response Types
// =============================================================================

interface AvailableParams {
  /** Include agents that are not installed (default: false) */
  includeNotInstalled?: boolean;
}

interface AvailableResult {
  /** Detected agents */
  agents: PublicDetectedAgent[];
  /** Number of agent definitions scanned */
  scanned: number;
  /** Detection duration in milliseconds */
  durationMs: number;
  /** Whether results came from cache */
  cached: boolean;
}

interface RefreshResult {
  /** Detected agents (fresh scan) */
  agents: PublicDetectedAgent[];
  /** Number of agent definitions scanned */
  scanned: number;
  /** Detection duration in milliseconds */
  durationMs: number;
}

/**
 * Public agent info returned to MAP clients.
 * Strips internal details (binary path) for security.
 */
interface PublicDetectedAgent {
  /** Agent definition ID (e.g., "claude-code") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Whether the binary was found on PATH */
  installed: boolean;
  /** Parsed version string (e.g., "1.2.3") */
  version?: string;
  /** Provider/vendor name */
  vendor: string;
  /** Short description */
  description: string;
}

// =============================================================================
// Extension Services
// =============================================================================

/**
 * Services required for agent detection extensions.
 *
 * Uses narrow method signatures rather than exposing the full AgentDetector
 * to keep the contract minimal and testable.
 */
export interface AgentDetectionExtensionServices {
  /**
   * Get available agents, returning cached results when possible.
   */
  getAvailableAgents: (options?: {
    refresh?: boolean;
    includeNotInstalled?: boolean;
  }) => Promise<DetectionResult>;

  /**
   * Whether a detection scan is currently running.
   */
  isDetecting: () => boolean;

  /**
   * Get cached result without triggering a new scan.
   * Returns null if no results are available yet.
   */
  getCachedResult: () => DetectionResult | null;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert internal DetectedAgent to public format.
 * Strips filesystem paths for security.
 */
function toPublicAgent(agent: DetectedAgent): PublicDetectedAgent {
  return {
    id: agent.id,
    name: agent.name,
    installed: agent.installed,
    version: agent.version,
    vendor: agent.definition.vendor,
    description: agent.definition.description,
  };
}

// =============================================================================
// Handler Implementations
// =============================================================================

function createAvailableHandler(
  services: AgentDetectionExtensionServices,
): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { includeNotInstalled = false } = (params ?? {}) as AvailableParams;

    // Try cached result first
    const cached = services.getCachedResult();
    if (cached) {
      const agents = includeNotInstalled
        ? cached.agents
        : cached.agents.filter((a) => a.installed);

      return {
        agents: agents.map(toPublicAgent),
        scanned: cached.scanned,
        durationMs: cached.durationMs,
        cached: true,
      } satisfies AvailableResult;
    }

    // No cache — run detection
    const result = await services.getAvailableAgents({ includeNotInstalled });

    return {
      agents: result.agents.map(toPublicAgent),
      scanned: result.scanned,
      durationMs: result.durationMs,
      cached: false,
    } satisfies AvailableResult;
  };
}

function createRefreshHandler(
  services: AgentDetectionExtensionServices,
): ExtensionHandler {
  return async (_context: ExtensionContext, _params: unknown) => {
    const result = await services.getAvailableAgents({
      refresh: true,
      includeNotInstalled: true,
    });

    return {
      agents: result.agents.map(toPublicAgent),
      scanned: result.scanned,
      durationMs: result.durationMs,
    } satisfies RefreshResult;
  };
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register agent detection extension methods with the MAPAdapter.
 *
 * @param adapter - MAPAdapter instance
 * @param services - Agent detection services
 */
export function registerAgentDetectionExtensions(
  adapter: MAPAdapter,
  services: AgentDetectionExtensionServices,
): void {
  adapter.registerExtension(
    "_macro/agents/available",
    createAvailableHandler(services),
  );
  adapter.registerExtension(
    "_macro/agents/refresh",
    createRefreshHandler(services),
  );
}

/**
 * Unregister agent detection extension methods.
 *
 * @param adapter - MAPAdapter instance
 */
export function unregisterAgentDetectionExtensions(adapter: MAPAdapter): void {
  adapter.unregisterExtension("_macro/agents/available");
  adapter.unregisterExtension("_macro/agents/refresh");
}
