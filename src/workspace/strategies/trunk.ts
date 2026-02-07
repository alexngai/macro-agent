/**
 * Trunk Integration Strategy
 *
 * Direct push to integration branch with rebase-and-retry on conflict.
 * Suited for trunk-based development workflows where changes are
 * integrated immediately.
 *
 * @module workspace/strategies/trunk
 */

import { execSync } from "child_process";
import type {
  IntegrationStrategy,
  LandRequest,
  LandResult,
  TrunkStrategyConfig,
} from "./types.js";

export class TrunkIntegrationStrategy implements IntegrationStrategy {
  readonly name = "trunk";
  private maxRetries: number;
  private conflictAction: "abandon" | "queued_for_resolution";

  constructor(config?: Record<string, unknown>) {
    const typedConfig = config as TrunkStrategyConfig | undefined;
    this.maxRetries = typedConfig?.maxRetries ?? 3;
    this.conflictAction = typedConfig?.conflictAction ?? "abandon";
  }

  async land(request: LandRequest): Promise<LandResult> {
    const { workspacePath, targetBranch } = request;
    let retryCount = 0;

    while (retryCount <= this.maxRetries) {
      try {
        // Fetch latest target branch
        this.git(workspacePath, `fetch origin ${targetBranch}`);

        // Rebase our changes onto latest target
        try {
          this.git(workspacePath, `rebase origin/${targetBranch}`);
        } catch {
          // Rebase conflict — abort and retry or give up
          try {
            this.git(workspacePath, "rebase --abort");
          } catch {
            /* already clean */
          }

          if (retryCount >= this.maxRetries) {
            const conflictFiles = this.getConflictFiles(workspacePath);
            return {
              status: "conflict",
              conflictFiles,
              retryCount,
              error: `Rebase conflict after ${retryCount + 1} attempts`,
            };
          }

          retryCount++;
          continue;
        }

        // Push to target branch
        try {
          this.git(workspacePath, `push origin HEAD:${targetBranch}`);
        } catch {
          // Push rejected (concurrent update) — retry
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

        // Get the HEAD commit hash
        const commitHash = this.git(workspacePath, "rev-parse HEAD").trim();

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

  private getConflictFiles(cwd: string): string[] {
    try {
      const output = this.git(cwd, "diff --name-only --diff-filter=U");
      return output.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}
