/**
 * Federation — Cross-instance communication via agent-inbox federation.
 *
 * Enables multiple macro-agent instances to communicate by federating
 * their embedded agent-inbox instances. Messaging uses federated
 * addressing ("agentId@systemId"). Lifecycle operations (spawn, terminate)
 * are handled via convention-based inbox messages.
 *
 * ## Architecture
 *
 * Each macro-agent instance embeds its own agent-inbox with a unique systemId.
 * Federation connects the inboxes:
 *
 *   Instance A (systemId: "dev-laptop")
 *     └── agent-inbox ←──federation──→ agent-inbox
 *                                        └── Instance B (systemId: "ci-server")
 *
 * ## Messaging
 *
 * Direct: `inboxAdapter.send("agentA", "agentB@ci-server", "hello")`
 * The inbox federation layer handles routing to the remote instance.
 *
 * ## Lifecycle Requests (convention-based)
 *
 * Cross-instance spawn: send a `remote_spawn_request` event to the remote
 * instance's system agent. The receiving instance handles it via trigger system.
 *
 * ```typescript
 * await inboxAdapter.send("coordinator@dev-laptop", "system@ci-server", {
 *   type: "event",
 *   event: "remote_spawn_request",
 *   data: { task: "Run tests", role: "worker", requestedBy: "coordinator@dev-laptop" }
 * }, { importance: "high" });
 * ```
 *
 * @module adapters/federation
 */

import type { InboxAdapter, InboxDeliveryEvent } from "./types.js";
import type { AgentManager } from "../agent/agent-manager.js";

// =============================================================================
// Federation Config
// =============================================================================

/**
 * Federation configuration for connecting macro-agent instances.
 */
export interface FederationConfig {
  /** Unique system ID for this instance (e.g., "dev-laptop", "ci-server") */
  systemId: string;

  /** Peer instances to connect to */
  peers?: FederationPeer[];

  /** Trust policy */
  trust?: {
    /** Only accept connections from these system IDs */
    allowedSystems?: string[];
  };
}

export interface FederationPeer {
  /** System ID of the peer */
  systemId: string;
  /** WebSocket URL for the peer's agent-inbox MAP server */
  url?: string;
  /** Mesh peer ID for agentic-mesh P2P transport */
  meshPeerId?: string;
}

// =============================================================================
// Remote Spawn Handler
// =============================================================================

/**
 * Handle incoming remote_spawn_request events from federated instances.
 *
 * When a remote instance sends a spawn request via inbox, this handler
 * spawns the agent locally and sends a confirmation back.
 */
export function createRemoteSpawnHandler(
  agentManager: AgentManager,
  inboxAdapter: InboxAdapter,
  systemId: string
) {
  return async (event: InboxDeliveryEvent) => {
    const { message } = event;
    const content = message.content as any;

    // Only handle remote_spawn_request events addressed to "system"
    if (
      content?.type !== "event" ||
      content?.event !== "remote_spawn_request" ||
      event.agentId !== `system@${systemId}`
    ) {
      return;
    }

    const data = content.data;
    if (!data?.task) return;

    try {
      const spawned = await agentManager.spawn({
        task: data.task,
        role: data.role,
        cwd: data.cwd,
      });

      // Send confirmation back to requester
      if (data.requestedBy) {
        await inboxAdapter.send(
          `system@${systemId}`,
          data.requestedBy,
          {
            type: "event",
            event: "remote_spawn_response",
            data: {
              success: true,
              agentId: spawned.id,
              name: spawned.agent.name,
              role: spawned.agent.role,
              systemId,
            },
          },
          { importance: "high" }
        );
      }
    } catch (err) {
      // Send error back to requester
      if (data.requestedBy) {
        await inboxAdapter.send(
          `system@${systemId}`,
          data.requestedBy,
          {
            type: "event",
            event: "remote_spawn_response",
            data: {
              success: false,
              error: err instanceof Error ? err.message : String(err),
              systemId,
            },
          },
          { importance: "high" }
        );
      }
    }
  };
}

// =============================================================================
// Federation Helper
// =============================================================================

/**
 * Set up federation for a macro-agent instance.
 *
 * Registers the remote spawn handler on the inbox adapter's delivery events.
 * Returns a cleanup function.
 */
export function setupFederation(
  agentManager: AgentManager,
  inboxAdapter: InboxAdapter,
  config: FederationConfig
): () => void {
  const handler = createRemoteSpawnHandler(
    agentManager,
    inboxAdapter,
    config.systemId
  );

  inboxAdapter.onDelivery(handler);

  // Register "system" as a virtual agent for receiving federation requests
  inboxAdapter.registerAgent(`system@${config.systemId}`, {
    name: "System",
    role: "system",
    scope: "default",
    metadata: { systemId: config.systemId, federation: true },
  });

  return () => {
    inboxAdapter.offDelivery(handler);
  };
}
