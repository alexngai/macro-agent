/**
 * TaskDelegation - Task delegation pattern for distributed hierarchy
 *
 * Simplest relationship pattern - one macro-agent delegates discrete tasks
 * to another without establishing a persistent hierarchy.
 *
 * Features:
 * - Loose coupling (no persistent state beyond active tasks)
 * - Response modes: final-only or progress-updates
 * - Idempotent task IDs for safe retries
 */

import { nanoid } from "nanoid";
import type { PeerAddress } from "./types.js";
import type { PatternHandler, HierarchyResponse } from "./hierarchy-protocol.js";
import {
  capabilityDenied,
  taskRejected,
  taskTimeout,
  type HierarchyError,
} from "./hierarchy-errors.js";
import type { CapabilityManager } from "./capability-manager.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/**
 * Response mode for task delegation
 */
export type TaskResponseMode = "final-only" | "progress-updates";

/**
 * Task delegation request parameters
 */
export interface TaskDelegationParams {
  /** Caller-provided task ID for idempotency */
  taskId: string;
  /** Description of what to do */
  description: string;
  /** Additional context for the task */
  context?: Record<string, unknown>;
  /** Response mode */
  responseMode: TaskResponseMode;
  /** Timeout in ms (optional) */
  timeout?: number;
}

/**
 * Task delegation result (immediate acknowledgment)
 */
export interface TaskDelegationResult {
  /** Whether the task was accepted */
  accepted: boolean;
  /** Reason if not accepted */
  reason?: string;
}

/**
 * Task progress status
 */
export type TaskProgressStatus = "in_progress" | "checkpoint";

/**
 * Task progress update payload
 */
export interface TaskProgressPayload {
  /** Task ID */
  taskId: string;
  /** Progress status */
  status: TaskProgressStatus;
  /** Optional message */
  message?: string;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Checkpoint data for resumption */
  checkpoint?: unknown;
}

/**
 * Task completion status
 */
export type TaskCompletionStatus = "completed" | "failed";

/**
 * Task completion payload
 */
export interface TaskCompletePayload {
  /** Task ID */
  taskId: string;
  /** Completion status */
  status: TaskCompletionStatus;
  /** Result if completed successfully */
  result?: unknown;
  /** Error if failed */
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Internal task state
 */
export interface DelegatedTask {
  /** Task ID */
  taskId: string;
  /** Peer that delegated the task */
  fromPeerId: string;
  /** Task description */
  description: string;
  /** Task context */
  context?: Record<string, unknown>;
  /** Response mode */
  responseMode: TaskResponseMode;
  /** When the task was received */
  receivedAt: number;
  /** Timeout timestamp (if set) */
  timeoutAt?: number;
  /** Current status */
  status: "pending" | "in_progress" | "completed" | "failed";
}

/**
 * Outbound task state (for tracking delegated tasks)
 */
export interface OutboundTask {
  /** Task ID */
  taskId: string;
  /** Target peer ID */
  toPeerId: string;
  /** Response mode */
  responseMode: TaskResponseMode;
  /** When the task was sent */
  sentAt: number;
  /** Timeout timestamp */
  timeoutAt?: number;
  /** Progress callback (if progress-updates mode) */
  onProgress?: (progress: TaskProgressPayload) => void;
  /** Completion callback */
  onComplete: (result: TaskCompletePayload) => void;
  /** Timeout handle */
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * Callback for handling delegated tasks
 */
export type TaskDelegationCallback = (
  task: DelegatedTask
) => Promise<{ accepted: boolean; reason?: string }>;

// ─────────────────────────────────────────────────────────────────
// TaskDelegationManager
// ─────────────────────────────────────────────────────────────────

export interface TaskDelegationManagerConfig {
  /** Capability manager for permission checks */
  capabilityManager?: CapabilityManager;
  /** Default timeout for tasks in ms */
  defaultTimeout?: number;
  /** Maximum concurrent inbound tasks (optional) */
  maxConcurrentTasks?: number;
  /** Callback when a task is delegated to us */
  onTaskReceived?: TaskDelegationCallback;
}

export interface TaskDelegationManager {
  /**
   * Get the pattern handler for routing
   */
  getHandler(): PatternHandler;

  /**
   * Delegate a task to a peer
   */
  delegateTask(
    toPeerId: string,
    params: TaskDelegationParams,
    callbacks: {
      onProgress?: (progress: TaskProgressPayload) => void;
      onComplete: (result: TaskCompletePayload) => void;
    }
  ): Promise<TaskDelegationResult>;

  /**
   * Report progress on a task (as the delegatee)
   */
  reportProgress(taskId: string, progress: Omit<TaskProgressPayload, "taskId">): void;

  /**
   * Complete a task (as the delegatee)
   */
  completeTask(taskId: string, result: Omit<TaskCompletePayload, "taskId">): void;

  /**
   * Get a delegated task by ID
   */
  getTask(taskId: string): DelegatedTask | undefined;

  /**
   * List all active inbound tasks
   */
  listInboundTasks(): DelegatedTask[];

  /**
   * List all active outbound tasks
   */
  listOutboundTasks(): OutboundTask[];

  /**
   * Set the send functions (injected by PeerManager)
   */
  setSendFunctions(fns: {
    sendRequest: (to: PeerAddress, method: string, params: unknown) => Promise<HierarchyResponse>;
    sendMessage: (to: PeerAddress, type: string, payload: unknown) => Promise<void>;
  }): void;
}

/**
 * Create a TaskDelegationManager
 */
export function createTaskDelegationManager(
  config: TaskDelegationManagerConfig = {}
): TaskDelegationManager {
  const {
    capabilityManager,
    defaultTimeout = 300000, // 5 minutes default
    maxConcurrentTasks,
    onTaskReceived,
  } = config;

  // Inbound tasks (tasks delegated TO us)
  const inboundTasks = new Map<string, DelegatedTask>();

  // Outbound tasks (tasks we delegated)
  const outboundTasks = new Map<string, OutboundTask>();

  // Send functions (injected by PeerManager)
  let sendRequest: ((to: PeerAddress, method: string, params: unknown) => Promise<HierarchyResponse>) | null = null;
  let sendMessage: ((to: PeerAddress, type: string, payload: unknown) => Promise<void>) | null = null;

  /**
   * Set send functions
   */
  function setSendFunctions(fns: {
    sendRequest: (to: PeerAddress, method: string, params: unknown) => Promise<HierarchyResponse>;
    sendMessage: (to: PeerAddress, type: string, payload: unknown) => Promise<void>;
  }): void {
    sendRequest = fns.sendRequest;
    sendMessage = fns.sendMessage;
  }

  /**
   * Check if peer has task-delegation capability
   */
  function checkCapability(peerId: string): boolean {
    if (!capabilityManager) {
      return true; // No capability manager = no restrictions
    }
    return capabilityManager.hasCapability(peerId, { type: "task-delegation" });
  }

  /**
   * Handle incoming task/delegate request
   */
  async function handleDelegateRequest(
    from: PeerAddress,
    params: Record<string, unknown>
  ): Promise<HierarchyResponse> {
    const peerId = extractPeerId(from);

    // Check capability
    if (!checkCapability(peerId)) {
      return {
        error: capabilityDenied("task-delegation", peerId).toResponseError(),
      };
    }

    // Validate params
    const taskParams = params as unknown as TaskDelegationParams;
    if (!taskParams.taskId || !taskParams.description) {
      return {
        error: {
          code: 4005,
          message: "INVALID_REQUEST",
          data: { reason: "taskId and description are required" },
        },
      };
    }

    // Check for duplicate (idempotency)
    const existing = inboundTasks.get(taskParams.taskId);
    if (existing) {
      // Return success for idempotent retry
      return {
        result: { accepted: true, taskId: taskParams.taskId },
      };
    }

    // Check concurrent task limit
    if (maxConcurrentTasks !== undefined) {
      const activeTasks = Array.from(inboundTasks.values()).filter(
        (t) => t.status === "pending" || t.status === "in_progress"
      );
      if (activeTasks.length >= maxConcurrentTasks) {
        return {
          error: taskRejected(taskParams.taskId, "Maximum concurrent tasks reached").toResponseError(),
        };
      }
    }

    // Create task
    const task: DelegatedTask = {
      taskId: taskParams.taskId,
      fromPeerId: peerId,
      description: taskParams.description,
      context: taskParams.context,
      responseMode: taskParams.responseMode || "final-only",
      receivedAt: Date.now(),
      timeoutAt: taskParams.timeout ? Date.now() + taskParams.timeout : undefined,
      status: "pending",
    };

    // Store task
    inboundTasks.set(task.taskId, task);

    // Notify callback if provided
    if (onTaskReceived) {
      try {
        const result = await onTaskReceived(task);
        if (!result.accepted) {
          inboundTasks.delete(task.taskId);
          return {
            error: taskRejected(task.taskId, result.reason).toResponseError(),
          };
        }
      } catch (err) {
        inboundTasks.delete(task.taskId);
        return {
          error: taskRejected(task.taskId, err instanceof Error ? err.message : "Task rejected").toResponseError(),
        };
      }
    }

    return {
      result: { accepted: true, taskId: task.taskId },
    };
  }

  /**
   * Handle incoming task/progress message
   */
  function handleProgressMessage(
    from: PeerAddress,
    payload: Record<string, unknown>
  ): void {
    const progress = payload as unknown as TaskProgressPayload;
    const outbound = outboundTasks.get(progress.taskId);

    if (outbound && outbound.onProgress) {
      outbound.onProgress(progress);
    }
  }

  /**
   * Handle incoming task/complete message
   */
  function handleCompleteMessage(
    from: PeerAddress,
    payload: Record<string, unknown>
  ): void {
    const complete = payload as unknown as TaskCompletePayload;
    const outbound = outboundTasks.get(complete.taskId);

    if (outbound) {
      // Clear timeout
      if (outbound.timeoutHandle) {
        clearTimeout(outbound.timeoutHandle);
      }

      // Remove from tracking
      outboundTasks.delete(complete.taskId);

      // Notify callback
      outbound.onComplete(complete);
    }
  }

  /**
   * Delegate a task to a peer
   */
  async function delegateTask(
    toPeerId: string,
    params: TaskDelegationParams,
    callbacks: {
      onProgress?: (progress: TaskProgressPayload) => void;
      onComplete: (result: TaskCompletePayload) => void;
    }
  ): Promise<TaskDelegationResult> {
    if (!sendRequest) {
      throw new Error("TaskDelegationManager not connected to PeerManager");
    }

    // Send delegation request
    const response = await sendRequest(toPeerId, "task/delegate", params);

    if (response.error) {
      return { accepted: false, reason: response.error.message };
    }

    const result = response.result as { accepted: boolean; reason?: string };

    if (result.accepted) {
      // Track the outbound task
      const timeout = params.timeout || defaultTimeout;
      const outbound: OutboundTask = {
        taskId: params.taskId,
        toPeerId,
        responseMode: params.responseMode,
        sentAt: Date.now(),
        timeoutAt: Date.now() + timeout,
        onProgress: callbacks.onProgress,
        onComplete: callbacks.onComplete,
      };

      // Set up timeout
      outbound.timeoutHandle = setTimeout(() => {
        outboundTasks.delete(params.taskId);
        callbacks.onComplete({
          taskId: params.taskId,
          status: "failed",
          error: { code: 4004, message: "TASK_TIMEOUT" },
        });
      }, timeout);

      outboundTasks.set(params.taskId, outbound);
    }

    return result;
  }

  /**
   * Report progress on a task
   */
  function reportProgress(
    taskId: string,
    progress: Omit<TaskProgressPayload, "taskId">
  ): void {
    const task = inboundTasks.get(taskId);
    if (!task) {
      return;
    }

    // Only send progress if responseMode is progress-updates
    if (task.responseMode !== "progress-updates") {
      return;
    }

    // Update task status
    task.status = "in_progress";

    // Send progress message
    if (sendMessage) {
      sendMessage(task.fromPeerId, "task/progress", {
        taskId,
        ...progress,
      });
    }
  }

  /**
   * Complete a task
   */
  function completeTask(
    taskId: string,
    result: Omit<TaskCompletePayload, "taskId">
  ): void {
    const task = inboundTasks.get(taskId);
    if (!task) {
      return;
    }

    // Update task status
    task.status = result.status === "completed" ? "completed" : "failed";

    // Send completion message
    if (sendMessage) {
      sendMessage(task.fromPeerId, "task/complete", {
        taskId,
        ...result,
      });
    }

    // Remove from tracking after a delay (for idempotency)
    setTimeout(() => {
      inboundTasks.delete(taskId);
    }, 60000); // Keep for 1 minute for retries
  }

  /**
   * Get a delegated task by ID
   */
  function getTask(taskId: string): DelegatedTask | undefined {
    return inboundTasks.get(taskId);
  }

  /**
   * List all active inbound tasks
   */
  function listInboundTasks(): DelegatedTask[] {
    return Array.from(inboundTasks.values());
  }

  /**
   * List all active outbound tasks
   */
  function listOutboundTasks(): OutboundTask[] {
    return Array.from(outboundTasks.values());
  }

  /**
   * Pattern handler for routing
   */
  const handler: PatternHandler = {
    async handleRequest(
      from: PeerAddress,
      method: string,
      params: Record<string, unknown>
    ): Promise<HierarchyResponse> {
      switch (method) {
        case "task/delegate":
          return handleDelegateRequest(from, params);
        default:
          return {
            error: {
              code: 4005,
              message: "INVALID_REQUEST",
              data: { method, reason: "Unknown task method" },
            },
          };
      }
    },

    handleMessage(
      from: PeerAddress,
      type: string,
      payload: Record<string, unknown>
    ): void {
      switch (type) {
        case "task/progress":
          handleProgressMessage(from, payload);
          break;
        case "task/complete":
          handleCompleteMessage(from, payload);
          break;
      }
    },
  };

  function getHandler(): PatternHandler {
    return handler;
  }

  return {
    getHandler,
    delegateTask,
    reportProgress,
    completeTask,
    getTask,
    listInboundTasks,
    listOutboundTasks,
    setSendFunctions,
  };
}

// ─────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────

/**
 * Extract peer ID from address
 */
function extractPeerId(address: PeerAddress): string {
  const slashIndex = address.indexOf("/");
  return slashIndex === -1 ? address : address.substring(0, slashIndex);
}

/**
 * Generate a unique task ID
 */
export function generateTaskId(): string {
  return `task_${nanoid(12)}`;
}
