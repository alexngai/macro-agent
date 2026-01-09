/**
 * Event Store module exports
 */

export { createEventStore } from './event-store.js';
export type { EventStore, Unsubscribe, AgentChangeCallback, TaskChangeCallback, MessageCallback } from './event-store.js';
export * from './types/index.js';
export { CURRENT_EVENT_VERSION } from './types/events.js';
export { migrateEvent, needsMigration, getCurrentVersion } from './migrations.js';

// Storage backends
export * from './backends/index.js';

// Instance and namespace management
export {
  // Config types
  type StoreConfig,
  type InstanceMeta,
  type NamespaceRegistry,
  type NamespaceRegistryEntry,
  type DiscoveredInstance,
  type DiscoveryOptions,
  type ResolvedInstance,
  type PeerVisibilityConfig,

  // Constants
  DEFAULT_BASE_DIR,
  DEFAULT_NAMESPACE,
  DEFAULT_BACKEND_TYPE,
  INSTANCE_ID_PREFIX,
  DEFAULT_PEER_VISIBILITY,

  // Instance ID functions
  generateInstanceId,
  isValidInstanceId,

  // Path resolution
  getBaseDir,
  getInstancesDir,
  getNamespacesDir,
  resolveInstancePath,

  // Instance directory management
  ensureInstanceDir,
  getMetaPath,
  readInstanceMeta,
  writeInstanceMeta,
  touchInstance,
  createInstanceMeta,

  // Namespace registry
  getNamespaceRegistryPath,
  readNamespaceRegistry,
  writeNamespaceRegistry,
  registerInstance,
  updateInstanceHeartbeat,
  unregisterInstance,

  // Discovery
  discoverInstances,
  listNamespaces,
  listInstances,

  // Peer visibility helpers
  canPeerExportEvents,
  isEventTypeVisibleToPeers,
  isAgentVisibleToPeers,
  filterEventsForPeer,
} from './instance.js';
