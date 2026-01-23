/**
 * StandaloneClient - SudocodeClient implementation for standalone mode
 *
 * Accesses sudocode data directly via CLI operations and file watching.
 * This is used when macro-agent runs independently without a sudocode server.
 *
 * @module task/backend/sudocode/standalone-client
 * @see s-8472 Pluggable Task Backend Integration with Sudocode
 * @see i-1ju3 7A.3: Implement StandaloneClient (standalone mode)
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";

import type {
  SudocodeClient,
  StandaloneClientConfig,
  ListIssuesOptions,
  ListSpecsOptions,
  UpdateIssueInput,
  FeedbackInput,
  IssueChangeCallback,
  IssueChangeEvent,
  Unsubscribe,
} from "./client.js";

import type {
  Issue,
  Spec,
  RelationshipType,
  EntityType,
} from "@sudocode-ai/types";

import type { Database } from "better-sqlite3";

// Import CLI operations - these may throw if not available
// We use dynamic import to handle this gracefully
type SudocodeCliModule = typeof import("@sudocode-ai/cli");

/**
 * StandaloneClient - CLI-based client for standalone mode
 *
 * Uses @sudocode-ai/cli operations directly against a SQLite database.
 * Supports event subscriptions via polling since we don't have file watchers here.
 */
export class StandaloneClient implements SudocodeClient {
  private config: StandaloneClientConfig;
  private ready: boolean = false;
  private db: Database | null = null;
  private cli: SudocodeCliModule | null = null;
  private changeCallbacks: Map<string | "*", Set<IssueChangeCallback>> =
    new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastKnownIssues: Map<string, Issue> = new Map();

  constructor(config: StandaloneClientConfig) {
    this.config = {
      projectPath: config.projectPath,
      pollInterval: config.pollInterval ?? 5000,
    };
  }

  /**
   * Initialize the client - must be called before other operations
   */
  async init(): Promise<void> {
    if (this.ready) return;

    // Dynamically import CLI module
    try {
      this.cli = await import("@sudocode-ai/cli");
    } catch (error) {
      throw new Error(
        `Failed to load @sudocode-ai/cli package: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Initialize database
    const sudocodeDir = join(this.config.projectPath, ".sudocode");
    const dbPath = join(sudocodeDir, "cache.db");

    // Create .sudocode directory if it doesn't exist
    if (!existsSync(sudocodeDir)) {
      mkdirSync(sudocodeDir, { recursive: true });
    }

    // Initialize database (creates schema if needed)
    this.db = this.cli.initDatabase({ path: dbPath });

    this.ready = true;

    // Load initial state for change detection
    await this.refreshIssueCache();

    // Start polling for changes if we have subscribers
    this.startPollingIfNeeded();
  }

  /**
   * Internal: ensure client is initialized
   */
  private ensureReady(): void {
    if (!this.ready || !this.db || !this.cli) {
      throw new Error(
        "StandaloneClient not initialized. Call init() before using."
      );
    }
  }

  /**
   * Internal: get the CLI module (type-safe helper)
   */
  private getCli(): SudocodeCliModule {
    this.ensureReady();
    return this.cli!;
  }

  /**
   * Internal: get the database (type-safe helper)
   */
  private getDb(): Database {
    this.ensureReady();
    return this.db!;
  }

  // ─── Issue Operations ────────────────────────────────────────────────────────

  async getIssue(id: string): Promise<Issue | null> {
    this.ensureReady();
    const issue = this.getCli().getIssue(this.getDb(), id);
    return issue ?? null;
  }

  async listIssues(filter?: ListIssuesOptions): Promise<Issue[]> {
    this.ensureReady();
    const cli = this.getCli();
    const db = this.getDb();

    if (filter?.search) {
      // Use search function for text search
      return cli.searchIssues(db, filter.search, {
        status: filter.status,
        priority: filter.priority,
        archived: filter.archived,
        limit: filter.limit,
      }) as Issue[];
    }

    return cli.listIssues(db, {
      status: filter?.status,
      priority: filter?.priority,
      archived: filter?.archived,
      limit: filter?.limit,
    }) as Issue[];
  }

  async getReadyIssues(): Promise<Issue[]> {
    this.ensureReady();
    return this.getCli().getReadyIssues(this.getDb()) as Issue[];
  }

  async updateIssue(id: string, updates: UpdateIssueInput): Promise<Issue> {
    this.ensureReady();
    const cli = this.getCli();
    const db = this.getDb();

    // Transform updates to match CLI's expected type (convert null to undefined)
    const cliUpdates = {
      ...updates,
      assignee: updates.assignee === null ? undefined : updates.assignee,
    };

    const previousIssue = cli.getIssue(db, id) as Issue | undefined;
    const updated = cli.updateIssue(db, id, cliUpdates) as Issue;

    // Emit change event
    if (previousIssue) {
      this.emitChangeEvent({
        type: updates.status !== previousIssue.status ? "status_changed" : "updated",
        issueId: id,
        issue: updated,
        previousIssue,
      });
    }

    return updated;
  }

  // ─── Relationship Operations ─────────────────────────────────────────────────

  async createLink(
    from: string,
    to: string,
    type: RelationshipType
  ): Promise<void> {
    this.ensureReady();
    const cli = this.getCli();
    const db = this.getDb();

    const fromType = this.inferEntityType(from);
    const toType = this.inferEntityType(to);

    cli.addRelationship(db, {
      from_id: from,
      from_type: fromType,
      to_id: to,
      to_type: toType,
      relationship_type: type,
    });

    // If this was a 'blocks' relationship between issues, emit events
    if (type === "blocks" && fromType === "issue" && toType === "issue") {
      const toIssue = cli.getIssue(db, to) as Issue | undefined;
      if (toIssue && toIssue.status === "blocked") {
        this.emitChangeEvent({
          type: "blocked",
          issueId: to,
          issue: toIssue,
          metadata: { blockerId: from },
        });
      }
    }
  }

  async removeLink(
    from: string,
    to: string,
    type: RelationshipType
  ): Promise<void> {
    this.ensureReady();
    const cli = this.getCli();
    const db = this.getDb();

    const fromType = this.inferEntityType(from);
    const toType = this.inferEntityType(to);

    cli.removeRelationship(db, from, fromType, to, toType, type);

    // If this was a 'blocks' relationship, check if issue was unblocked
    if (type === "blocks" && fromType === "issue" && toType === "issue") {
      const toIssue = cli.getIssue(db, to) as Issue | undefined;
      if (toIssue && toIssue.status !== "blocked") {
        this.emitChangeEvent({
          type: "unblocked",
          issueId: to,
          issue: toIssue,
          metadata: { formerBlockerId: from },
        });
      }
    }
  }

  async getBlockers(issueId: string): Promise<Issue[]> {
    this.ensureReady();
    const cli = this.getCli();
    const db = this.getDb();

    // Get incoming 'blocks' relationships (other issues that block this one)
    const incomingBlocks = cli.getIncomingRelationships(
      db,
      issueId,
      "issue",
      "blocks"
    );

    // Get outgoing 'depends-on' relationships (this issue depends on others)
    const outgoingDependsOn = cli.getOutgoingRelationships(
      db,
      issueId,
      "issue",
      "depends-on"
    );

    const blockerIds = new Set<string>();

    // For 'blocks': from_id blocks issueId
    for (const rel of incomingBlocks) {
      if (rel.from_type === "issue") {
        blockerIds.add(rel.from_id);
      }
    }

    // For 'depends-on': issueId depends-on to_id
    for (const rel of outgoingDependsOn) {
      if (rel.to_type === "issue") {
        blockerIds.add(rel.to_id);
      }
    }

    const blockers: Issue[] = [];
    for (const blockerId of blockerIds) {
      const blocker = cli.getIssue(db, blockerId) as Issue | undefined;
      if (blocker) {
        blockers.push(blocker);
      }
    }

    return blockers;
  }

  async getBlocking(issueId: string): Promise<Issue[]> {
    this.ensureReady();
    const cli = this.getCli();
    const db = this.getDb();

    // Get outgoing 'blocks' relationships (this issue blocks others)
    const outgoingBlocks = cli.getOutgoingRelationships(
      db,
      issueId,
      "issue",
      "blocks"
    );

    // Get incoming 'depends-on' relationships (others depend on this issue)
    const incomingDependsOn = cli.getIncomingRelationships(
      db,
      issueId,
      "issue",
      "depends-on"
    );

    const blockedIds = new Set<string>();

    // For 'blocks': issueId blocks to_id
    for (const rel of outgoingBlocks) {
      if (rel.to_type === "issue") {
        blockedIds.add(rel.to_id);
      }
    }

    // For 'depends-on': from_id depends-on issueId
    for (const rel of incomingDependsOn) {
      if (rel.from_type === "issue") {
        blockedIds.add(rel.from_id);
      }
    }

    const blocked: Issue[] = [];
    for (const blockedId of blockedIds) {
      const issue = cli.getIssue(db, blockedId) as Issue | undefined;
      if (issue) {
        blocked.push(issue);
      }
    }

    return blocked;
  }

  // ─── Spec Operations ─────────────────────────────────────────────────────────

  async getSpec(id: string): Promise<Spec | null> {
    this.ensureReady();
    const spec = this.getCli().getSpec(this.getDb(), id);
    return (spec as Spec) ?? null;
  }

  async listSpecs(filter?: ListSpecsOptions): Promise<Spec[]> {
    this.ensureReady();
    const cli = this.getCli();
    const db = this.getDb();

    if (filter?.search) {
      return cli.searchSpecs(db, filter.search, {
        limit: filter.limit,
      }) as Spec[];
    }

    return cli.listSpecs(db, {
      limit: filter?.limit,
    }) as Spec[];
  }

  // ─── Feedback Operations ─────────────────────────────────────────────────────

  async addFeedback(
    fromIssueId: string | undefined,
    toId: string,
    feedback: FeedbackInput
  ): Promise<void> {
    this.ensureReady();
    const cli = this.getCli();
    const db = this.getDb();

    // Check if addFeedback is available
    if (typeof (cli as unknown as Record<string, unknown>).addFeedback !== "function") {
      // Fallback: feedback not supported in this CLI version
      console.warn("Feedback operations not supported in this @sudocode-ai/cli version");
      return;
    }

    // Call addFeedback if available
    (cli as unknown as { addFeedback: (db: Database, input: unknown) => void }).addFeedback(db, {
      from_id: fromIssueId,
      to_id: toId,
      type: feedback.type,
      content: feedback.content,
      agent: feedback.agent,
      line: feedback.anchor?.line,
      text: feedback.anchor?.text,
    });
  }

  // ─── Event Subscription ──────────────────────────────────────────────────────

  onIssueChange(callback: IssueChangeCallback): Unsubscribe;
  onIssueChange(issueId: string, callback: IssueChangeCallback): Unsubscribe;
  onIssueChange(
    callbackOrId: IssueChangeCallback | string,
    maybeCallback?: IssueChangeCallback
  ): Unsubscribe {
    let key: string;
    let callback: IssueChangeCallback;

    if (typeof callbackOrId === "function") {
      key = "*";
      callback = callbackOrId;
    } else {
      key = callbackOrId;
      callback = maybeCallback!;
    }

    if (!this.changeCallbacks.has(key)) {
      this.changeCallbacks.set(key, new Set());
    }
    this.changeCallbacks.get(key)!.add(callback);

    // Start polling if we have subscribers and not already polling
    this.startPollingIfNeeded();

    return () => {
      const callbacks = this.changeCallbacks.get(key);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.changeCallbacks.delete(key);
        }
      }

      // Stop polling if no more subscribers
      this.stopPollingIfNotNeeded();
    };
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  isReady(): boolean {
    return this.ready;
  }

  close(): void {
    this.ready = false;

    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Close database
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    // Clear callbacks
    this.changeCallbacks.clear();
    this.lastKnownIssues.clear();
  }

  // ─── Internal Helpers ────────────────────────────────────────────────────────

  /**
   * Infer entity type from ID prefix
   */
  private inferEntityType(id: string): EntityType {
    if (id.startsWith("i-")) return "issue";
    if (id.startsWith("s-")) return "spec";
    throw new Error(`Cannot infer entity type from ID: ${id}`);
  }

  /**
   * Emit a change event to subscribers
   */
  private emitChangeEvent(event: IssueChangeEvent): void {
    // Notify specific subscribers
    const specificCallbacks = this.changeCallbacks.get(event.issueId);
    if (specificCallbacks) {
      for (const callback of specificCallbacks) {
        try {
          callback(event);
        } catch (error) {
          console.error("Error in issue change callback:", error);
        }
      }
    }

    // Notify global subscribers
    const globalCallbacks = this.changeCallbacks.get("*");
    if (globalCallbacks) {
      for (const callback of globalCallbacks) {
        try {
          callback(event);
        } catch (error) {
          console.error("Error in issue change callback:", error);
        }
      }
    }
  }

  /**
   * Refresh the internal issue cache for change detection
   */
  private async refreshIssueCache(): Promise<void> {
    if (!this.ready || !this.db || !this.cli) return;

    const issues = this.cli.listIssues(this.db, { archived: false }) as Issue[];
    this.lastKnownIssues.clear();
    for (const issue of issues) {
      this.lastKnownIssues.set(issue.id, issue);
    }
  }

  /**
   * Poll for changes and emit events
   */
  private async pollForChanges(): Promise<void> {
    if (!this.ready || !this.db || !this.cli) return;

    const currentIssues = this.cli.listIssues(this.db, { archived: false }) as Issue[];
    const currentMap = new Map<string, Issue>();
    for (const issue of currentIssues) {
      currentMap.set(issue.id, issue);
    }

    // Check for deleted issues
    for (const [id, previousIssue] of this.lastKnownIssues) {
      if (!currentMap.has(id)) {
        this.emitChangeEvent({
          type: "deleted",
          issueId: id,
          previousIssue,
        });
      }
    }

    // Check for new or changed issues
    for (const [id, currentIssue] of currentMap) {
      const previousIssue = this.lastKnownIssues.get(id);

      if (!previousIssue) {
        // New issue
        this.emitChangeEvent({
          type: "created",
          issueId: id,
          issue: currentIssue,
        });
      } else if (currentIssue.updated_at !== previousIssue.updated_at) {
        // Changed issue - determine the type of change
        let changeType: IssueChangeEvent["type"] = "updated";

        if (currentIssue.status !== previousIssue.status) {
          if (currentIssue.status === "blocked") {
            changeType = "blocked";
          } else if (previousIssue.status === "blocked") {
            changeType = "unblocked";
          } else {
            changeType = "status_changed";
          }
        }

        this.emitChangeEvent({
          type: changeType,
          issueId: id,
          issue: currentIssue,
          previousIssue,
        });
      }
    }

    // Update cache
    this.lastKnownIssues = currentMap;
  }

  /**
   * Start polling if needed
   */
  private startPollingIfNeeded(): void {
    if (this.pollTimer) return; // Already polling
    if (this.changeCallbacks.size === 0) return; // No subscribers
    if (!this.ready) return; // Not initialized

    this.pollTimer = setInterval(
      () => this.pollForChanges(),
      this.config.pollInterval
    );
  }

  /**
   * Stop polling if not needed
   */
  private stopPollingIfNotNeeded(): void {
    if (this.changeCallbacks.size > 0) return; // Still have subscribers

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

/**
 * Create and initialize a StandaloneClient
 *
 * @param config Client configuration
 * @returns Initialized StandaloneClient
 */
export async function createStandaloneClient(
  config: StandaloneClientConfig
): Promise<StandaloneClient> {
  const client = new StandaloneClient(config);
  await client.init();
  return client;
}
