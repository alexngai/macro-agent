/**
 * `escalate` conflict recovery strategy — human-in-the-loop.
 *
 * Pauses the stream and emits an escalation marker. External systems (UI,
 * on-call agent, operator) resolve the conflict manually, then call
 * `resolve_conflict` MCP tool to unblock.
 *
 * @module workspace/recovery/escalate
 */

import type {
  ConflictContext,
  ConflictRecoveryStrategy,
  ConflictResolution,
} from './types.js';

export class EscalateStrategy implements ConflictRecoveryStrategy {
  readonly name = 'escalate';
  readonly mode = 'async' as const;

  async recover(ctx: ConflictContext): Promise<ConflictResolution> {
    try {
      ctx.workspaceManager.pauseStream(ctx.streamId, 'awaiting human resolution');
    } catch {
      // Non-fatal — stream may already be in a paused/conflicted state
    }
    const target = (ctx.strategyConfig?.notify as string | undefined) ?? 'human';
    return { kind: 'escalated', escalatedTo: target as 'human' };
  }
}
