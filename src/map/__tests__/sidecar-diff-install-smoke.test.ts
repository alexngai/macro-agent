/**
 * Structural smoke test for the sidecar's diff-server install hook.
 *
 * `sidecar.ts` wires three things together under the same
 * `if (gitCascadeAdapter)` branch:
 *
 *   1. createCascadeBridge    — outbound x-cascade/* events
 *   2. setupCascadeActionHandlers — inbound x-cascade/request.*
 *   3. setupCascadeDiffServer — inbound cascade/diff.request   ← (added in S1.11)
 *
 * Plus the capability declaration is conditional on `gitCascadeAdapter`
 * (S1.10) so the hub only gates diff requests on swarms that can serve them.
 *
 * If any of these are dropped or re-conditioned by a refactor, this test
 * fails loudly. A live integration would catch it too, but at much higher
 * setup cost.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_PATH = resolve(__dirname, '../sidecar.ts');
const sidecarSource = readFileSync(SIDECAR_PATH, 'utf-8');

describe('sidecar.ts cascade-diff install (structural smoke)', () => {
  it('imports setupCascadeDiffServer under the cascade-adapter branch', () => {
    // The import is dynamic (`await import(...)`) inside the
    // `if (gitCascadeAdapter)` branch, like the action-handler import.
    expect(sidecarSource).toMatch(
      /await import\(['"]\.\/cascade-diff-server\.js['"]\)/,
    );
  });

  it('only installs setupCascadeDiffServer when gitCascadeAdapter is present', () => {
    // Find the cascade-adapter conditional block and make sure the diff
    // server install lives inside it. We assert by checking that
    // `setupCascadeDiffServer(` appears *after* `if (gitCascadeAdapter)`
    // and *before* the matching close — proxied by checking it sits
    // between the action-handler install and the `cascadeBridgeCleanup`
    // assignment.
    const guardIdx = sidecarSource.indexOf('if (gitCascadeAdapter)');
    const actionIdx = sidecarSource.indexOf('setupCascadeActionHandlers(');
    const diffIdx = sidecarSource.indexOf('setupCascadeDiffServer(');
    const cleanupIdx = sidecarSource.indexOf('cascadeBridgeCleanup = () =>');

    expect(guardIdx).toBeGreaterThan(-1);
    expect(actionIdx).toBeGreaterThan(guardIdx);
    expect(diffIdx).toBeGreaterThan(actionIdx);
    expect(cleanupIdx).toBeGreaterThan(diffIdx);
  });

  it('adds the diff cleanup to the cascadeBridgeCleanup chain', () => {
    // The cleanup returned by setupCascadeDiffServer must be invoked
    // alongside the bridge.dispose + actionCleanup. Grep for the name
    // used in S1.11: `diffCleanup`.
    expect(sidecarSource).toMatch(/const diffCleanup\s*=\s*setupCascadeDiffServer\(/);
    // And it's called from the composed cleanup function.
    const cleanupBlock = sidecarSource.match(
      /cascadeBridgeCleanup\s*=\s*\(\)\s*=>\s*{[\s\S]*?};/,
    )?.[0];
    expect(cleanupBlock).toBeDefined();
    expect(cleanupBlock).toContain('diffCleanup()');
  });

  it('only declares the cascade capability when adapter is wired (S1.10)', () => {
    // The capability declaration is a conditional spread keyed on
    // gitCascadeAdapter. Without an adapter, no `cascade:` block is sent.
    expect(sidecarSource).toMatch(
      /\.\.\.\(gitCascadeAdapter\s*\?\s*\{\s*cascade:\s*cascadeCapability\s*\}\s*:\s*\{\}\)/,
    );
  });

  it('declares the full cascade capability (canServeDiff + canAct + emitsConflicts)', () => {
    // macro-agent is a full-control cascade runtime: it serves diffs,
    // handles inbound x-cascade/request.* actions, and forwards conflict
    // events. The CascadeCapability constant must reflect all three.
    const capBlock = sidecarSource.match(
      /const cascadeCapability:\s*CascadeCapability\s*=\s*{[\s\S]*?};/,
    )?.[0];
    expect(capBlock).toBeDefined();
    expect(capBlock).toContain('canServeDiff: true');
    expect(capBlock).toContain('canAct: true');
    expect(capBlock).toContain('emitsConflicts: true');
    // autoCloseOnMerge is an opt-in close policy with no wiring — not declared.
    expect(capBlock).not.toContain('autoCloseOnMerge');
  });
});
