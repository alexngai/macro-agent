/**
 * Example: Distributed Peer Communication
 *
 * Demonstrates two macro-agents communicating via WebSockets
 * across a network. In this example, both agents run locally
 * on different ports, but the same pattern works across machines.
 *
 * Run with: npx tsx examples/distributed-peer-communication.ts
 *
 * For cross-machine usage:
 * 1. On Machine A: Configure peer registry with Machine B's IP/port
 * 2. On Machine B: Configure peer registry with Machine A's IP/port
 * 3. Update host binding from "localhost" to "0.0.0.0" to accept external connections
 */

import {
  createWebSocketTransport,
  createPeerManager,
  type PeerRegistryEntry,
} from "../src/peer/index.js";
import type { EventStore } from "../src/store/event-store.js";
import type { MessageRouter } from "../src/router/message-router.js";
import type { AgentId } from "../src/store/types/index.js";

// Mock dependencies for the example
const mockEventStore = {
  getAgent: () => ({ id: "agent-1", state: "running" }),
  emit: () => {},
} as unknown as EventStore;

const mockMessageRouter = {} as MessageRouter;

// Configuration for two peers
const PEER_1_PORT = 9001;
const PEER_2_PORT = 9002;

async function main() {
  console.log("=== Distributed Peer Communication Example ===\n");
  console.log("This demonstrates WebSocket-based communication between macro-agents.");
  console.log("The same pattern works across different machines on a network.\n");

  // Create peer managers
  const rootAgent1 = "agent-1" as AgentId;
  const rootAgent2 = "agent-2" as AgentId;

  const peerManager1 = createPeerManager(
    mockEventStore,
    mockMessageRouter,
    rootAgent1
  );

  const peerManager2 = createPeerManager(
    mockEventStore,
    mockMessageRouter,
    rootAgent2
  );

  // Peer registry - in production, this could come from a service discovery system
  const peer1Registry: PeerRegistryEntry[] = [
    { peerId: "macro-agent-2", url: `ws://localhost:${PEER_2_PORT}` },
  ];

  const peer2Registry: PeerRegistryEntry[] = [
    { peerId: "macro-agent-1", url: `ws://localhost:${PEER_1_PORT}` },
  ];

  // Create WebSocket transports
  const transport1 = createWebSocketTransport({
    peerId: "macro-agent-1",
    port: PEER_1_PORT,
    host: "localhost", // Use "0.0.0.0" for cross-machine
    peerRegistry: peer1Registry,
  });

  const transport2 = createWebSocketTransport({
    peerId: "macro-agent-2",
    port: PEER_2_PORT,
    host: "localhost", // Use "0.0.0.0" for cross-machine
    peerRegistry: peer2Registry,
  });

  // Register transports with peer managers
  const handler1 = peerManager1.registerTransport(transport1);
  const handler2 = peerManager2.registerTransport(transport2);

  // Start both transports
  await transport1.start(handler1);
  console.log(`Started macro-agent-1 on ws://localhost:${PEER_1_PORT}`);

  await transport2.start(handler2);
  console.log(`Started macro-agent-2 on ws://localhost:${PEER_2_PORT}`);

  console.log("\n--- Cross-Network Message Exchange ---");

  // Agent 1 sends a task coordination message to Agent 2
  await peerManager1.sendMessage(rootAgent1, "macro-agent-2", {
    type: "task_delegation",
    payload: {
      task_id: "task-456",
      description: "Process data batch #123",
      priority: "high",
      deadline: new Date(Date.now() + 3600000).toISOString(),
    },
  });

  console.log("Agent 1 delegated task to Agent 2");

  // Wait for message delivery
  await sleep(200);

  // Check Agent 2's inbox
  const messages2 = peerManager2.getPeerMessages(rootAgent2);
  console.log(`Agent 2 received ${messages2.length} message(s):`);
  for (const msg of messages2) {
    console.log(`  - Type: ${msg.type}`);
    console.log(`    From: ${msg.from}`);
    console.log(`    Task: ${(msg.payload as Record<string, unknown>).task_id}`);
  }

  console.log("\n--- Request-Response Across Network ---");

  // Deliver a request from Agent 1 to Agent 2 for status check
  const statusRequestPromise = peerManager2.deliverRequest(
    "macro-agent-1",
    {
      method: "getStatus",
      params: { includeMetrics: true },
      timeout: 5000,
    },
    rootAgent2
  );

  // Agent 2 processes and responds
  await sleep(100);
  const requests2 = peerManager2.getPeerMessages(rootAgent2, { includeRequests: true });
  const pendingRequest = requests2.find((m) => m.isRequest);

  if (pendingRequest && pendingRequest.requestId) {
    console.log(`Agent 2 received request: ${pendingRequest.type}`);

    // Simulate processing
    peerManager2.respondToRequest(rootAgent2, pendingRequest.requestId, {
      result: {
        status: "healthy",
        activeAgents: 5,
        tasksCompleted: 127,
        uptime: "3d 4h 12m",
      },
    });
    console.log("Agent 2 responded with status");
  }

  const statusResponse = await statusRequestPromise;
  console.log("Status response received:", statusResponse);

  console.log("\n--- Dynamic Peer Discovery ---");

  // Demonstrate adding a peer at runtime
  transport1.registerPeer("macro-agent-3", "ws://localhost:9003");
  console.log("Registered new peer: macro-agent-3");

  transport1.unregisterPeer("macro-agent-3");
  console.log("Unregistered peer: macro-agent-3");

  console.log("\n--- Network Topology Info ---");
  console.log(`
In a production distributed system:

1. PEER DISCOVERY:
   - Use a service registry (etcd, Consul, ZooKeeper)
   - Or DNS-based discovery
   - Or configuration management

2. LOAD BALANCING:
   - Multiple macro-agents can share peer IDs
   - Route based on capacity/locality

3. SECURITY:
   - Use WSS (WebSocket Secure) for encrypted communication
   - Add authentication tokens in connection headers
   - Implement message signing for integrity

4. RESILIENCE:
   - The transport includes automatic reconnection
   - Configure maxReconnectAttempts and reconnectDelay
   - Implement circuit breakers for failing peers
`);

  // Cleanup
  console.log("--- Cleanup ---");
  await transport1.stop();
  await transport2.stop();
  console.log("Stopped both WebSocket servers");

  console.log("\n=== Example Complete ===");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
