/**
 * EventStepper - Deterministic stepping for multi-simulator coordination
 *
 * Provides controlled execution of multiple simulators for testing.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-3bdo Phase 2: Behavior Execution Engine
 */

import type { AgentSimulator, StepResult } from "../simulator/types.js";

/**
 * Result of stepping all simulators
 */
export interface StepAllResult {
  /** Results from each simulator that executed a step */
  results: Map<string, StepResult>;

  /** Number of simulators that executed a step */
  steppedCount: number;

  /** Number of simulators still waiting */
  waitingCount: number;

  /** Number of simulators that are done */
  doneCount: number;

  /** Whether all simulators are idle (waiting or done) */
  allIdle: boolean;
}

/**
 * Condition function for waitForCondition
 */
export type ConditionFn = (
  simulators: Map<string, AgentSimulator>
) => boolean | Promise<boolean>;

/**
 * EventStepper manages deterministic execution of multiple simulators
 */
export class EventStepper {
  private simulators: Map<string, AgentSimulator> = new Map();
  private stepCount = 0;
  private maxSteps = 10000; // Safety limit

  /**
   * Register a simulator for stepping
   */
  register(simulator: AgentSimulator): void {
    this.simulators.set(simulator.agentId, simulator);
  }

  /**
   * Unregister a simulator
   */
  unregister(agentId: string): void {
    this.simulators.delete(agentId);
  }

  /**
   * Get a registered simulator
   */
  get(agentId: string): AgentSimulator | undefined {
    return this.simulators.get(agentId);
  }

  /**
   * Get all registered simulators
   */
  getAll(): AgentSimulator[] {
    return Array.from(this.simulators.values());
  }

  /**
   * Get count of registered simulators
   */
  get count(): number {
    return this.simulators.size;
  }

  /**
   * Get total step count
   */
  get totalSteps(): number {
    return this.stepCount;
  }

  /**
   * Set maximum steps before timeout
   */
  setMaxSteps(max: number): void {
    this.maxSteps = max;
  }

  /**
   * Step a specific simulator once
   */
  async stepOne(agentId: string): Promise<StepResult | undefined> {
    const simulator = this.simulators.get(agentId);
    if (!simulator || !simulator.isRunning()) {
      return undefined;
    }

    this.stepCount++;
    return simulator.stepOnce();
  }

  /**
   * Step all simulators that have pending work
   *
   * Each simulator executes at most one step.
   */
  async stepAll(): Promise<StepAllResult> {
    const results = new Map<string, StepResult>();
    let waitingCount = 0;
    let doneCount = 0;

    for (const [agentId, simulator] of this.simulators) {
      if (!simulator.isRunning()) {
        doneCount++;
        continue;
      }

      if (simulator.hasPendingSteps()) {
        this.stepCount++;
        const result = await simulator.stepOnce();
        results.set(agentId, result);

        if (result.status === "done") {
          doneCount++;
        }
      } else {
        waitingCount++;
      }
    }

    return {
      results,
      steppedCount: results.size,
      waitingCount,
      doneCount,
      allIdle: results.size === 0,
    };
  }

  /**
   * Run until all simulators are idle (waiting or done)
   *
   * @param maxIterations Maximum number of stepAll() calls
   * @returns Final step result
   */
  async runUntilIdle(maxIterations = 1000): Promise<StepAllResult> {
    let iterations = 0;
    let result: StepAllResult;

    do {
      result = await this.stepAll();
      iterations++;

      if (iterations >= maxIterations) {
        throw new Error(
          `runUntilIdle exceeded ${maxIterations} iterations - possible infinite loop`
        );
      }

      if (this.stepCount >= this.maxSteps) {
        throw new Error(
          `runUntilIdle exceeded ${this.maxSteps} total steps - safety limit`
        );
      }
    } while (!result.allIdle);

    return result;
  }

  /**
   * Run until a condition is met
   *
   * @param condition Function that returns true when condition is met
   * @param options Configuration options
   */
  async waitForCondition(
    condition: ConditionFn,
    options: {
      /** Maximum time to wait in milliseconds */
      timeoutMs?: number;
      /** Maximum step iterations */
      maxIterations?: number;
      /** Polling interval in milliseconds */
      pollIntervalMs?: number;
    } = {}
  ): Promise<void> {
    const {
      timeoutMs = 30000,
      maxIterations = 10000,
      pollIntervalMs = 0,
    } = options;

    const startTime = Date.now();
    let iterations = 0;

    while (true) {
      // Check condition
      const met = await condition(this.simulators);
      if (met) {
        return;
      }

      // Check timeout
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error(
          `waitForCondition timed out after ${timeoutMs}ms`
        );
      }

      // Check iterations
      if (iterations >= maxIterations) {
        throw new Error(
          `waitForCondition exceeded ${maxIterations} iterations`
        );
      }

      // Step simulators
      await this.stepAll();
      iterations++;

      // Optional delay
      if (pollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
  }

  /**
   * Wait for a specific simulator to complete
   */
  async waitForSimulator(
    agentId: string,
    options?: { timeoutMs?: number; maxIterations?: number }
  ): Promise<void> {
    await this.waitForCondition(
      (simulators) => {
        const simulator = simulators.get(agentId);
        return !simulator || !simulator.isRunning();
      },
      options
    );
  }

  /**
   * Wait for all simulators to complete
   */
  async waitForAll(
    options?: { timeoutMs?: number; maxIterations?: number }
  ): Promise<void> {
    await this.waitForCondition(
      (simulators) => {
        for (const simulator of simulators.values()) {
          if (simulator.isRunning()) {
            return false;
          }
        }
        return true;
      },
      options
    );
  }

  /**
   * Check if any simulator is running
   */
  hasRunningSimulators(): boolean {
    for (const simulator of this.simulators.values()) {
      if (simulator.isRunning()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if any simulator has pending work
   */
  hasPendingWork(): boolean {
    for (const simulator of this.simulators.values()) {
      if (simulator.isRunning() && simulator.hasPendingSteps()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reset the stepper (unregisters all simulators)
   */
  reset(): void {
    this.simulators.clear();
    this.stepCount = 0;
  }
}

/**
 * Create a new event stepper
 */
export function createEventStepper(): EventStepper {
  return new EventStepper();
}
