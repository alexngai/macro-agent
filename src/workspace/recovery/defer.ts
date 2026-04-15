/**
 * `defer` conflict recovery strategy — no-op.
 *
 * Leaves the conflict record in place; stream stays `conflicted`. Something
 * else (human, external process, scheduled recovery) resolves later.
 *
 * @module workspace/recovery/defer
 */

import type {
  ConflictContext,
  ConflictRecoveryStrategy,
  ConflictResolution,
} from './types.js';

export class DeferStrategy implements ConflictRecoveryStrategy {
  readonly name = 'defer';
  readonly mode = 'sync' as const;

  async recover(_ctx: ConflictContext): Promise<ConflictResolution> {
    return { kind: 'deferred', reason: 'no recovery strategy configured' };
  }
}
