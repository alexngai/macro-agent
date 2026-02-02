/**
 * Trigger Wake System
 *
 * Manages waking agents with pending system events.
 *
 * @module trigger/wake
 */

export {
  createWakeManager,
  type WakeManagerDeps,
} from "./wake-manager.js";

export type {
  TriggerWakeManager,
  WakeManagerConfig,
  WakeRequest,
  WakeResult,
  WakeCycleResult,
  AgentDrainResult,
  WakeHandler,
} from "./types.js";
