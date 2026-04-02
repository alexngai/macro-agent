/**
 * Optimistic Integration Strategy
 *
 * Push immediately and emit a validation event. Does NOT run build/test —
 * validation is the judge agent's responsibility (RD5).
 *
 * Uses the same rebase-and-retry logic as trunk for handling push conflicts.
 *
 * @module workspace/strategies/optimistic
 */

import { execSync } from "child_process";
import type {
  IntegrationStrategy,
  LandRequest,
  LandResult,
  OptimisticStrategyConfig,
} from "./types.js";
/** Minimal event store interface for emitting validation events */
interface ValidationEventEmitter {
  emit(event: { type: string; source: { agent_id: string }; payload: Record<string, unknown> }): void;
}

export class OptimisticIntegrationStrategy implements IntegrationStrategy {
  readonly name = "optimistic";
  private maxRetries: number;
  private eventEmitter?: ValidationEventEmitter;

  constructor(config?: Record<string, unknown>) {
    const typedConfig = config as OptimisticStrategyConfig | undefined;
    this.maxRetries = typedConfig?.maxRetries ?? 3;
  }

  /**
   * Set the EventStore for emitting validation events.
   * Called after construction since EventStore may not be available at strategy creation time.
   */
  setEventStore(store: ValidationEventEmitter): void {
    this.eventEmitter = store;
  }

  async land(request: LandRequest): Promise<LandResult> {
    const { workspacePath, targetBranch } = request;
    let retryCount = 0;

    while (retryCount <= this.maxRetries) {
      try {
        // Fetch latest
        this.git(workspacePath, `fetch origin ${targetBranch}`);

        // Rebase onto latest
        try {
          this.git(workspacePath, `rebase origin/${targetBranch}`);
        } catch {
          try {
            this.git(workspacePath, "rebase --abort");
          } catch {
            /* already clean */
          }

          if (retryCount >= this.maxRetries) {
            return {
              status: "conflict",
              retryCount,
              error: `Rebase conflict after ${retryCount + 1} attempts`,
            };
          }
          retryCount++;
          continue;
        }

        // Push optimistically
        try {
          this.git(workspacePath, `push origin HEAD:${targetBranch}`);
        } catch {
          if (retryCount >= this.maxRetries) {
            return {
              status: "conflict",
              retryCount,
              error: `Push rejected after ${retryCount + 1} attempts`,
            };
          }
          retryCount++;
          continue;
        }

        const commitHash = this.git(workspacePath, "rev-parse HEAD").trim();

        // Emit validation:requested event (RD5 — judge handles validation)
        if (this.eventEmitter) {
          try {
            this.eventEmitter.emit({
              type: "status",
              source: { agent_id: request.agentId },
              payload: {
                status_type: "checkpoint",
                summary: `Validation requested for ${commitHash.slice(0, 8)}`,
                validation_requested: true,
                commitHash,
                sourceBranch: request.sourceBranch,
                targetBranch,
                taskId: request.taskId,
                agentId: request.agentId,
              },
            });
          } catch {
            // Never fail land() due to event emission failure
          }
        }

        return {
          status: "landed",
          commitHash,
          retryCount,
        };
      } catch (error) {
        return {
          status: "failed",
          retryCount,
          error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    return {
      status: "failed",
      retryCount,
      error: "Exceeded maximum retries",
    };
  }

  private git(cwd: string, args: string): string {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 30000,
    });
  }
}
