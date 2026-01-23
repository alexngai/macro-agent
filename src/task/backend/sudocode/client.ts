/**
 * SudocodeClient Interface
 *
 * Abstracts over deployment modes (managed vs standalone) for sudocode integration.
 * This interface is the foundation for all sudocode interactions in the task backend.
 *
 * @module task/backend/sudocode/client
 * @see s-8472 Pluggable Task Backend Integration with Sudocode
 */

// =============================================================================
// Re-export Sudocode Types
// =============================================================================

// We re-export the core sudocode types that we use in the client interface.
// These come from the sudocode types package.
export type {
  Issue,
  IssueStatus,
  Spec,
  Relationship,
  RelationshipType,
  EntityType,
  IssueFeedback,
  FeedbackType,
  FeedbackAnchor,
} from "../../../../references/sudocode/types/src/index.js";

// =============================================================================
// Client Configuration Types
// =============================================================================

/**
 * Deployment mode for sudocode client
 *
 * - `managed`: Connect to sudocode server via REST + WebSocket
 * - `standalone`: Direct file/CLI access without server
 * - `auto`: Auto-detect based on server availability
 */
export type SudocodeClientMode = "managed" | "standalone" | "auto";

/**
 * Configuration for creating a SudocodeClient
 */
export interface SudocodeClientConfig {
  /** Deployment mode */
  mode: SudocodeClientMode;

  /** Server URL for managed mode (default: 'http://localhost:3001') */
  serverUrl?: string;

  /** WebSocket URL for managed mode (derived from serverUrl if not specified) */
  wsUrl?: string;

  /** Path to project root for standalone mode (default: process.cwd()) */
  projectPath?: string;

  /** Options for auto-detection mode */
  autoDetect?: AutoDetectOptions;
}

/**
 * Options for auto-detection of deployment mode
 */
export interface AutoDetectOptions {
  /** URL to check for running server (default: 'http://localhost:3001') */
  serverUrl?: string;

  /** Detection timeout in milliseconds (default: 2000) */
  timeout?: number;

  /** If both modes available, prefer managed (default: true) */
  preferManaged?: boolean;
}

/**
 * Configuration for ServerClient (managed mode)
 */
export interface ServerClientConfig {
  /** Server URL (e.g., 'http://localhost:3001') */
  serverUrl: string;

  /** WebSocket URL (e.g., 'ws://localhost:3001/ws') */
  wsUrl?: string;

  /** Project ID for multi-project servers */
  projectId?: string;
}

/**
 * Configuration for StandaloneClient (standalone mode)
 */
export interface StandaloneClientConfig {
  /** Path to project root (contains .sudocode/) */
  projectPath: string;

  /** Fallback polling interval in ms (default: 5000) */
  pollInterval?: number;
}

// =============================================================================
// Filter and Input Types
// =============================================================================

/**
 * Options for listing issues
 */
export interface ListIssuesOptions {
  /** Filter by status */
  status?: import("../../../../references/sudocode/types/src/index.js").IssueStatus;

  /** Filter by priority (0=highest, 4=lowest) */
  priority?: number;

  /** Search text in title/content */
  search?: string;

  /** Include archived issues (default: false) */
  archived?: boolean;

  /** Maximum results to return (default: 50) */
  limit?: number;
}

/**
 * Options for listing specs
 */
export interface ListSpecsOptions {
  /** Search text in title/content */
  search?: string;

  /** Maximum results to return (default: 50) */
  limit?: number;
}

/**
 * Input for updating an issue
 */
export interface UpdateIssueInput {
  /** Update title */
  title?: string;

  /** Update content/description */
  content?: string;

  /** Update status */
  status?: import("../../../../references/sudocode/types/src/index.js").IssueStatus;

  /** Update priority */
  priority?: number;

  /** Update assignee */
  assignee?: string | null;

  /** Archive/unarchive */
  archived?: boolean;
}

/**
 * Input for adding feedback to a spec or issue
 */
export interface FeedbackInput {
  /** Feedback type */
  type: import("../../../../references/sudocode/types/src/index.js").FeedbackType;

  /** Feedback content */
  content: string;

  /** Optional agent identifier */
  agent?: string;

  /** Optional anchor to specific location */
  anchor?: {
    /** Line number to anchor to */
    line?: number;
    /** Text snippet to anchor to */
    text?: string;
  };
}

// =============================================================================
// Event Types
// =============================================================================

/**
 * Types of issue change events
 */
export type IssueChangeType =
  | "created"
  | "updated"
  | "deleted"
  | "status_changed"
  | "blocked"
  | "unblocked";

/**
 * Issue change event emitted when an issue changes
 */
export interface IssueChangeEvent {
  /** Type of change */
  type: IssueChangeType;

  /** Issue ID that changed */
  issueId: string;

  /** Current issue state (undefined if deleted) */
  issue?: import("../../../../references/sudocode/types/src/index.js").Issue;

  /** Previous issue state (for updates) */
  previousIssue?: import("../../../../references/sudocode/types/src/index.js").Issue;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Callback for issue change events
 */
export type IssueChangeCallback = (event: IssueChangeEvent) => void;

/**
 * Unsubscribe function returned by event subscriptions
 */
export type Unsubscribe = () => void;

// =============================================================================
// SudocodeClient Interface
// =============================================================================

/**
 * SudocodeClient Interface
 *
 * Abstracts over deployment modes for sudocode access:
 * - ServerClient: REST + WebSocket for managed mode
 * - StandaloneClient: CLI + file watcher for standalone mode
 *
 * @example
 * ```typescript
 * const client = await createSudocodeClient({
 *   mode: 'auto',
 *   serverUrl: 'http://localhost:3001',
 *   projectPath: process.cwd(),
 * });
 *
 * const issue = await client.getIssue('i-abc123');
 * const ready = await client.getReadyIssues();
 *
 * client.onIssueChange((event) => {
 *   console.log('Issue changed:', event.issueId, event.type);
 * });
 * ```
 */
export interface SudocodeClient {
  // ─── Issue Operations ────────────────────────────────────────────────────────

  /**
   * Get an issue by ID
   * @param id Issue ID (e.g., 'i-abc123')
   * @returns Issue or null if not found
   */
  getIssue(
    id: string
  ): Promise<import("../../../../references/sudocode/types/src/index.js").Issue | null>;

  /**
   * List issues with optional filtering
   * @param filter Optional filter options
   * @returns Array of issues matching filter
   */
  listIssues(
    filter?: ListIssuesOptions
  ): Promise<import("../../../../references/sudocode/types/src/index.js").Issue[]>;

  /**
   * Get issues that are ready to work on (no blocking dependencies)
   * @returns Array of ready issues
   */
  getReadyIssues(): Promise<
    import("../../../../references/sudocode/types/src/index.js").Issue[]
  >;

  /**
   * Update an issue
   * @param id Issue ID
   * @param updates Fields to update
   * @returns Updated issue
   */
  updateIssue(
    id: string,
    updates: UpdateIssueInput
  ): Promise<import("../../../../references/sudocode/types/src/index.js").Issue>;

  // ─── Relationship Operations ─────────────────────────────────────────────────

  /**
   * Create a relationship between two entities
   * @param from Source entity ID (issue or spec)
   * @param to Target entity ID (issue or spec)
   * @param type Relationship type
   */
  createLink(
    from: string,
    to: string,
    type: import("../../../../references/sudocode/types/src/index.js").RelationshipType
  ): Promise<void>;

  /**
   * Remove a relationship between two entities
   * @param from Source entity ID
   * @param to Target entity ID
   * @param type Relationship type
   */
  removeLink(
    from: string,
    to: string,
    type: import("../../../../references/sudocode/types/src/index.js").RelationshipType
  ): Promise<void>;

  /**
   * Get issues that block a given issue
   * @param issueId Issue ID to check
   * @returns Array of blocking issues
   */
  getBlockers(
    issueId: string
  ): Promise<import("../../../../references/sudocode/types/src/index.js").Issue[]>;

  /**
   * Get issues that a given issue blocks
   * @param issueId Issue ID to check
   * @returns Array of issues blocked by this issue
   */
  getBlocking(
    issueId: string
  ): Promise<import("../../../../references/sudocode/types/src/index.js").Issue[]>;

  // ─── Spec Operations (read-only) ─────────────────────────────────────────────

  /**
   * Get a spec by ID
   * @param id Spec ID (e.g., 's-abc123')
   * @returns Spec or null if not found
   */
  getSpec(
    id: string
  ): Promise<import("../../../../references/sudocode/types/src/index.js").Spec | null>;

  /**
   * List specs with optional filtering
   * @param filter Optional filter options
   * @returns Array of specs matching filter
   */
  listSpecs(
    filter?: ListSpecsOptions
  ): Promise<import("../../../../references/sudocode/types/src/index.js").Spec[]>;

  // ─── Feedback Operations ─────────────────────────────────────────────────────

  /**
   * Add feedback to a spec or issue
   * @param fromIssueId Issue ID providing the feedback (optional for anonymous)
   * @param toId Target spec or issue ID receiving feedback
   * @param feedback Feedback content and metadata
   */
  addFeedback(
    fromIssueId: string | undefined,
    toId: string,
    feedback: FeedbackInput
  ): Promise<void>;

  // ─── Event Subscription ──────────────────────────────────────────────────────

  /**
   * Subscribe to all issue changes
   * @param callback Callback invoked on each change
   * @returns Unsubscribe function
   */
  onIssueChange(callback: IssueChangeCallback): Unsubscribe;

  /**
   * Subscribe to changes for a specific issue
   * @param issueId Issue ID to watch
   * @param callback Callback invoked on changes to this issue
   * @returns Unsubscribe function
   */
  onIssueChange(issueId: string, callback: IssueChangeCallback): Unsubscribe;

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Check if the client is connected/ready
   * @returns True if client is ready for operations
   */
  isReady(): boolean;

  /**
   * Close the client and release resources
   */
  close(): void;
}

// =============================================================================
// Client Factory
// =============================================================================

/**
 * Default configuration values
 */
export const DEFAULT_CLIENT_CONFIG: Required<
  Omit<SudocodeClientConfig, "mode">
> = {
  serverUrl: "http://localhost:3001",
  wsUrl: "ws://localhost:3001/ws",
  projectPath: process.cwd(),
  autoDetect: {
    serverUrl: "http://localhost:3001",
    timeout: 2000,
    preferManaged: true,
  },
};

/**
 * Check if a sudocode server is available at the given URL
 * @param serverUrl Server URL to check
 * @param timeout Timeout in milliseconds
 * @returns True if server is available
 */
export async function checkServerHealth(
  serverUrl: string,
  timeout: number = 2000
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${serverUrl}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Create a SudocodeClient based on configuration
 *
 * @param config Client configuration
 * @returns Configured SudocodeClient
 *
 * @example
 * ```typescript
 * // Auto-detect mode
 * const client = await createSudocodeClient({ mode: 'auto' });
 *
 * // Explicit managed mode
 * const serverClient = await createSudocodeClient({
 *   mode: 'managed',
 *   serverUrl: 'http://localhost:3001',
 * });
 *
 * // Explicit standalone mode
 * const standaloneClient = await createSudocodeClient({
 *   mode: 'standalone',
 *   projectPath: '/path/to/project',
 * });
 * ```
 */
export async function createSudocodeClient(
  config: SudocodeClientConfig
): Promise<SudocodeClient> {
  const {
    mode,
    serverUrl = DEFAULT_CLIENT_CONFIG.serverUrl,
    wsUrl,
    projectPath = DEFAULT_CLIENT_CONFIG.projectPath,
    autoDetect = DEFAULT_CLIENT_CONFIG.autoDetect,
  } = config;

  if (mode === "managed") {
    // Import and create ServerClient
    const { ServerClient } = await import("./server-client.js");
    return new ServerClient({
      serverUrl,
      wsUrl: wsUrl ?? serverUrl.replace(/^http/, "ws") + "/ws",
    });
  }

  if (mode === "standalone") {
    // Import and create StandaloneClient
    const { StandaloneClient } = await import("./standalone-client.js");
    return new StandaloneClient({ projectPath });
  }

  // Auto mode: detect server availability
  const checkUrl = autoDetect.serverUrl ?? serverUrl;
  const timeout = autoDetect.timeout ?? 2000;
  const preferManaged = autoDetect.preferManaged ?? true;

  const serverAvailable = await checkServerHealth(checkUrl, timeout);

  if (serverAvailable && preferManaged) {
    const { ServerClient } = await import("./server-client.js");
    return new ServerClient({
      serverUrl: checkUrl,
      wsUrl: wsUrl ?? checkUrl.replace(/^http/, "ws") + "/ws",
    });
  }

  // Fall back to standalone
  const { StandaloneClient } = await import("./standalone-client.js");
  return new StandaloneClient({ projectPath });
}
