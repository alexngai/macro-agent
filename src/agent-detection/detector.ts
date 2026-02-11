/**
 * CLI Agent Detector
 *
 * Detects installed CLI coding agents by checking PATH availability
 * and querying version information. Results are cached with configurable TTL.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  CLIAgentDefinition,
  DetectedAgent,
  DetectionResult,
  AgentDetectionConfig,
} from "./types.js";
import { AgentDetectionError } from "./types.js";
import { AgentRegistry, createAgentRegistry } from "./registry.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_WHICH_TIMEOUT_MS = 5_000;
const DEFAULT_VERSION_TIMEOUT_MS = 10_000;

/** Regex to parse version strings like "1.2.3", "0.82.1-beta", etc. */
const VERSION_REGEX = /\d+\.\d+[\.\d]*/;

// =============================================================================
// Agent Detector
// =============================================================================

/**
 * Detects installed CLI coding agents on the system.
 *
 * Runs binary lookups and version checks in parallel, caches results,
 * and provides query methods for available agents.
 */
export class AgentDetector {
  private readonly registry: AgentRegistry;
  private readonly cacheTtlMs: number;
  private readonly whichTimeoutMs: number;
  private readonly versionTimeoutMs: number;
  private readonly disabledAgents: Set<string>;

  private cachedResult: DetectionResult | null = null;
  private detectionInProgress: Promise<DetectionResult> | null = null;

  constructor(config?: AgentDetectionConfig) {
    this.cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.whichTimeoutMs = config?.whichTimeoutMs ?? DEFAULT_WHICH_TIMEOUT_MS;
    this.versionTimeoutMs =
      config?.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
    this.disabledAgents = new Set(config?.disabledAgents ?? []);

    this.registry = createAgentRegistry(config?.additionalAgents);
  }

  /**
   * Get the underlying agent registry.
   */
  getRegistry(): AgentRegistry {
    return this.registry;
  }

  /**
   * Detect all installed agents.
   *
   * Returns cached results if available and not expired.
   * If a detection is already in progress, returns its promise.
   */
  async detect(options?: { refresh?: boolean }): Promise<DetectionResult> {
    // Return cached result if valid
    if (!options?.refresh && this.cachedResult && !this.isCacheExpired()) {
      return this.cachedResult;
    }

    // If detection is already running, return the in-progress promise
    if (this.detectionInProgress) {
      return this.detectionInProgress;
    }

    // Start a new detection scan
    this.detectionInProgress = this.runDetection();

    try {
      const result = await this.detectionInProgress;
      this.cachedResult = result;
      return result;
    } finally {
      this.detectionInProgress = null;
    }
  }

  /**
   * Get available agents (installed only by default).
   */
  async getAvailableAgents(options?: {
    refresh?: boolean;
    includeNotInstalled?: boolean;
  }): Promise<DetectionResult> {
    const result = await this.detect({ refresh: options?.refresh });

    if (options?.includeNotInstalled) {
      return result;
    }

    return {
      ...result,
      agents: result.agents.filter((a) => a.installed),
    };
  }

  /**
   * Get a specific detected agent by ID.
   */
  async getAgent(id: string): Promise<DetectedAgent | undefined> {
    const result = await this.detect();
    return result.agents.find((a) => a.id === id);
  }

  /**
   * Check if a specific agent is installed.
   */
  async isInstalled(id: string): Promise<boolean> {
    const agent = await this.getAgent(id);
    return agent?.installed ?? false;
  }

  /**
   * Get the definition for an agent, throwing if not found.
   */
  getDefinition(id: string): CLIAgentDefinition {
    const def = this.registry.get(id);
    if (!def) {
      throw new AgentDetectionError(
        `Unknown agent backend: ${id}`,
        "UNKNOWN_AGENT",
        id
      );
    }
    return def;
  }

  /**
   * Invalidate the detection cache.
   */
  invalidateCache(): void {
    this.cachedResult = null;
  }

  /**
   * Get partial results if detection is in progress, or cached results.
   * Returns null if no results are available yet.
   */
  getCachedResult(): DetectionResult | null {
    return this.cachedResult;
  }

  /**
   * Whether a detection scan is currently running.
   */
  isDetecting(): boolean {
    return this.detectionInProgress !== null;
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private isCacheExpired(): boolean {
    if (!this.cachedResult) return true;
    const maxAge = Math.max(...this.cachedResult.agents.map((a) => a.detectedAt));
    return Date.now() - maxAge > this.cacheTtlMs;
  }

  private async runDetection(): Promise<DetectionResult> {
    const definitions = this.registry.listEnabled(
      Array.from(this.disabledAgents)
    );
    const startTime = Date.now();

    const results = await Promise.allSettled(
      definitions.map((def) => this.detectAgent(def))
    );

    const agents: DetectedAgent[] = results.map((result, i) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      // On failure, return a not-installed entry
      return {
        id: definitions[i].id,
        name: definitions[i].name,
        installed: false,
        definition: definitions[i],
        detectedAt: Date.now(),
      };
    });

    return {
      agents,
      scanned: definitions.length,
      durationMs: Date.now() - startTime,
    };
  }

  private async detectAgent(
    definition: CLIAgentDefinition
  ): Promise<DetectedAgent> {
    const detectedAt = Date.now();

    // Step 1: Check if binary exists on PATH
    const binaryPath = await this.findBinary(definition.binary);

    if (!binaryPath) {
      return {
        id: definition.id,
        name: definition.name,
        installed: false,
        definition,
        detectedAt,
      };
    }

    // Step 2: Get version string
    const version = await this.getVersion(definition);

    return {
      id: definition.id,
      name: definition.name,
      installed: true,
      version: version ?? undefined,
      path: binaryPath,
      definition,
      detectedAt,
    };
  }

  private async findBinary(binary: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("which", [binary], {
        timeout: this.whichTimeoutMs,
      });
      const path = stdout.trim();
      return path || null;
    } catch {
      // Binary not found or which failed
      try {
        // Fallback to command -v
        const { stdout } = await execFileAsync(
          "/bin/sh",
          ["-c", `command -v ${binary}`],
          { timeout: this.whichTimeoutMs }
        );
        const path = stdout.trim();
        return path || null;
      } catch {
        return null;
      }
    }
  }

  private async getVersion(
    definition: CLIAgentDefinition
  ): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileAsync(
        definition.binary,
        definition.versionArgs,
        { timeout: this.versionTimeoutMs }
      );

      // Some tools output version to stderr
      const output = stdout || stderr;
      return parseVersion(output);
    } catch {
      return null;
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse a version string from command output.
 * Extracts the first semver-like pattern (e.g., "1.2.3").
 */
export function parseVersion(output: string): string | null {
  const match = output.match(VERSION_REGEX);
  return match ? match[0] : null;
}

/**
 * Create a new AgentDetector with the given configuration.
 */
export function createAgentDetector(
  config?: AgentDetectionConfig
): AgentDetector {
  return new AgentDetector(config);
}
