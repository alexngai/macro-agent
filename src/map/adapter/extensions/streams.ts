/**
 * Stream/Checkpoint/DiffStack/MergeQueue Extension Methods (_macro/streams/*, _macro/checkpoints/*, etc.)
 *
 * Exposes macro-agent's git-cascade stream, checkpoint, diff stack, and merge queue
 * features to external MAP clients (e.g., the OpenSwarm TUI).
 *
 * Methods:
 * - _macro/streams/list      - List streams with optional filters
 * - _macro/streams/get       - Get stream details with optional children
 * - _macro/streams/hierarchy - Get stream tree structure
 * - _macro/streams/createPR  - Create PR for entire stream branch
 * - _macro/checkpoints/list  - List checkpoints for a stream
 * - _macro/checkpoints/get   - Get checkpoint details
 * - _macro/checkpoints/select - Fork stream from a checkpoint
 * - _macro/diffStacks/list   - List diff stacks
 * - _macro/diffStacks/get    - Get diff stack with checkpoints
 * - _macro/diffStacks/create - Create diff stack from checkpoints
 * - _macro/diffStacks/createPR - Create PR from diff stack
 * - _macro/mergeQueue/status - Get merge queue status
 * - _macro/mergeQueue/get    - Get merge request details
 *
 * @see specs/s-2b92_stream_checkpoint_merge_queue_tui_integration.md
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { EventNotification } from "../types.js";
import type {
  Stream,
  StreamStatus,
  StreamNode,
  Checkpoint,
  DiffStack,
  DiffStackWithCheckpoints,
  DiffStackReviewStatus,
} from "git-cascade";
import type { MergeRequest } from "../../../workspace/merge-queue/types.js";
import { RPCError } from "../rpc-handler.js";
import { ulid } from "ulid";

/** Event emitter function type */
type EmitEvent = (event: EventNotification) => void;

// =============================================================================
// Error Codes
// =============================================================================

const STREAM_NOT_FOUND = -32040;
const CHECKPOINT_NOT_FOUND = -32041;
const DIFF_STACK_NOT_FOUND = -32042;
const MERGE_REQUEST_NOT_FOUND = -32043;

// =============================================================================
// Request Types
// =============================================================================

interface StreamListParams {
  filter?: {
    status?: string;
    agentId?: string;
    parentStream?: string;
  };
}

interface StreamGetParams {
  streamId: string;
  includeChildren?: boolean;
}

interface StreamHierarchyParams {
  streamId?: string;
}

interface StreamCreatePRParams {
  streamId: string;
  title?: string;
  body?: string;
  draft?: boolean;
  targetBranch?: string;
}

interface CheckpointListParams {
  streamId: string;
  limit?: number;
}

interface CheckpointGetParams {
  checkpointId: string;
}

interface CheckpointSelectParams {
  streamId: string;
  checkpointId: string;
  name?: string;
  agentId?: string;
}

interface DiffStackListParams {
  streamId?: string;
  reviewStatus?: string;
}

interface DiffStackGetParams {
  diffStackId: string;
}

interface DiffStackCreateParams {
  name: string;
  streamId: string;
  checkpointIds: string[];
  targetBranch: string;
  description?: string;
}

interface DiffStackCreatePRParams {
  diffStackId: string;
  title?: string;
  body?: string;
  draft?: boolean;
}

interface MergeQueueStatusParams {
  streamId?: string;
}

interface MergeQueueGetParams {
  requestId: string;
}

// =============================================================================
// Response Types
// =============================================================================

interface StreamInfo {
  id: string;
  name: string;
  agentId: string;
  status: string;
  parentStream: string | null;
  baseCommit: string;
  branchName: string;
  checkpointCount: number;
  latestCheckpoint?: string;
  createdAt: number;
  updatedAt: number;
}

interface StreamNodeInfo {
  stream: StreamInfo;
  children: StreamNodeInfo[];
  taskCount: number;
}

interface CheckpointInfo {
  id: string;
  streamId: string;
  commitSha: string;
  commitShaShort: string;
  parentCommit: string | null;
  changeId: string | null;
  message: string | null;
  createdAt: number;
  createdBy: string | null;
}

interface DiffStackInfo {
  id: string;
  name: string | null;
  description: string | null;
  targetBranch: string;
  reviewStatus: string;
  queuePosition: number | null;
  checkpointCount?: number;
  createdAt: number;
  createdBy: string | null;
}

interface MergeRequestInfo {
  id: string;
  streamId: string;
  taskId: string;
  workerBranch: string;
  workerAgentId: string;
  status: string;
  priority: number;
  position: number;
  submittedAt: number;
  startedAt?: number;
  completedAt?: number;
  mergeCommit?: string;
  conflictFiles?: string[];
  resolverTaskId?: string;
}

interface PRResult {
  prUrl: string;
  prNumber: number;
}

// =============================================================================
// Extension Services
// =============================================================================

/**
 * Services required for stream/checkpoint/diffStack/mergeQueue extensions.
 *
 * The combined-server.ts binds these to DataplaneAdapter and git-cascade operations.
 */
export interface StreamExtensionServices {
  // Stream operations (DataplaneAdapter methods)
  getStream: (streamId: string) => Stream | null;
  listStreams: (options?: { agentId?: string; status?: StreamStatus }) => Stream[];
  getStreamBranchName: (streamId: string) => string;
  getStreamHierarchy: (rootStreamId?: string) => StreamNode | StreamNode[];

  // Checkpoint operations (git-cascade checkpoints module)
  getCheckpoint: (checkpointId: string) => Checkpoint | null;
  getCheckpointsForStream: (streamId: string) => Checkpoint[];

  // Checkpoint selection (git-cascade streams.forkFromCheckpoint)
  forkFromCheckpoint: (options: {
    checkpointId: string;
    name?: string;
    agentId: string;
  }) => string;

  // DiffStack operations (git-cascade diffStacks module)
  getDiffStack: (diffStackId: string) => DiffStack | null;
  getDiffStackWithCheckpoints: (diffStackId: string) => DiffStackWithCheckpoints | null;
  listDiffStacks: (options?: { reviewStatus?: DiffStackReviewStatus; targetBranch?: string }) => DiffStack[];
  createDiffStack: (options: { name?: string; targetBranch?: string; description?: string; createdBy?: string }) => DiffStack;
  addCheckpointToStack: (options: { stackId: string; checkpointId: string; position?: number }) => void;

  // Merge queue operations (read-only)
  getMergeQueueRequests: (streamId?: string) => MergeRequest[];
  getMergeQueueDepth: (streamId?: string) => number;
  getMergeRequest: (requestId: string) => MergeRequest | null;

  // PR creation
  createPR: (options: {
    branch: string;
    targetBranch: string;
    title: string;
    body?: string;
    draft?: boolean;
  }) => Promise<PRResult>;
}

// =============================================================================
// Conversion Helpers
// =============================================================================

function streamToInfo(
  stream: Stream,
  branchName: string,
  checkpointCount: number,
  latestCheckpoint?: string,
): StreamInfo {
  return {
    id: stream.id,
    name: stream.name,
    agentId: stream.agentId,
    status: stream.status,
    parentStream: stream.parentStream,
    baseCommit: stream.baseCommit,
    branchName,
    checkpointCount,
    latestCheckpoint,
    createdAt: stream.createdAt,
    updatedAt: stream.updatedAt,
  };
}

function streamNodeToInfo(
  node: StreamNode,
  services: StreamExtensionServices,
): StreamNodeInfo {
  const checkpoints = services.getCheckpointsForStream(node.stream.id);
  const latestCp = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : undefined;
  let branchName: string;
  try {
    branchName = services.getStreamBranchName(node.stream.id);
  } catch {
    branchName = `stream/${node.stream.id}`;
  }

  return {
    stream: streamToInfo(
      node.stream,
      branchName,
      checkpoints.length,
      latestCp?.commitSha?.slice(0, 8),
    ),
    children: node.children.map((child) => streamNodeToInfo(child, services)),
    taskCount: node.tasks.length,
  };
}

function checkpointToInfo(cp: Checkpoint): CheckpointInfo {
  return {
    id: cp.id,
    streamId: cp.streamId,
    commitSha: cp.commitSha,
    commitShaShort: cp.commitSha.slice(0, 8),
    parentCommit: cp.parentCommit,
    changeId: cp.changeId,
    message: cp.message,
    createdAt: cp.createdAt,
    createdBy: cp.createdBy,
  };
}

function diffStackToInfo(ds: DiffStack, checkpointCount?: number): DiffStackInfo {
  return {
    id: ds.id,
    name: ds.name,
    description: ds.description,
    targetBranch: ds.targetBranch,
    reviewStatus: ds.reviewStatus,
    queuePosition: ds.queuePosition,
    checkpointCount,
    createdAt: ds.createdAt,
    createdBy: ds.createdBy,
  };
}

function mergeRequestToInfo(mr: MergeRequest): MergeRequestInfo {
  return {
    id: mr.id,
    streamId: mr.streamId,
    taskId: mr.taskId,
    workerBranch: mr.workerBranch,
    workerAgentId: mr.workerAgentId,
    status: mr.status,
    priority: mr.priority,
    position: mr.position ?? 0,
    submittedAt: mr.submittedAt,
    startedAt: mr.startedAt ?? undefined,
    completedAt: mr.completedAt ?? undefined,
    mergeCommit: mr.mergeCommit ?? undefined,
    conflictFiles: mr.conflictFiles ?? undefined,
    resolverTaskId: mr.resolverTaskId ?? undefined,
  };
}

// =============================================================================
// Stream Handlers
// =============================================================================

function createStreamListHandler(services: StreamExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { filter } = (params ?? {}) as StreamListParams;

    const streams = services.listStreams(
      filter
        ? {
            agentId: filter.agentId,
            status: filter.status as StreamStatus | undefined,
          }
        : undefined,
    );

    const results: StreamInfo[] = streams.map((stream) => {
      const checkpoints = services.getCheckpointsForStream(stream.id);
      const latestCp = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : undefined;
      let branchName: string;
      try {
        branchName = services.getStreamBranchName(stream.id);
      } catch {
        branchName = `stream/${stream.id}`;
      }
      return streamToInfo(stream, branchName, checkpoints.length, latestCp?.commitSha?.slice(0, 8));
    });

    // Optional parentStream filter (not in git-cascade's listStreams options)
    const filtered = filter?.parentStream
      ? results.filter((s) => s.parentStream === filter.parentStream)
      : results;

    return { streams: filtered };
  };
}

function createStreamGetHandler(services: StreamExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { streamId, includeChildren } = params as StreamGetParams;

    if (!streamId) {
      throw RPCError.invalidParams("streamId is required");
    }

    const stream = services.getStream(streamId);
    if (!stream) {
      throw new RPCError(STREAM_NOT_FOUND, `Stream not found: ${streamId}`);
    }

    const checkpoints = services.getCheckpointsForStream(streamId);
    const latestCp = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : undefined;
    let branchName: string;
    try {
      branchName = services.getStreamBranchName(streamId);
    } catch {
      branchName = `stream/${streamId}`;
    }

    const result: Record<string, unknown> = {
      stream: streamToInfo(stream, branchName, checkpoints.length, latestCp?.commitSha?.slice(0, 8)),
    };

    if (includeChildren) {
      const hierarchy = services.getStreamHierarchy(streamId);
      const node = Array.isArray(hierarchy) ? hierarchy[0] : hierarchy;
      if (node) {
        result.children = node.children.map((child) => {
          const childCps = services.getCheckpointsForStream(child.stream.id);
          const childLatest = childCps.length > 0 ? childCps[childCps.length - 1] : undefined;
          let childBranch: string;
          try {
            childBranch = services.getStreamBranchName(child.stream.id);
          } catch {
            childBranch = `stream/${child.stream.id}`;
          }
          return streamToInfo(child.stream, childBranch, childCps.length, childLatest?.commitSha?.slice(0, 8));
        });
      }
    }

    return result;
  };
}

function createStreamHierarchyHandler(services: StreamExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { streamId } = (params ?? {}) as StreamHierarchyParams;

    const hierarchy = services.getStreamHierarchy(streamId);
    const nodes = Array.isArray(hierarchy) ? hierarchy : [hierarchy];

    return {
      roots: nodes.map((node) => streamNodeToInfo(node, services)),
    };
  };
}

function createStreamCreatePRHandler(services: StreamExtensionServices, emit: EmitEvent): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { streamId, title, body, draft, targetBranch } = params as StreamCreatePRParams;

    if (!streamId) {
      throw RPCError.invalidParams("streamId is required");
    }

    const stream = services.getStream(streamId);
    if (!stream) {
      throw new RPCError(STREAM_NOT_FOUND, `Stream not found: ${streamId}`);
    }

    let branchName: string;
    try {
      branchName = services.getStreamBranchName(streamId);
    } catch {
      branchName = `stream/${streamId}`;
    }

    const result = await services.createPR({
      branch: branchName,
      targetBranch: targetBranch ?? "main",
      title: title ?? `Merge stream: ${stream.name}`,
      body,
      draft,
    });

    emit({
      eventId: ulid(),
      type: "stream.updated",
      timestamp: Date.now(),
      data: { streamId, action: "pr_created", result },
    });

    return result;
  };
}

// =============================================================================
// Checkpoint Handlers
// =============================================================================

function createCheckpointListHandler(services: StreamExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { streamId, limit } = params as CheckpointListParams;

    if (!streamId) {
      throw RPCError.invalidParams("streamId is required");
    }

    const stream = services.getStream(streamId);
    if (!stream) {
      throw new RPCError(STREAM_NOT_FOUND, `Stream not found: ${streamId}`);
    }

    let checkpoints = services.getCheckpointsForStream(streamId);

    if (limit && limit > 0) {
      checkpoints = checkpoints.slice(-limit);
    }

    return { checkpoints: checkpoints.map(checkpointToInfo) };
  };
}

function createCheckpointGetHandler(services: StreamExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { checkpointId } = params as CheckpointGetParams;

    if (!checkpointId) {
      throw RPCError.invalidParams("checkpointId is required");
    }

    const checkpoint = services.getCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new RPCError(CHECKPOINT_NOT_FOUND, `Checkpoint not found: ${checkpointId}`);
    }

    return { checkpoint: checkpointToInfo(checkpoint) };
  };
}

function createCheckpointSelectHandler(services: StreamExtensionServices, emit: EmitEvent): ExtensionHandler {
  return async (context: ExtensionContext, params: unknown) => {
    const { streamId, checkpointId, name, agentId } = params as CheckpointSelectParams;

    if (!streamId) {
      throw RPCError.invalidParams("streamId is required");
    }
    if (!checkpointId) {
      throw RPCError.invalidParams("checkpointId is required");
    }

    // Verify stream exists
    const stream = services.getStream(streamId);
    if (!stream) {
      throw new RPCError(STREAM_NOT_FOUND, `Stream not found: ${streamId}`);
    }

    // Verify checkpoint exists and belongs to stream
    const checkpoint = services.getCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new RPCError(CHECKPOINT_NOT_FOUND, `Checkpoint not found: ${checkpointId}`);
    }
    if (checkpoint.streamId !== streamId) {
      throw RPCError.invalidParams(
        `Checkpoint ${checkpointId} does not belong to stream ${streamId}`,
      );
    }

    const forkAgentId = agentId ?? `external:${context.participantId}`;

    const newStreamId = services.forkFromCheckpoint({
      checkpointId,
      name: name ?? `fork-from-${checkpointId.slice(0, 8)}`,
      agentId: forkAgentId,
    });

    emit({
      eventId: ulid(),
      type: "stream.updated",
      timestamp: Date.now(),
      data: { streamId, newStreamId, action: "forked", checkpointId },
    });

    return {
      success: true,
      newStreamId,
      commitSha: checkpoint.commitSha,
    };
  };
}

// =============================================================================
// DiffStack Handlers
// =============================================================================

function createDiffStackListHandler(services: StreamExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { streamId, reviewStatus } = (params ?? {}) as DiffStackListParams;

    let stacks = services.listDiffStacks({
      reviewStatus: reviewStatus as DiffStackReviewStatus | undefined,
    });

    // Filter by streamId if provided (need to check checkpoints in each stack)
    if (streamId) {
      const streamCheckpoints = new Set(
        services.getCheckpointsForStream(streamId).map((cp) => cp.id),
      );
      stacks = stacks.filter((stack) => {
        const withCps = services.getDiffStackWithCheckpoints(stack.id);
        if (!withCps) return false;
        return withCps.checkpoints.some((cp) => streamCheckpoints.has(cp.id));
      });
    }

    const results = stacks.map((stack) => {
      const withCps = services.getDiffStackWithCheckpoints(stack.id);
      return diffStackToInfo(stack, withCps?.checkpoints.length ?? 0);
    });

    return { diffStacks: results };
  };
}

function createDiffStackGetHandler(services: StreamExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { diffStackId } = params as DiffStackGetParams;

    if (!diffStackId) {
      throw RPCError.invalidParams("diffStackId is required");
    }

    const withCheckpoints = services.getDiffStackWithCheckpoints(diffStackId);
    if (!withCheckpoints) {
      throw new RPCError(DIFF_STACK_NOT_FOUND, `DiffStack not found: ${diffStackId}`);
    }

    return {
      diffStack: diffStackToInfo(withCheckpoints, withCheckpoints.checkpoints.length),
      checkpoints: withCheckpoints.checkpoints.map(checkpointToInfo),
    };
  };
}

function createDiffStackCreateHandler(services: StreamExtensionServices, emit: EmitEvent): ExtensionHandler {
  return async (context: ExtensionContext, params: unknown) => {
    const { name, streamId, checkpointIds, targetBranch, description } =
      params as DiffStackCreateParams;

    if (!name) {
      throw RPCError.invalidParams("name is required");
    }
    if (!checkpointIds || checkpointIds.length === 0) {
      throw RPCError.invalidParams("checkpointIds is required and must not be empty");
    }
    if (!targetBranch) {
      throw RPCError.invalidParams("targetBranch is required");
    }

    // Verify all checkpoints exist
    for (const cpId of checkpointIds) {
      const cp = services.getCheckpoint(cpId);
      if (!cp) {
        throw new RPCError(CHECKPOINT_NOT_FOUND, `Checkpoint not found: ${cpId}`);
      }
    }

    const createdBy = `external:${context.participantId}`;

    // Create the stack
    const stack = services.createDiffStack({
      name,
      targetBranch,
      description,
      createdBy,
    });

    // Add checkpoints to the stack
    for (let i = 0; i < checkpointIds.length; i++) {
      services.addCheckpointToStack({
        stackId: stack.id,
        checkpointId: checkpointIds[i],
        position: i,
      });
    }

    // Return the stack with checkpoints
    const withCps = services.getDiffStackWithCheckpoints(stack.id);

    emit({
      eventId: ulid(),
      type: "diffstack.created",
      timestamp: Date.now(),
      data: { diffStackId: stack.id, name, checkpointCount: checkpointIds.length },
    });

    return {
      diffStack: diffStackToInfo(stack, withCps?.checkpoints.length ?? checkpointIds.length),
    };
  };
}

function createDiffStackCreatePRHandler(services: StreamExtensionServices, emit: EmitEvent): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { diffStackId, title, body, draft } = params as DiffStackCreatePRParams;

    if (!diffStackId) {
      throw RPCError.invalidParams("diffStackId is required");
    }

    const withCheckpoints = services.getDiffStackWithCheckpoints(diffStackId);
    if (!withCheckpoints) {
      throw new RPCError(DIFF_STACK_NOT_FOUND, `DiffStack not found: ${diffStackId}`);
    }

    if (withCheckpoints.checkpoints.length === 0) {
      throw RPCError.invalidParams("DiffStack has no checkpoints");
    }

    // Determine branch name from the first checkpoint's stream
    const firstCp = withCheckpoints.checkpoints[0];
    let branchName: string;
    try {
      branchName = services.getStreamBranchName(firstCp.streamId);
    } catch {
      branchName = `stream/${firstCp.streamId}`;
    }

    const result = await services.createPR({
      branch: branchName,
      targetBranch: withCheckpoints.targetBranch,
      title: title ?? `PR: ${withCheckpoints.name ?? diffStackId}`,
      body,
      draft,
    });

    emit({
      eventId: ulid(),
      type: "diffstack.updated",
      timestamp: Date.now(),
      data: { diffStackId, action: "pr_created", result },
    });

    return result;
  };
}

// =============================================================================
// MergeQueue Handlers
// =============================================================================

function createMergeQueueStatusHandler(services: StreamExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { streamId } = (params ?? {}) as MergeQueueStatusParams;

    const requests = services.getMergeQueueRequests(streamId);
    const queueDepth = services.getMergeQueueDepth(streamId);

    return {
      requests: requests.map(mergeRequestToInfo),
      queueDepth,
    };
  };
}

function createMergeQueueGetHandler(services: StreamExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { requestId } = params as MergeQueueGetParams;

    if (!requestId) {
      throw RPCError.invalidParams("requestId is required");
    }

    const request = services.getMergeRequest(requestId);
    if (!request) {
      throw new RPCError(MERGE_REQUEST_NOT_FOUND, `Merge request not found: ${requestId}`);
    }

    return { request: mergeRequestToInfo(request) };
  };
}

// =============================================================================
// Registration
// =============================================================================

/** All stream-related extension method names */
export const STREAM_EXTENSION_METHODS = [
  "_macro/streams/list",
  "_macro/streams/get",
  "_macro/streams/hierarchy",
  "_macro/streams/createPR",
  "_macro/checkpoints/list",
  "_macro/checkpoints/get",
  "_macro/checkpoints/select",
  "_macro/diffStacks/list",
  "_macro/diffStacks/get",
  "_macro/diffStacks/create",
  "_macro/diffStacks/createPR",
  "_macro/mergeQueue/status",
  "_macro/mergeQueue/get",
] as const;

/**
 * Register all stream/checkpoint/diffStack/mergeQueue extension methods.
 *
 * @param adapter - MAPAdapter instance
 * @param services - Stream extension services
 */
export function registerStreamExtensions(
  adapter: MAPAdapter,
  services: StreamExtensionServices,
): void {
  const emit: EmitEvent = (event) => adapter.emitEvent(event);

  // Stream queries (canQuery)
  adapter.registerExtension("_macro/streams/list", createStreamListHandler(services));
  adapter.registerExtension("_macro/streams/get", createStreamGetHandler(services));
  adapter.registerExtension("_macro/streams/hierarchy", createStreamHierarchyHandler(services));

  // Stream PR (canManageTasks)
  adapter.registerExtension("_macro/streams/createPR", createStreamCreatePRHandler(services, emit));

  // Checkpoint queries (canQuery)
  adapter.registerExtension("_macro/checkpoints/list", createCheckpointListHandler(services));
  adapter.registerExtension("_macro/checkpoints/get", createCheckpointGetHandler(services));

  // Checkpoint select (canManageTasks)
  adapter.registerExtension("_macro/checkpoints/select", createCheckpointSelectHandler(services, emit));

  // DiffStack queries (canQuery)
  adapter.registerExtension("_macro/diffStacks/list", createDiffStackListHandler(services));
  adapter.registerExtension("_macro/diffStacks/get", createDiffStackGetHandler(services));

  // DiffStack management (canManageTasks)
  adapter.registerExtension("_macro/diffStacks/create", createDiffStackCreateHandler(services, emit));
  adapter.registerExtension("_macro/diffStacks/createPR", createDiffStackCreatePRHandler(services, emit));

  // MergeQueue queries (canQuery)
  adapter.registerExtension("_macro/mergeQueue/status", createMergeQueueStatusHandler(services));
  adapter.registerExtension("_macro/mergeQueue/get", createMergeQueueGetHandler(services));
}

/**
 * Unregister all stream/checkpoint/diffStack/mergeQueue extension methods.
 *
 * @param adapter - MAPAdapter instance
 */
export function unregisterStreamExtensions(adapter: MAPAdapter): void {
  for (const method of STREAM_EXTENSION_METHODS) {
    adapter.unregisterExtension(method);
  }
}
