/**
 * Worktree Pool Implementation
 *
 * A shared pool of git worktrees that manages allocation and recycling
 * across agents. Supports lazy initialization, multiple allocation
 * strategies, and recovery of orphaned worktrees.
 *
 * @module workspace/pool/worktree-pool
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  AllocationResult,
  AllocationStrategy,
  AcquireOptions,
  ReleaseOptions,
  PooledWorktree,
  PoolEvent,
  PoolEventCallback,
  PoolEventType,
  PoolStats,
  QueuedRequest,
  RecoveryResult,
  WorktreePoolConfig,
  WorktreePoolInterface,
  WorktreeState,
} from './types.js';
import type { AgentId, WorkspaceRole } from '../types.js';

/**
 * Default themed names for worktree slots.
 */
const DEFAULT_THEMED_NAMES = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon',
  'zeta', 'eta', 'theta', 'iota', 'kappa',
  'lambda', 'mu', 'nu', 'xi', 'omicron',
  'pi', 'rho', 'sigma', 'tau', 'upsilon',
  'phi', 'chi', 'psi', 'omega',
];

/**
 * Default pool configuration.
 */
const DEFAULT_CONFIG: Partial<WorktreePoolConfig> = {
  maxSize: 50,
  useThemedNames: false,
  recoverOrphans: true,
  defaultStrategy: 'reject',
};

/**
 * WorktreePool manages a shared pool of git worktrees.
 *
 * Features:
 * - Lazy initialization (worktrees created on first acquire)
 * - Shared pool across all roles
 * - Three allocation strategies: reject, queue, steal
 * - Recovery of orphaned worktrees on startup
 * - Event-based notifications
 */
export class WorktreePool implements WorktreePoolInterface {
  private readonly config: Required<WorktreePoolConfig>;
  private readonly slots: Map<string, PooledWorktree> = new Map();
  private readonly agentToSlot: Map<AgentId, string> = new Map();
  private readonly eventListeners: Set<PoolEventCallback> = new Set();
  private readonly waitQueue: QueuedRequest[] = [];
  private initialized = false;
  private closed = false;
  private readonly repoPath: string;

  /**
   * Create a new WorktreePool.
   *
   * @param repoPath - Path to the git repository
   * @param config - Pool configuration
   */
  constructor(repoPath: string, config: Partial<WorktreePoolConfig>) {
    this.repoPath = repoPath;
    this.config = {
      worktreeBaseDir: config.worktreeBaseDir ?? `${repoPath}/.worktrees`,
      maxSize: config.maxSize ?? DEFAULT_CONFIG.maxSize!,
      useThemedNames: config.useThemedNames ?? DEFAULT_CONFIG.useThemedNames!,
      themedNames: config.themedNames ?? DEFAULT_THEMED_NAMES,
      recoverOrphans: config.recoverOrphans ?? DEFAULT_CONFIG.recoverOrphans!,
      defaultStrategy: config.defaultStrategy ?? DEFAULT_CONFIG.defaultStrategy!,
    };
  }

  /**
   * Lazily initialize the pool.
   *
   * Creates slot metadata but not actual worktrees - those are
   * created on first acquire (lazy allocation).
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.closed) throw new Error('Pool is closed');

    // Ensure base directory exists
    if (!fs.existsSync(this.config.worktreeBaseDir)) {
      fs.mkdirSync(this.config.worktreeBaseDir, { recursive: true });
    }

    // Initialize slot metadata (but not actual worktrees)
    for (let i = 0; i < this.config.maxSize; i++) {
      const slotId = this.generateSlotId(i);
      const slotPath = path.join(this.config.worktreeBaseDir, slotId);

      this.slots.set(slotId, {
        slotId,
        path: slotPath,
        state: 'available',
      });
    }

    // Recover orphaned worktrees if configured
    if (this.config.recoverOrphans) {
      await this.recoverOrphans();
    }

    this.initialized = true;
    this.emit('pool:initialized', {
      maxSize: this.config.maxSize,
      recoveredOrphans: this.config.recoverOrphans,
    });
  }

  /**
   * Generate a slot ID for the given index.
   */
  private generateSlotId(index: number): string {
    if (this.config.useThemedNames && index < this.config.themedNames.length) {
      return `slot-${this.config.themedNames[index]}`;
    }
    return `slot-${String(index + 1).padStart(2, '0')}`;
  }

  /**
   * Acquire a worktree from the pool.
   */
  async acquire(options: AcquireOptions): Promise<AllocationResult> {
    await this.ensureInitialized();

    const { agentId, role, strategy, timeout, preferredSlot } = options;
    const effectiveStrategy = strategy ?? this.config.defaultStrategy;

    // Check if agent already has a worktree
    const existingSlot = this.agentToSlot.get(agentId);
    if (existingSlot) {
      const worktree = this.slots.get(existingSlot);
      if (worktree) {
        return { success: true, worktree };
      }
    }

    // Try to find an available slot
    let slot = this.findAvailableSlot(preferredSlot);

    if (!slot) {
      // Pool exhausted - apply strategy
      switch (effectiveStrategy) {
        case 'reject':
          this.emit('pool:exhausted', { agentId, strategy: 'reject' });
          return {
            success: false,
            error: 'Pool exhausted: no available worktrees',
          };

        case 'queue':
          return this.queueRequest(agentId, role, timeout ?? 30000);

        case 'steal':
          slot = await this.stealWorktree(agentId);
          if (!slot) {
            return {
              success: false,
              error: 'Pool exhausted: unable to steal worktree',
            };
          }
          break;

        default:
          return {
            success: false,
            error: `Unknown strategy: ${effectiveStrategy}`,
          };
      }
    }

    // Allocate the slot
    return this.allocateSlot(slot, agentId, role);
  }

  /**
   * Find an available slot in the pool.
   */
  private findAvailableSlot(preferredSlot?: string): PooledWorktree | null {
    // Try preferred slot first
    if (preferredSlot) {
      const preferred = this.slots.get(preferredSlot);
      if (preferred?.state === 'available') {
        return preferred;
      }
    }

    // Find first available slot
    for (const slot of this.slots.values()) {
      if (slot.state === 'available') {
        return slot;
      }
    }

    return null;
  }

  /**
   * Queue a request for when a worktree becomes available.
   */
  private queueRequest(
    agentId: AgentId,
    role: WorkspaceRole,
    timeout: number
  ): Promise<AllocationResult> {
    return new Promise((resolve, reject) => {
      const request: QueuedRequest = {
        agentId,
        role,
        queuedAt: Date.now(),
        timeoutAt: Date.now() + timeout,
        resolve,
        reject,
      };

      this.waitQueue.push(request);
      this.emit('pool:exhausted', { agentId, strategy: 'queue', timeout });

      // Set timeout
      setTimeout(() => {
        const index = this.waitQueue.indexOf(request);
        if (index >= 0) {
          this.waitQueue.splice(index, 1);
          resolve({
            success: false,
            error: 'Allocation timed out while waiting in queue',
            queued: true,
          });
        }
      }, timeout);
    });
  }

  /**
   * Steal a worktree from another agent.
   */
  private async stealWorktree(requestingAgent: AgentId): Promise<PooledWorktree | null> {
    // Find the oldest allocated worktree that isn't being cleaned
    let oldest: PooledWorktree | null = null;
    let oldestTime = Infinity;

    for (const slot of this.slots.values()) {
      if (slot.state === 'allocated' && slot.allocatedAt && slot.allocatedAt < oldestTime) {
        oldest = slot;
        oldestTime = slot.allocatedAt;
      }
    }

    if (!oldest || !oldest.allocatedTo) return null;

    // Force release the oldest worktree
    const previousOwner = oldest.allocatedTo;
    await this.release(previousOwner, { force: true, clean: true });

    this.emit('pool:exhausted', {
      strategy: 'steal',
      requestingAgent,
      previousOwner,
      slotId: oldest.slotId,
    });

    // Re-fetch the slot after release
    return this.slots.get(oldest.slotId) ?? null;
  }

  /**
   * Allocate a slot to an agent.
   */
  private async allocateSlot(
    slot: PooledWorktree,
    agentId: AgentId,
    role: WorkspaceRole
  ): Promise<AllocationResult> {
    try {
      // Create the worktree if it doesn't exist (lazy creation)
      if (!fs.existsSync(slot.path)) {
        this.createWorktree(slot.path);
      }

      // Update slot state
      slot.state = 'allocated';
      slot.allocatedTo = agentId;
      slot.allocatedRole = role;
      slot.allocatedAt = Date.now();
      delete slot.error;

      // Track agent → slot mapping
      this.agentToSlot.set(agentId, slot.slotId);

      this.emit('worktree:acquired', {
        slotId: slot.slotId,
        agentId,
        role,
        path: slot.path,
      });

      return { success: true, worktree: slot };
    } catch (error) {
      slot.state = 'error';
      slot.error = error instanceof Error ? error.message : String(error);

      this.emit('worktree:error', {
        slotId: slot.slotId,
        error: slot.error,
      });

      return {
        success: false,
        error: `Failed to allocate worktree: ${slot.error}`,
      };
    }
  }

  /**
   * Create a git worktree at the specified path.
   */
  private createWorktree(worktreePath: string): void {
    // Create worktree with detached HEAD to avoid branch conflicts
    execSync(`git worktree add --detach "${worktreePath}"`, {
      cwd: this.repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /**
   * Release a worktree back to the pool.
   */
  async release(agentId: AgentId, options?: ReleaseOptions): Promise<void> {
    const slotId = this.agentToSlot.get(agentId);
    if (!slotId) return;

    const slot = this.slots.get(slotId);
    if (!slot) return;

    const shouldClean = options?.clean ?? true;
    const force = options?.force ?? false;

    // Check for uncommitted changes only if NOT cleaning (and not forcing)
    // If cleaning is enabled, the clean operation will handle uncommitted changes
    if (!force && !shouldClean) {
      try {
        const status = execSync('git status --porcelain', {
          cwd: slot.path,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (status.trim().length > 0) {
          throw new Error('Worktree has uncommitted changes');
        }
      } catch (error) {
        if (!force) {
          throw error;
        }
      }
    }

    // Clean the worktree if requested
    if (shouldClean) {
      slot.state = 'cleaning';
      try {
        await this.cleanWorktree(slot);
        this.emit('worktree:cleaned', { slotId: slot.slotId });
      } catch (error) {
        // Log but continue - the slot will still be released
        console.error(`[WorktreePool] Failed to clean worktree ${slotId}:`, error);
      }
    }

    // Update slot state
    slot.state = 'available';
    slot.allocatedTo = undefined;
    slot.allocatedRole = undefined;
    slot.allocatedAt = undefined;
    slot.lastReleasedAt = Date.now();
    delete slot.error;

    // Remove agent → slot mapping
    this.agentToSlot.delete(agentId);

    this.emit('worktree:released', {
      slotId: slot.slotId,
      agentId,
    });

    // Process wait queue
    this.processWaitQueue();
  }

  /**
   * Clean a worktree by resetting it to a clean state.
   */
  private async cleanWorktree(slot: PooledWorktree): Promise<void> {
    // Reset any changes
    execSync('git reset --hard HEAD', {
      cwd: slot.path,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Clean untracked files
    execSync('git clean -fd', {
      cwd: slot.path,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Checkout detached HEAD to avoid branch conflicts
    execSync('git checkout --detach HEAD', {
      cwd: slot.path,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /**
   * Process queued allocation requests.
   */
  private processWaitQueue(): void {
    if (this.waitQueue.length === 0) return;

    const slot = this.findAvailableSlot();
    if (!slot) return;

    // Get the oldest request that hasn't timed out
    const now = Date.now();
    while (this.waitQueue.length > 0) {
      const request = this.waitQueue.shift()!;

      if (request.timeoutAt < now) {
        // Request has timed out, skip it
        continue;
      }

      // Allocate to this request
      this.allocateSlot(slot, request.agentId, request.role)
        .then(request.resolve)
        .catch(request.reject);
      return;
    }
  }

  /**
   * Get the worktree allocated to an agent.
   */
  getWorktree(agentId: AgentId): PooledWorktree | null {
    const slotId = this.agentToSlot.get(agentId);
    if (!slotId) return null;
    return this.slots.get(slotId) ?? null;
  }

  /**
   * Get pool statistics.
   */
  getStats(): PoolStats {
    const stats: PoolStats = {
      totalSlots: this.slots.size,
      availableSlots: 0,
      allocatedSlots: 0,
      cleaningSlots: 0,
      errorSlots: 0,
      byRole: {
        worker: 0,
        integrator: 0,
        coordinator: 0,
        v3: 0,
      },
    };

    for (const slot of this.slots.values()) {
      switch (slot.state) {
        case 'available':
          stats.availableSlots++;
          break;
        case 'allocated':
          stats.allocatedSlots++;
          if (slot.allocatedRole) {
            stats.byRole[slot.allocatedRole]++;
          }
          break;
        case 'cleaning':
          stats.cleaningSlots++;
          break;
        case 'error':
          stats.errorSlots++;
          break;
      }
    }

    return stats;
  }

  /**
   * Recover orphaned worktrees.
   *
   * Scans the worktree base directory for existing worktrees that
   * aren't tracked by the pool and either reclaims or removes them.
   */
  async recoverOrphans(): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      orphansFound: 0,
      orphansCleaned: 0,
      errors: [],
      recoveredSlots: [],
    };

    if (!fs.existsSync(this.config.worktreeBaseDir)) {
      return result;
    }

    // List existing worktrees from git
    let gitWorktrees: string[] = [];
    try {
      const output = execSync('git worktree list --porcelain', {
        cwd: this.repoPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Parse worktree list output
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          const worktreePath = line.substring('worktree '.length);
          if (worktreePath.startsWith(this.config.worktreeBaseDir)) {
            gitWorktrees.push(worktreePath);
          }
        }
      }
    } catch (error) {
      console.error('[WorktreePool] Failed to list worktrees:', error);
    }

    // Also scan the filesystem for any directories in the base dir
    const entries = fs.readdirSync(this.config.worktreeBaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const fullPath = path.join(this.config.worktreeBaseDir, entry.name);

      // Check if this is a known slot
      const isKnownSlot = Array.from(this.slots.values()).some(s => s.path === fullPath);
      const isAllocated = Array.from(this.slots.values()).some(
        s => s.path === fullPath && s.state === 'allocated'
      );

      if (!isKnownSlot || !isAllocated) {
        // This is an orphan or an available slot with an existing worktree
        result.orphansFound++;

        try {
          // Try to match to a slot
          const matchingSlot = Array.from(this.slots.values()).find(s => s.path === fullPath);

          if (matchingSlot) {
            // Clean and mark as available
            await this.cleanWorktree(matchingSlot);
            matchingSlot.state = 'available';
            matchingSlot.allocatedTo = undefined;
            matchingSlot.allocatedRole = undefined;
            matchingSlot.allocatedAt = undefined;
            matchingSlot.lastReleasedAt = Date.now();
            result.orphansCleaned++;
            result.recoveredSlots.push(matchingSlot.slotId);
          } else {
            // Unknown worktree - remove it from git
            execSync(`git worktree remove --force "${fullPath}"`, {
              cwd: this.repoPath,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            result.orphansCleaned++;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.errors.push({ slotId: entry.name, error: errorMsg });
        }
      }
    }

    if (result.orphansFound > 0) {
      this.emit('pool:recovered', {
        orphansFound: result.orphansFound,
        orphansCleaned: result.orphansCleaned,
        recoveredSlots: result.recoveredSlots,
      });
    }

    return result;
  }

  /**
   * Subscribe to pool events.
   */
  onEvent(callback: PoolEventCallback): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /**
   * Emit a pool event.
   */
  private emit(type: PoolEventType, data: Record<string, unknown>): void {
    const event: PoolEvent = {
      type,
      timestamp: Date.now(),
      data,
    };

    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[WorktreePool] Event listener error:', error);
      }
    }
  }

  /**
   * Close the pool and release all resources.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Reject all queued requests
    for (const request of this.waitQueue) {
      request.reject(new Error('Pool is closing'));
    }
    this.waitQueue.length = 0;

    // Clear all mappings
    this.agentToSlot.clear();
    this.eventListeners.clear();

    // Note: We don't remove worktrees on close - they persist for recovery
  }
}
