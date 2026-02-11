/**
 * CLI Agent Auto-Detection Module
 *
 * Detects installed CLI coding agents, exposes them via a registry,
 * and provides command construction for headless invocation.
 */

// Types
export type {
  CLIAgentDefinition,
  HeadlessConfig,
  DetectedAgent,
  DetectionResult,
  SpawnCommand,
  SpawnCommandOptions,
  AgentDetectionConfig,
  AgentDetectionErrorCode,
} from "./types.js";
export { AgentDetectionError } from "./types.js";

// Registry
export {
  AgentRegistry,
  createAgentRegistry,
  BUILTIN_AGENTS,
} from "./registry.js";

// Detector
export {
  AgentDetector,
  createAgentDetector,
  parseVersion,
} from "./detector.js";

// Command builder
export { buildSpawnCommand, formatSpawnCommand } from "./command-builder.js";
