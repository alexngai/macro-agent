/**
 * Queue Integration Strategy
 *
 * Wraps the existing MergeQueueInterface — submits merge requests to
 * the queue for sequential processing by an integrator agent.
 *
 * This produces identical behavior to the current worker done() handler's
 * merge queue path.
 *
 * @module workspace/strategies/queue
 */

import type {
  IntegrationStrategy,
  LandRequest,
  LandResult,
  QueueStrategyConfig,
} from "./types.js";
import type { MergeQueueInterface } from "../merge-queue/types.js";

export class QueueIntegrationStrategy implements IntegrationStrategy {
  readonly name = "queue";
  private mergeQueue?: MergeQueueInterface;
  private defaultPriority: number;

  constructor(config?: Record<string, unknown>) {
    const typedConfig = config as QueueStrategyConfig | undefined;
    this.defaultPriority = typedConfig?.defaultPriority ?? 100;
  }

  /**
   * Set the merge queue instance.
   * Called after construction since merge queue may not be available at strategy creation time.
   */
  setMergeQueue(queue: MergeQueueInterface): void {
    this.mergeQueue = queue;
  }

  async land(request: LandRequest): Promise<LandResult> {
    if (!this.mergeQueue) {
      return {
        status: "failed",
        error: "Merge queue not configured",
      };
    }

    if (!request.streamId) {
      return {
        status: "failed",
        error: "streamId required for queue strategy",
      };
    }

    if (!request.taskId) {
      return {
        status: "failed",
        error: "taskId required for queue strategy",
      };
    }

    try {
      const mrId = this.mergeQueue.submit({
        streamId: request.streamId,
        taskId: request.taskId,
        workerBranch: request.sourceBranch,
        workerAgentId: request.agentId,
        priority: this.defaultPriority,
      });

      return {
        status: "landed",
        mergeRequestId: mrId,
      };
    } catch (error) {
      return {
        status: "failed",
        error: `Failed to submit to merge queue: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
