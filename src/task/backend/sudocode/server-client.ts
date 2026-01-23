/**
 * ServerClient - SudocodeClient implementation for managed mode
 *
 * Connects to sudocode server via REST API and WebSocket for real-time events.
 * This is used when macro-agent is launched as a subprocess by the sudocode server.
 *
 * @module task/backend/sudocode/server-client
 * @see s-8472 Pluggable Task Backend Integration with Sudocode
 * @see i-5rrj 7A.2: Implement ServerClient (managed mode)
 */

import type {
  SudocodeClient,
  ServerClientConfig,
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
} from "../../../../references/sudocode/types/src/index.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Standard API response format from sudocode server
 */
interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  message?: string;
  error_data?: string;
}

/**
 * WebSocket message format from sudocode server
 */
interface WsMessage {
  type: string;
  projectId?: string;
  entityId?: string;
  action?: string;
  data?: unknown;
}

// =============================================================================
// ServerClient Implementation
// =============================================================================

/**
 * ServerClient - REST + WebSocket client for managed mode
 *
 * Connects to a running sudocode server for all operations.
 * Uses WebSocket for real-time event subscriptions with polling fallback.
 */
export class ServerClient implements SudocodeClient {
  private config: ServerClientConfig;
  private _ready: boolean = false;
  private ws: WebSocket | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsReconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 10;
  private readonly reconnectDelay: number = 1000;
  private subscribers: Map<string, Set<IssueChangeCallback>> = new Map();
  private globalSubscribers: Set<IssueChangeCallback> = new Set();

  constructor(config: ServerClientConfig) {
    this.config = config;
    this.initWebSocket();
  }

  // ─── HTTP Helpers ────────────────────────────────────────────────────────────

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.projectId) {
      headers["X-Project-ID"] = this.config.projectId;
    }
    return headers;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.config.serverUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: this.headers,
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const json = (await response.json()) as ApiResponse<T>;

    if (!json.success) {
      throw new Error(json.message || json.error_data || "Request failed");
    }

    return json.data as T;
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  private async delete<T>(path: string, body?: unknown): Promise<T> {
    const url = `${this.config.serverUrl}${path}`;
    const options: RequestInit = {
      method: "DELETE",
      headers: this.headers,
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const json = (await response.json()) as ApiResponse<T>;

    if (!json.success) {
      throw new Error(json.message || json.error_data || "Request failed");
    }

    return json.data as T;
  }

  // ─── WebSocket Management ────────────────────────────────────────────────────

  private initWebSocket(): void {
    const wsUrl =
      this.config.wsUrl ??
      this.config.serverUrl.replace(/^http/, "ws") + "/ws";

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this._ready = true;
        this.wsReconnectAttempts = 0;
        console.log("[ServerClient] WebSocket connected");
      };

      this.ws.onclose = () => {
        this._ready = false;
        console.log("[ServerClient] WebSocket disconnected");
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error("[ServerClient] WebSocket error:", error);
      };

      this.ws.onmessage = (event) => {
        this.handleWsMessage(event.data);
      };
    } catch (error) {
      console.error("[ServerClient] Failed to initialize WebSocket:", error);
      this._ready = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
    }

    if (this.wsReconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        "[ServerClient] Max reconnect attempts reached, giving up"
      );
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.wsReconnectAttempts);
    this.wsReconnectAttempts++;

    console.log(
      `[ServerClient] Scheduling reconnect in ${delay}ms (attempt ${this.wsReconnectAttempts})`
    );

    this.wsReconnectTimer = setTimeout(() => {
      this.initWebSocket();
    }, delay);
  }

  private handleWsMessage(data: string): void {
    try {
      const message = JSON.parse(data) as WsMessage;

      // Handle issue-related messages
      if (message.type === "issue" && message.entityId && message.action) {
        const event: IssueChangeEvent = {
          type: this.mapWsAction(message.action),
          issueId: message.entityId,
          issue: message.data as Issue | undefined,
        };

        // Notify global subscribers
        for (const callback of this.globalSubscribers) {
          try {
            callback(event);
          } catch (error) {
            console.error(
              "[ServerClient] Error in global subscriber callback:",
              error
            );
          }
        }

        // Notify issue-specific subscribers
        const issueSubscribers = this.subscribers.get(message.entityId);
        if (issueSubscribers) {
          for (const callback of issueSubscribers) {
            try {
              callback(event);
            } catch (error) {
              console.error(
                "[ServerClient] Error in issue subscriber callback:",
                error
              );
            }
          }
        }
      }
    } catch (error) {
      console.error("[ServerClient] Failed to parse WebSocket message:", error);
    }
  }

  private mapWsAction(
    action: string
  ): IssueChangeEvent["type"] {
    switch (action) {
      case "created":
        return "created";
      case "updated":
        return "updated";
      case "deleted":
        return "deleted";
      case "status_changed":
        return "status_changed";
      default:
        return "updated";
    }
  }

  // ─── Issue Operations ────────────────────────────────────────────────────────

  async getIssue(id: string): Promise<Issue | null> {
    try {
      return await this.get<Issue>(`/api/issues/${id}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return null;
      }
      throw error;
    }
  }

  async listIssues(filter?: ListIssuesOptions): Promise<Issue[]> {
    const params = new URLSearchParams();

    if (filter?.status) {
      params.set("status", filter.status);
    }
    if (filter?.priority !== undefined) {
      params.set("priority", filter.priority.toString());
    }
    if (filter?.search) {
      params.set("search", filter.search);
    }
    if (filter?.archived !== undefined) {
      params.set("archived", filter.archived.toString());
    }
    if (filter?.limit !== undefined) {
      params.set("limit", filter.limit.toString());
    }

    const queryString = params.toString();
    const path = queryString ? `/api/issues?${queryString}` : "/api/issues";

    return this.get<Issue[]>(path);
  }

  async getReadyIssues(): Promise<Issue[]> {
    // Use the project status endpoint which returns ready issues
    const status = await this.get<{
      ready_issues: Array<{ id: string; title: string; priority: number }>;
    }>("/api/project/status");

    // Fetch full issue details for each ready issue
    const issues: Issue[] = [];
    for (const item of status.ready_issues) {
      const issue = await this.getIssue(item.id);
      if (issue) {
        issues.push(issue);
      }
    }

    return issues;
  }

  async updateIssue(id: string, updates: UpdateIssueInput): Promise<Issue> {
    return this.put<Issue>(`/api/issues/${id}`, updates);
  }

  // ─── Relationship Operations ─────────────────────────────────────────────────

  async createLink(
    from: string,
    to: string,
    type: RelationshipType
  ): Promise<void> {
    const fromType = from.startsWith("s-") ? "spec" : "issue";
    const toType = to.startsWith("s-") ? "spec" : "issue";

    await this.post("/api/relationships", {
      from_id: from,
      from_type: fromType,
      to_id: to,
      to_type: toType,
      relationship_type: type,
    });
  }

  async removeLink(
    from: string,
    to: string,
    type: RelationshipType
  ): Promise<void> {
    const fromType = from.startsWith("s-") ? "spec" : "issue";
    const toType = to.startsWith("s-") ? "spec" : "issue";

    await this.delete("/api/relationships", {
      from_id: from,
      from_type: fromType,
      to_id: to,
      to_type: toType,
      relationship_type: type,
    });
  }

  async getBlockers(issueId: string): Promise<Issue[]> {
    // Get incoming "blocks" relationships (issues that block this one)
    const relationships = await this.get<
      Array<{ from_id: string; from_type: string }>
    >(
      `/api/relationships/issue/${issueId}/incoming?relationship_type=blocks`
    );

    // Fetch full issue details for each blocker
    const blockers: Issue[] = [];
    for (const rel of relationships) {
      if (rel.from_type === "issue") {
        const issue = await this.getIssue(rel.from_id);
        if (issue) {
          blockers.push(issue);
        }
      }
    }

    return blockers;
  }

  async getBlocking(issueId: string): Promise<Issue[]> {
    // Get outgoing "blocks" relationships (issues this one blocks)
    const relationships = await this.get<
      Array<{ to_id: string; to_type: string }>
    >(
      `/api/relationships/issue/${issueId}/outgoing?relationship_type=blocks`
    );

    // Fetch full issue details for each blocked issue
    const blocked: Issue[] = [];
    for (const rel of relationships) {
      if (rel.to_type === "issue") {
        const issue = await this.getIssue(rel.to_id);
        if (issue) {
          blocked.push(issue);
        }
      }
    }

    return blocked;
  }

  // ─── Spec Operations ─────────────────────────────────────────────────────────

  async getSpec(id: string): Promise<Spec | null> {
    try {
      return await this.get<Spec>(`/api/specs/${id}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return null;
      }
      throw error;
    }
  }

  async listSpecs(filter?: ListSpecsOptions): Promise<Spec[]> {
    const params = new URLSearchParams();

    if (filter?.search) {
      params.set("search", filter.search);
    }
    if (filter?.limit !== undefined) {
      params.set("limit", filter.limit.toString());
    }

    const queryString = params.toString();
    const path = queryString ? `/api/specs?${queryString}` : "/api/specs";

    return this.get<Spec[]>(path);
  }

  // ─── Feedback Operations ─────────────────────────────────────────────────────

  async addFeedback(
    fromIssueId: string | undefined,
    toId: string,
    feedback: FeedbackInput
  ): Promise<void> {
    await this.post("/api/feedback", {
      from_id: fromIssueId,
      to_id: toId,
      feedback_type: feedback.type,
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
    if (typeof callbackOrId === "function") {
      // Global subscription
      const callback = callbackOrId;
      this.globalSubscribers.add(callback);

      return () => {
        this.globalSubscribers.delete(callback);
      };
    } else {
      // Issue-specific subscription
      const issueId = callbackOrId;
      const callback = maybeCallback!;

      if (!this.subscribers.has(issueId)) {
        this.subscribers.set(issueId, new Set());
      }
      this.subscribers.get(issueId)!.add(callback);

      return () => {
        const subs = this.subscribers.get(issueId);
        if (subs) {
          subs.delete(callback);
          if (subs.size === 0) {
            this.subscribers.delete(issueId);
          }
        }
      };
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  isReady(): boolean {
    return this._ready;
  }

  close(): void {
    this._ready = false;

    // Clear reconnect timer
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.onclose = null; // Prevent reconnect attempt
      this.ws.close();
      this.ws = null;
    }

    // Clear subscribers
    this.globalSubscribers.clear();
    this.subscribers.clear();
  }
}
