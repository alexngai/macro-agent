/**
 * Agent Simulator exports
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

export * from "./types.js";
export { createAgentSimulator } from "./agent-simulator.js";
export {
  BehaviorExecutor,
  createBehaviorExecutor,
  type BehaviorExecutorConfig,
  type ExecutorState,
} from "./behavior-executor.js";
