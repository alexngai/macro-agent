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

import type {
  SudocodeClient,
  StandaloneClientConfig,
  ListIssuesOptions,
  ListSpecsOptions,
  UpdateIssueInput,
  FeedbackInput,
  IssueChangeCallback,
  Unsubscribe,
} from "./client.js";

import type {
  Issue,
  Spec,
  RelationshipType,
} from "../../../../references/sudocode/types/src/index.js";

/**
 * StandaloneClient - CLI + file watcher client for standalone mode
 *
 * TODO: Implement in issue i-1ju3
 */
export class StandaloneClient implements SudocodeClient {
  private config: StandaloneClientConfig;
  private ready: boolean = false;

  constructor(config: StandaloneClientConfig) {
    this.config = config;
    // TODO: Initialize file watcher for .sudocode/issues.jsonl
    throw new Error(
      "StandaloneClient not yet implemented. See issue i-1ju3 for implementation."
    );
  }

  // ─── Issue Operations ────────────────────────────────────────────────────────

  async getIssue(id: string): Promise<Issue | null> {
    throw new Error("Not implemented");
  }

  async listIssues(filter?: ListIssuesOptions): Promise<Issue[]> {
    throw new Error("Not implemented");
  }

  async getReadyIssues(): Promise<Issue[]> {
    throw new Error("Not implemented");
  }

  async updateIssue(id: string, updates: UpdateIssueInput): Promise<Issue> {
    throw new Error("Not implemented");
  }

  // ─── Relationship Operations ─────────────────────────────────────────────────

  async createLink(
    from: string,
    to: string,
    type: RelationshipType
  ): Promise<void> {
    throw new Error("Not implemented");
  }

  async removeLink(
    from: string,
    to: string,
    type: RelationshipType
  ): Promise<void> {
    throw new Error("Not implemented");
  }

  async getBlockers(issueId: string): Promise<Issue[]> {
    throw new Error("Not implemented");
  }

  async getBlocking(issueId: string): Promise<Issue[]> {
    throw new Error("Not implemented");
  }

  // ─── Spec Operations ─────────────────────────────────────────────────────────

  async getSpec(id: string): Promise<Spec | null> {
    throw new Error("Not implemented");
  }

  async listSpecs(filter?: ListSpecsOptions): Promise<Spec[]> {
    throw new Error("Not implemented");
  }

  // ─── Feedback Operations ─────────────────────────────────────────────────────

  async addFeedback(
    fromIssueId: string | undefined,
    toId: string,
    feedback: FeedbackInput
  ): Promise<void> {
    throw new Error("Not implemented");
  }

  // ─── Event Subscription ──────────────────────────────────────────────────────

  onIssueChange(callback: IssueChangeCallback): Unsubscribe;
  onIssueChange(issueId: string, callback: IssueChangeCallback): Unsubscribe;
  onIssueChange(
    callbackOrId: IssueChangeCallback | string,
    maybeCallback?: IssueChangeCallback
  ): Unsubscribe {
    throw new Error("Not implemented");
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  isReady(): boolean {
    return this.ready;
  }

  close(): void {
    this.ready = false;
    // TODO: Close file watcher
  }
}
