/**
 * Instance and Namespace Resolution
 *
 * Handles per-instance storage isolation and namespace-based discovery.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { nanoid } from 'nanoid';
import type { StorageBackendConfig } from './backends/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for what state peers can access when querying this instance.
 * Default is restrictive (no sharing).
 */
export interface PeerVisibilityConfig {
  /**
   * Allow peers to query events.
   * Default: false
   */
  exportEvents?: boolean;

  /**
   * Event types peers can see (whitelist).
   * Empty array = all types (if exportEvents is true).
   * Default: [] (all types if exportEvents is true)
   */
  visibleEventTypes?: string[];

  /**
   * Agent IDs peers can query (whitelist).
   * Empty array = all agents.
   * Default: [] (all agents)
   */
  visibleAgents?: string[];
}

/**
 * Extended store configuration with instance and namespace support.
 */
export interface StoreConfig {
  /**
   * Instance identifier.
   * - Omit: Auto-generate new ID (new instance)
   * - Provide: Resume existing or create with specific ID
   */
  instanceId?: string;

  /**
   * Namespace for discovery and coordination.
   * Instances in same namespace can discover each other.
   * Default: "default"
   */
  namespace?: string;

  /**
   * Base directory for all storage.
   * Default: ~/.multiagent
   */
  baseDir?: string;

  /**
   * Storage backend configuration.
   * Default: SQLite backend
   */
  backend?: StorageBackendConfig;

  /**
   * In-memory mode (no persistence).
   * Useful for testing.
   */
  inMemory?: boolean;

  /**
   * Optional human-readable label for the instance.
   */
  label?: string;

  /**
   * Custom metadata to store with the instance.
   */
  customMeta?: Record<string, unknown>;

  /**
   * Peer visibility configuration.
   * Controls what local state peers can access.
   * Default: restrictive (no sharing)
   */
  peerVisibility?: PeerVisibilityConfig;

  // ─── Legacy options (backward compatible) ───

  /**
   * @deprecated Use baseDir + instanceId instead.
   * Legacy path option for backward compatibility.
   */
  path?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Instance Metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instance metadata stored in meta.json
 */
export interface InstanceMeta {
  /** Instance ID */
  id: string;

  /** Namespace this instance belongs to */
  namespace: string;

  /** Creation timestamp */
  createdAt: number;

  /** Last accessed timestamp */
  lastAccessedAt: number;

  /** Backend type used */
  backendType: string;

  /** Optional human-readable label */
  label?: string;

  /** Custom metadata from client */
  custom?: Record<string, unknown>;

  /** Peer visibility configuration */
  peerVisibility?: PeerVisibilityConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Namespace Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry entry for an instance in a namespace
 */
export interface NamespaceRegistryEntry {
  /** When registered */
  registeredAt: number;

  /** Last heartbeat */
  lastSeenAt: number;

  /** Connection info for peer protocol */
  peerEndpoint?: string;

  /** Instance label */
  label?: string;
}

/**
 * Namespace registry stored in namespaces/<namespace>/instances.json
 */
export interface NamespaceRegistry {
  namespace: string;
  instances: Record<string, NamespaceRegistryEntry>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovered Instance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Information about a discovered instance
 */
export interface DiscoveredInstance {
  instanceId: string;
  namespace: string;
  lastSeenAt: number;
  peerEndpoint?: string;
  label?: string;
}

/**
 * Options for discovering instances
 */
export interface DiscoveryOptions {
  /** Base directory (default: ~/.multiagent) */
  baseDir?: string;

  /** Max age in seconds to consider "active" */
  maxAge?: number;

  /** Filter by label pattern (substring match) */
  labelPattern?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of resolving instance configuration
 */
export interface ResolvedInstance {
  /** Instance ID */
  instanceId: string;

  /** Full path to instance directory */
  instancePath: string;

  /** Namespace */
  namespace: string;

  /** Whether this is a new instance */
  isNew: boolean;

  /** Whether this is using legacy path mode */
  isLegacy: boolean;

  /** Backend type to use */
  backendType: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default base directory */
export const DEFAULT_BASE_DIR = path.join(os.homedir(), '.multiagent');

/** Default namespace */
export const DEFAULT_NAMESPACE = 'default';

/** Default backend type */
export const DEFAULT_BACKEND_TYPE = 'sqlite';

/** Instance ID prefix */
export const INSTANCE_ID_PREFIX = 'inst_';

// ─────────────────────────────────────────────────────────────────────────────
// Instance ID Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a new instance ID.
 * Format: inst_<12-char nanoid>
 */
export function generateInstanceId(): string {
  return `${INSTANCE_ID_PREFIX}${nanoid(12)}`;
}

/**
 * Check if a string is a valid instance ID
 */
export function isValidInstanceId(id: string): boolean {
  // Allow both generated IDs (inst_xxx) and custom IDs (alphanumeric, dash, underscore)
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the base directory, creating it if needed
 */
export function getBaseDir(config: StoreConfig): string {
  const baseDir = config.baseDir ?? DEFAULT_BASE_DIR;
  if (!config.inMemory && !fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }
  return baseDir;
}

/**
 * Get the instances directory
 */
export function getInstancesDir(baseDir: string): string {
  return path.join(baseDir, 'instances');
}

/**
 * Get the namespaces directory
 */
export function getNamespacesDir(baseDir: string): string {
  return path.join(baseDir, 'namespaces');
}

/**
 * Resolve instance path and configuration.
 */
export function resolveInstancePath(config: StoreConfig): ResolvedInstance {
  const baseDir = getBaseDir(config);
  const namespace = config.namespace ?? DEFAULT_NAMESPACE;

  // In-memory mode: No persistence
  if (config.inMemory) {
    const instanceId = config.instanceId ?? generateInstanceId();
    return {
      instanceId,
      instancePath: ':memory:',
      namespace,
      isNew: true,
      isLegacy: false,
      backendType: 'memory',
    };
  }

  // Legacy path takes precedence for backward compat
  if (config.path) {
    const legacyInstanceId = deriveInstanceIdFromPath(config.path);
    return {
      instanceId: legacyInstanceId,
      instancePath: config.path,
      namespace,
      isNew: !fs.existsSync(config.path),
      isLegacy: true,
      backendType: 'json',
    };
  }

  // New instance resolution
  const instanceId = config.instanceId ?? generateInstanceId();

  if (!isValidInstanceId(instanceId)) {
    throw new Error(
      `Invalid instance ID: "${instanceId}". ` +
        'Instance IDs must be alphanumeric with dashes and underscores only.'
    );
  }

  const instancesDir = getInstancesDir(baseDir);
  const instancePath = path.join(instancesDir, instanceId);
  const isNew = !fs.existsSync(instancePath);

  const backendType = config.backend?.type ?? DEFAULT_BACKEND_TYPE;

  return {
    instanceId,
    instancePath,
    namespace,
    isNew,
    isLegacy: false,
    backendType,
  };
}

/**
 * Derive an instance ID from a legacy path
 */
function deriveInstanceIdFromPath(legacyPath: string): string {
  // Use the filename without extension as the instance ID
  const basename = path.basename(legacyPath, path.extname(legacyPath));
  // Sanitize to valid instance ID
  return basename.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ─────────────────────────────────────────────────────────────────────────────
// Instance Directory Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure instance directory exists and is properly initialized.
 */
export function ensureInstanceDir(instancePath: string): void {
  if (instancePath === ':memory:') return;

  if (!fs.existsSync(instancePath)) {
    fs.mkdirSync(instancePath, { recursive: true });
  }
}

/**
 * Get the path to instance metadata file
 */
export function getMetaPath(instancePath: string): string {
  return path.join(instancePath, 'meta.json');
}

/**
 * Read instance metadata
 */
export function readInstanceMeta(instancePath: string): InstanceMeta | null {
  const metaPath = getMetaPath(instancePath);
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write instance metadata
 */
export function writeInstanceMeta(
  instancePath: string,
  meta: InstanceMeta
): void {
  if (instancePath === ':memory:') return;

  ensureInstanceDir(instancePath);
  const metaPath = getMetaPath(instancePath);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Update last accessed timestamp
 */
export function touchInstance(instancePath: string): void {
  const meta = readInstanceMeta(instancePath);
  if (meta) {
    meta.lastAccessedAt = Date.now();
    writeInstanceMeta(instancePath, meta);
  }
}

/**
 * Create initial instance metadata
 */
export function createInstanceMeta(
  resolved: ResolvedInstance,
  config: StoreConfig
): InstanceMeta {
  const now = Date.now();
  return {
    id: resolved.instanceId,
    namespace: resolved.namespace,
    createdAt: now,
    lastAccessedAt: now,
    backendType: resolved.backendType,
    label: config.label,
    custom: config.customMeta,
    peerVisibility: config.peerVisibility,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Namespace Registry Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get path to namespace registry
 */
export function getNamespaceRegistryPath(
  baseDir: string,
  namespace: string
): string {
  return path.join(getNamespacesDir(baseDir), namespace, 'instances.json');
}

/**
 * Read namespace registry
 */
export function readNamespaceRegistry(
  baseDir: string,
  namespace: string
): NamespaceRegistry {
  const registryPath = getNamespaceRegistryPath(baseDir, namespace);
  if (fs.existsSync(registryPath)) {
    try {
      return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    } catch {
      // Fall through to return empty registry
    }
  }
  return { namespace, instances: {} };
}

/**
 * Write namespace registry
 */
export function writeNamespaceRegistry(
  baseDir: string,
  registry: NamespaceRegistry
): void {
  const registryPath = getNamespaceRegistryPath(baseDir, registry.namespace);
  const registryDir = path.dirname(registryPath);

  if (!fs.existsSync(registryDir)) {
    fs.mkdirSync(registryDir, { recursive: true });
  }

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

/**
 * Register an instance in a namespace
 */
export function registerInstance(
  baseDir: string,
  namespace: string,
  instanceId: string,
  options?: {
    peerEndpoint?: string;
    label?: string;
  }
): void {
  const registry = readNamespaceRegistry(baseDir, namespace);
  const now = Date.now();

  registry.instances[instanceId] = {
    registeredAt: registry.instances[instanceId]?.registeredAt ?? now,
    lastSeenAt: now,
    peerEndpoint: options?.peerEndpoint,
    label: options?.label,
  };

  writeNamespaceRegistry(baseDir, registry);
}

/**
 * Update instance heartbeat in namespace registry
 */
export function updateInstanceHeartbeat(
  baseDir: string,
  namespace: string,
  instanceId: string,
  peerEndpoint?: string
): void {
  const registry = readNamespaceRegistry(baseDir, namespace);

  if (registry.instances[instanceId]) {
    registry.instances[instanceId].lastSeenAt = Date.now();
    if (peerEndpoint !== undefined) {
      registry.instances[instanceId].peerEndpoint = peerEndpoint;
    }
    writeNamespaceRegistry(baseDir, registry);
  }
}

/**
 * Unregister an instance from a namespace
 */
export function unregisterInstance(
  baseDir: string,
  namespace: string,
  instanceId: string
): void {
  const registry = readNamespaceRegistry(baseDir, namespace);
  delete registry.instances[instanceId];
  writeNamespaceRegistry(baseDir, registry);
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discover instances in a namespace
 */
export async function discoverInstances(
  namespace: string,
  options?: DiscoveryOptions
): Promise<DiscoveredInstance[]> {
  const baseDir = options?.baseDir ?? DEFAULT_BASE_DIR;
  const registry = readNamespaceRegistry(baseDir, namespace);
  const now = Date.now();
  const maxAgeMs = options?.maxAge ? options.maxAge * 1000 : undefined;

  const instances: DiscoveredInstance[] = [];

  for (const [instanceId, entry] of Object.entries(registry.instances)) {
    // Filter by age
    if (maxAgeMs !== undefined && now - entry.lastSeenAt > maxAgeMs) {
      continue;
    }

    // Filter by label pattern
    if (
      options?.labelPattern &&
      (!entry.label || !entry.label.includes(options.labelPattern))
    ) {
      continue;
    }

    instances.push({
      instanceId,
      namespace,
      lastSeenAt: entry.lastSeenAt,
      peerEndpoint: entry.peerEndpoint,
      label: entry.label,
    });
  }

  // Sort by most recently seen first
  instances.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  return instances;
}

/**
 * List all namespaces that have registered instances
 */
export async function listNamespaces(baseDir?: string): Promise<string[]> {
  const dir = getNamespacesDir(baseDir ?? DEFAULT_BASE_DIR);

  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * List all instances (across all namespaces or in a specific namespace)
 */
export async function listInstances(options?: {
  baseDir?: string;
  namespace?: string;
}): Promise<DiscoveredInstance[]> {
  const baseDir = options?.baseDir ?? DEFAULT_BASE_DIR;

  if (options?.namespace) {
    return discoverInstances(options.namespace, { baseDir });
  }

  // List all namespaces and aggregate
  const namespaces = await listNamespaces(baseDir);
  const allInstances: DiscoveredInstance[] = [];

  for (const namespace of namespaces) {
    const instances = await discoverInstances(namespace, { baseDir });
    allInstances.push(...instances);
  }

  return allInstances;
}

// ─────────────────────────────────────────────────────────────────────────────
// Peer Visibility Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default restrictive visibility config (no sharing)
 */
export const DEFAULT_PEER_VISIBILITY: PeerVisibilityConfig = {
  exportEvents: false,
  visibleEventTypes: [],
  visibleAgents: [],
};

/**
 * Check if peer visibility allows event export
 */
export function canPeerExportEvents(visibility?: PeerVisibilityConfig): boolean {
  return visibility?.exportEvents === true;
}

/**
 * Check if a specific event type is visible to peers
 */
export function isEventTypeVisibleToPeers(
  eventType: string,
  visibility?: PeerVisibilityConfig
): boolean {
  if (!canPeerExportEvents(visibility)) {
    return false;
  }
  // Empty array means all types are visible
  if (!visibility?.visibleEventTypes || visibility.visibleEventTypes.length === 0) {
    return true;
  }
  return visibility.visibleEventTypes.includes(eventType);
}

/**
 * Check if a specific agent is visible to peers
 */
export function isAgentVisibleToPeers(
  agentId: string,
  visibility?: PeerVisibilityConfig
): boolean {
  if (!canPeerExportEvents(visibility)) {
    return false;
  }
  // Empty array means all agents are visible
  if (!visibility?.visibleAgents || visibility.visibleAgents.length === 0) {
    return true;
  }
  return visibility.visibleAgents.includes(agentId);
}

/**
 * Filter events based on peer visibility config.
 * Returns only events that peers are allowed to see.
 */
export function filterEventsForPeer<T extends { type: string; source: { agent_id?: string } }>(
  events: T[],
  visibility?: PeerVisibilityConfig
): T[] {
  if (!canPeerExportEvents(visibility)) {
    return [];
  }

  return events.filter((event) => {
    // Check event type visibility
    if (!isEventTypeVisibleToPeers(event.type, visibility)) {
      return false;
    }
    // Check agent visibility
    if (event.source?.agent_id && !isAgentVisibleToPeers(event.source.agent_id, visibility)) {
      return false;
    }
    return true;
  });
}
