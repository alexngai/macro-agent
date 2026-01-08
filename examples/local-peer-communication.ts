/**
 * Example: Local Peer Communication
 *
 * Demonstrates two macro-agents communicating via Unix sockets
 * on the same machine.
 *
 * Run with: npx tsx examples/local-peer-communication.ts
 */

import {
  createLocalTransport,
  createPeerManager,
  type PeerHandler,
  type PeerMessage,
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

async function main() {
  console.log("=== Local Peer Communication Example ===\n");

  // Create two peer managers representing two macro-agent instances
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

  // Create local transports for each peer
  const transport1 = createLocalTransport({
    peerId: "macro-agent-1",
    socketDir: "/tmp/macro-agent-example",
  });

  const transport2 = createLocalTransport({
    peerId: "macro-agent-2",
    socketDir: "/tmp/macro-agent-example",
  });

  // Register transports with peer managers
  const handler1 = peerManager1.registerTransport(transport1);
  const handler2 = peerManager2.registerTransport(transport2);

  // Start both transports
  await transport1.start(handler1);
  console.log("Started macro-agent-1 at /tmp/macro-agent-example/macro-agent-1.sock");

  await transport2.start(handler2);
  console.log("Started macro-agent-2 at /tmp/macro-agent-example/macro-agent-2.sock");

  console.log("\n--- Fire-and-Forget Message ---");

  // Agent 1 sends a message to Agent 2
  await peerManager1.sendMessage(rootAgent1, "macro-agent-2", {
    type: "notification",
    payload: { event: "task_started", task_id: "task-123" },
  });

  console.log("Agent 1 sent notification to Agent 2");

  // Wait for message delivery
  await sleep(100);

  // Check Agent 2's inbox
  const messages2 = peerManager2.getPeerMessages(rootAgent2);
  console.log(`Agent 2 received ${messages2.length} message(s):`);
  for (const msg of messages2) {
    console.log(`  - From: ${msg.from}, Type: ${msg.type}`);
    console.log(`    Payload:`, msg.payload);
  }

  console.log("\n--- Request-Response ---");

  // Agent 2 sends a request to Agent 1 (will timeout since no handler)
  // To demonstrate properly, we'll use the deliver/respond pattern

  // First, let's demonstrate the request pattern by having Agent 1
  // deliver a request that Agent 2 will respond to

  // Agent 1 delivers a request to Agent 2 via the manager
  const requestPromise = peerManager2.deliverRequest(
    "macro-agent-1",
    {
      method: "calculate",
      params: { operation: "add", x: 10, y: 20 },
      timeout: 5000,
    },
    rootAgent2
  );

  // Agent 2 sees the request and responds
  await sleep(50);
  const requests2 = peerManager2.getPeerMessages(rootAgent2, { includeRequests: true });
  const pendingRequest = requests2.find((m) => m.isRequest);

  if (pendingRequest && pendingRequest.requestId) {
    console.log(`Agent 2 received request: ${pendingRequest.type}`);
    console.log(`  Params:`, pendingRequest.payload);

    // Simulate processing and respond
    peerManager2.respondToRequest(rootAgent2, pendingRequest.requestId, {
      result: 30, // 10 + 20
    });
    console.log("Agent 2 responded with result: 30");
  }

  // Get the response
  const response = await requestPromise;
  console.log("Request completed with response:", response);

  console.log("\n--- Peer Coordination Pattern ---");

  // Acknowledge messages
  const allMessages2 = peerManager2.getPeerMessages(rootAgent2);
  peerManager2.acknowledgePeerMessages(
    rootAgent2,
    allMessages2.map((m) => m.id)
  );
  console.log(`Agent 2 acknowledged ${allMessages2.length} message(s)`);

  // Verify inbox is empty
  const remainingMessages = peerManager2.getPeerMessages(rootAgent2);
  console.log(`Agent 2 remaining messages: ${remainingMessages.length}`);

  console.log("\n--- Address Parsing ---");

  // Demonstrate address parsing
  const addr1 = peerManager1.parseAddress("macro-agent-2");
  console.log("Address 'macro-agent-2':", addr1);

  const addr2 = peerManager1.parseAddress("macro-agent-2/agent-xyz");
  console.log("Address 'macro-agent-2/agent-xyz':", addr2);

  // Cleanup
  console.log("\n--- Cleanup ---");
  await transport1.stop();
  await transport2.stop();
  console.log("Stopped both transports");

  console.log("\n=== Example Complete ===");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
