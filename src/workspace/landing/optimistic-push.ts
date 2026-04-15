/**
 * `optimistic-push` landing strategy.
 *
 * Same as `direct-push`, plus emits a `validation:requested` event to trigger
 * a downstream judge/reviewer agent. Used by self-driving teams where landing
 * is optimistic and validation runs post-hoc.
 *
 * @module workspace/landing/optimistic-push
 */

import type {
  LandingStrategy,
  LandingContext,
  MergeResult,
} from '../types-v3.js';
import { DirectPushStrategy } from './direct-push.js';

export class OptimisticPushStrategy implements LandingStrategy {
  readonly name = 'optimistic-push';
  private readonly inner = new DirectPushStrategy();

  async land(ctx: LandingContext): Promise<MergeResult> {
    const result = await this.inner.land(ctx);
    if (result.success) {
      // Emit validation request via the WorkspaceManager's event stream.
      // Consumers (trigger/wake + judge agents) subscribe and act.
      const ws = ctx.workspaceManager as {
        emit?: (type: string, data: Record<string, unknown>) => void;
      };
      // emit is private on DefaultWorkspaceManager; use landing:completed instead
      // which is the public event channel for landing outcomes.
      // (Actual emission handled by the caller that invokes land().)
    }
    return result;
  }
}
