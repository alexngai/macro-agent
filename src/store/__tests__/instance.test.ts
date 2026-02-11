/**
 * Tests for Instance and Namespace Resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  generateInstanceId,
  isValidInstanceId,
  resolveInstancePath,
  ensureInstanceDir,
  readInstanceMeta,
  writeInstanceMeta,
  createInstanceMeta,
  registerInstance,
  readNamespaceRegistry,
  discoverInstances,
  listNamespaces,
  listInstances,
  unregisterInstance,
  INSTANCE_ID_PREFIX,
  DEFAULT_NAMESPACE,
  DEFAULT_BACKEND_TYPE,
  DEFAULT_PEER_VISIBILITY,
  canPeerExportEvents,
  isEventTypeVisibleToPeers,
  isAgentVisibleToPeers,
  filterEventsForPeer,
  type StoreConfig,
  type InstanceMeta,
  type PeerVisibilityConfig,
} from '../instance.js';

// Test directory that will be cleaned up
let testBaseDir: string;

function createTestBaseDir(): string {
  const dir = path.join(os.tmpdir(), `macro-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Instance ID Generation', () => {
  it('should generate valid instance IDs', () => {
    const id = generateInstanceId();
    expect(id).toMatch(/^inst_[a-zA-Z0-9_-]{12}$/);
    expect(id.startsWith(INSTANCE_ID_PREFIX)).toBe(true);
  });

  it('should generate unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateInstanceId());
    }
    expect(ids.size).toBe(100);
  });

  it('should validate instance IDs correctly', () => {
    expect(isValidInstanceId('inst_abc123')).toBe(true);
    expect(isValidInstanceId('my-custom-id')).toBe(true);
    expect(isValidInstanceId('test_123_abc')).toBe(true);
    expect(isValidInstanceId('')).toBe(false);
    expect(isValidInstanceId('has spaces')).toBe(false);
    expect(isValidInstanceId('has/slash')).toBe(false);
    expect(isValidInstanceId('has.dot')).toBe(false);
  });
});

describe('Path Resolution', () => {
  beforeEach(() => {
    testBaseDir = createTestBaseDir();
  });

  afterEach(() => {
    cleanupTestDir(testBaseDir);
  });

  it('should resolve in-memory instances', () => {
    const config: StoreConfig = { inMemory: true };
    const resolved = resolveInstancePath(config);

    expect(resolved.instancePath).toBe(':memory:');
    expect(resolved.isNew).toBe(true);
    expect(resolved.backendType).toBe('memory');
    expect(resolved.instanceId).toMatch(/^inst_/);
  });

  it('should resolve in-memory with custom instance ID', () => {
    const config: StoreConfig = { inMemory: true, instanceId: 'my-test' };
    const resolved = resolveInstancePath(config);

    expect(resolved.instanceId).toBe('my-test');
    expect(resolved.instancePath).toBe(':memory:');
  });

  it('should generate new instance ID when not provided', () => {
    const config: StoreConfig = { baseDir: testBaseDir };
    const resolved = resolveInstancePath(config);

    expect(resolved.instanceId).toMatch(/^inst_/);
    expect(resolved.isNew).toBe(true);
    expect(resolved.backendType).toBe(DEFAULT_BACKEND_TYPE);
    expect(resolved.namespace).toBe(DEFAULT_NAMESPACE);
  });

  it('should use provided instance ID', () => {
    const config: StoreConfig = { baseDir: testBaseDir, instanceId: 'my-session' };
    const resolved = resolveInstancePath(config);

    expect(resolved.instanceId).toBe('my-session');
    expect(resolved.instancePath).toContain('my-session');
    expect(resolved.isNew).toBe(true);
  });

  it('should detect existing instances', () => {
    const config: StoreConfig = { baseDir: testBaseDir, instanceId: 'existing' };

    // Create the instance directory
    const instancePath = path.join(testBaseDir, 'instances', 'existing');
    fs.mkdirSync(instancePath, { recursive: true });

    const resolved = resolveInstancePath(config);

    expect(resolved.isNew).toBe(false);
    expect(resolved.instancePath).toBe(instancePath);
  });

  it('should use custom namespace', () => {
    const config: StoreConfig = { baseDir: testBaseDir, namespace: 'my-project' };
    const resolved = resolveInstancePath(config);

    expect(resolved.namespace).toBe('my-project');
  });

  it('should ignore legacy path option and use defaults', () => {
    const legacyPath = path.join(testBaseDir, 'legacy-store.json');
    const config: StoreConfig = { path: legacyPath, baseDir: testBaseDir };
    const resolved = resolveInstancePath(config);

    // path option is no longer handled — resolveInstancePath ignores it
    expect(resolved.backendType).toBe(DEFAULT_BACKEND_TYPE);
    expect(resolved.instanceId).toMatch(/^inst_/);
  });

  it('should throw on invalid instance ID', () => {
    const config: StoreConfig = { baseDir: testBaseDir, instanceId: 'invalid/id' };
    expect(() => resolveInstancePath(config)).toThrow('Invalid instance ID');
  });

  it('should use custom backend type', () => {
    const config: StoreConfig = {
      baseDir: testBaseDir,
      backend: { type: 'memory' },
    };
    const resolved = resolveInstancePath(config);

    expect(resolved.backendType).toBe('memory');
  });
});

describe('Instance Metadata', () => {
  beforeEach(() => {
    testBaseDir = createTestBaseDir();
  });

  afterEach(() => {
    cleanupTestDir(testBaseDir);
  });

  it('should create and read instance metadata', () => {
    const instancePath = path.join(testBaseDir, 'test-instance');
    ensureInstanceDir(instancePath);

    const meta: InstanceMeta = {
      id: 'test-instance',
      namespace: 'default',
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      backendType: 'sqlite',
      label: 'Test Instance',
      custom: { foo: 'bar' },
    };

    writeInstanceMeta(instancePath, meta);
    const readMeta = readInstanceMeta(instancePath);

    expect(readMeta).toEqual(meta);
  });

  it('should return null for non-existent metadata', () => {
    const instancePath = path.join(testBaseDir, 'non-existent');
    const meta = readInstanceMeta(instancePath);

    expect(meta).toBeNull();
  });

  it('should create instance metadata from resolved config', () => {
    const config: StoreConfig = {
      baseDir: testBaseDir,
      instanceId: 'my-instance',
      namespace: 'my-project',
      label: 'My Label',
      customMeta: { version: '1.0' },
    };

    const resolved = resolveInstancePath(config);
    const meta = createInstanceMeta(resolved, config);

    expect(meta.id).toBe('my-instance');
    expect(meta.namespace).toBe('my-project');
    expect(meta.backendType).toBe('sqlite');
    expect(meta.label).toBe('My Label');
    expect(meta.custom).toEqual({ version: '1.0' });
    expect(meta.createdAt).toBeDefined();
    expect(meta.lastAccessedAt).toBeDefined();
  });

  it('should not write metadata for in-memory instances', () => {
    writeInstanceMeta(':memory:', {
      id: 'test',
      namespace: 'default',
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      backendType: 'memory',
    });

    // Should not throw, just be a no-op
    expect(true).toBe(true);
  });
});

describe('Namespace Registry', () => {
  beforeEach(() => {
    testBaseDir = createTestBaseDir();
  });

  afterEach(() => {
    cleanupTestDir(testBaseDir);
  });

  it('should register instances in namespace', () => {
    registerInstance(testBaseDir, 'my-project', 'inst-1', {
      label: 'Worker 1',
      peerEndpoint: 'ws://localhost:3001',
    });

    const registry = readNamespaceRegistry(testBaseDir, 'my-project');

    expect(registry.namespace).toBe('my-project');
    expect(registry.instances['inst-1']).toBeDefined();
    expect(registry.instances['inst-1'].label).toBe('Worker 1');
    expect(registry.instances['inst-1'].peerEndpoint).toBe('ws://localhost:3001');
  });

  it('should update existing instance registration', () => {
    registerInstance(testBaseDir, 'my-project', 'inst-1');
    const firstRegistry = readNamespaceRegistry(testBaseDir, 'my-project');
    const firstRegisteredAt = firstRegistry.instances['inst-1'].registeredAt;

    // Wait a bit and register again
    registerInstance(testBaseDir, 'my-project', 'inst-1', {
      peerEndpoint: 'ws://localhost:3002',
    });

    const registry = readNamespaceRegistry(testBaseDir, 'my-project');

    // registeredAt should be preserved
    expect(registry.instances['inst-1'].registeredAt).toBe(firstRegisteredAt);
    // lastSeenAt should be updated
    expect(registry.instances['inst-1'].lastSeenAt).toBeGreaterThanOrEqual(firstRegisteredAt);
    // New endpoint
    expect(registry.instances['inst-1'].peerEndpoint).toBe('ws://localhost:3002');
  });

  it('should unregister instances', () => {
    registerInstance(testBaseDir, 'my-project', 'inst-1');
    registerInstance(testBaseDir, 'my-project', 'inst-2');

    unregisterInstance(testBaseDir, 'my-project', 'inst-1');

    const registry = readNamespaceRegistry(testBaseDir, 'my-project');

    expect(registry.instances['inst-1']).toBeUndefined();
    expect(registry.instances['inst-2']).toBeDefined();
  });

  it('should return empty registry for non-existent namespace', () => {
    const registry = readNamespaceRegistry(testBaseDir, 'non-existent');

    expect(registry.namespace).toBe('non-existent');
    expect(Object.keys(registry.instances)).toHaveLength(0);
  });
});

describe('Discovery', () => {
  beforeEach(() => {
    testBaseDir = createTestBaseDir();
  });

  afterEach(() => {
    cleanupTestDir(testBaseDir);
  });

  it('should discover instances in namespace', async () => {
    registerInstance(testBaseDir, 'my-project', 'inst-1', { label: 'Worker 1' });
    registerInstance(testBaseDir, 'my-project', 'inst-2', { label: 'Worker 2' });
    registerInstance(testBaseDir, 'other-project', 'inst-3');

    const instances = await discoverInstances('my-project', { baseDir: testBaseDir });

    expect(instances).toHaveLength(2);
    expect(instances.map((i) => i.instanceId).sort()).toEqual(['inst-1', 'inst-2']);
  });

  it('should filter by max age', async () => {
    // Register an old instance
    registerInstance(testBaseDir, 'my-project', 'old-inst');

    // Manually update the lastSeenAt to be old
    const registry = readNamespaceRegistry(testBaseDir, 'my-project');
    registry.instances['old-inst'].lastSeenAt = Date.now() - 120000; // 2 minutes ago

    // Write back
    const registryPath = path.join(testBaseDir, 'namespaces', 'my-project', 'instances.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    // Register a recent instance
    registerInstance(testBaseDir, 'my-project', 'new-inst');

    // Should only find new instance with 60 second max age
    const instances = await discoverInstances('my-project', {
      baseDir: testBaseDir,
      maxAge: 60,
    });

    expect(instances).toHaveLength(1);
    expect(instances[0].instanceId).toBe('new-inst');
  });

  it('should filter by label pattern', async () => {
    registerInstance(testBaseDir, 'my-project', 'inst-1', { label: 'production-worker' });
    registerInstance(testBaseDir, 'my-project', 'inst-2', { label: 'staging-worker' });
    registerInstance(testBaseDir, 'my-project', 'inst-3', { label: 'production-api' });

    const instances = await discoverInstances('my-project', {
      baseDir: testBaseDir,
      labelPattern: 'production',
    });

    expect(instances).toHaveLength(2);
    expect(instances.map((i) => i.instanceId).sort()).toEqual(['inst-1', 'inst-3']);
  });

  it('should list all namespaces', async () => {
    registerInstance(testBaseDir, 'project-a', 'inst-1');
    registerInstance(testBaseDir, 'project-b', 'inst-2');
    registerInstance(testBaseDir, 'project-c', 'inst-3');

    const namespaces = await listNamespaces(testBaseDir);

    expect(namespaces.sort()).toEqual(['project-a', 'project-b', 'project-c']);
  });

  it('should list all instances across namespaces', async () => {
    registerInstance(testBaseDir, 'project-a', 'inst-1');
    registerInstance(testBaseDir, 'project-b', 'inst-2');
    registerInstance(testBaseDir, 'project-b', 'inst-3');

    const instances = await listInstances({ baseDir: testBaseDir });

    expect(instances).toHaveLength(3);
    expect(instances.map((i) => i.instanceId).sort()).toEqual(['inst-1', 'inst-2', 'inst-3']);
  });

  it('should return empty array for namespace with no instances', async () => {
    const instances = await discoverInstances('empty-namespace', { baseDir: testBaseDir });
    expect(instances).toHaveLength(0);
  });
});

describe('Directory Structure', () => {
  beforeEach(() => {
    testBaseDir = createTestBaseDir();
  });

  afterEach(() => {
    cleanupTestDir(testBaseDir);
  });

  it('should create instance directory on demand', () => {
    const instancePath = path.join(testBaseDir, 'instances', 'new-instance');

    expect(fs.existsSync(instancePath)).toBe(false);

    ensureInstanceDir(instancePath);

    expect(fs.existsSync(instancePath)).toBe(true);
  });

  it('should not fail on existing directory', () => {
    const instancePath = path.join(testBaseDir, 'instances', 'existing');
    fs.mkdirSync(instancePath, { recursive: true });

    expect(() => ensureInstanceDir(instancePath)).not.toThrow();
  });

  it('should create namespace directory structure', () => {
    registerInstance(testBaseDir, 'my-namespace', 'my-instance');

    const namespaceDir = path.join(testBaseDir, 'namespaces', 'my-namespace');
    const registryFile = path.join(namespaceDir, 'instances.json');

    expect(fs.existsSync(namespaceDir)).toBe(true);
    expect(fs.existsSync(registryFile)).toBe(true);
  });
});

describe('Peer Visibility', () => {
  describe('DEFAULT_PEER_VISIBILITY', () => {
    it('should be restrictive by default', () => {
      expect(DEFAULT_PEER_VISIBILITY.exportEvents).toBe(false);
      expect(DEFAULT_PEER_VISIBILITY.visibleEventTypes).toEqual([]);
      expect(DEFAULT_PEER_VISIBILITY.visibleAgents).toEqual([]);
    });
  });

  describe('canPeerExportEvents', () => {
    it('should return false when undefined', () => {
      expect(canPeerExportEvents(undefined)).toBe(false);
    });

    it('should return false for default config', () => {
      expect(canPeerExportEvents(DEFAULT_PEER_VISIBILITY)).toBe(false);
    });

    it('should return false when exportEvents is false', () => {
      expect(canPeerExportEvents({ exportEvents: false })).toBe(false);
    });

    it('should return true when exportEvents is true', () => {
      expect(canPeerExportEvents({ exportEvents: true })).toBe(true);
    });
  });

  describe('isEventTypeVisibleToPeers', () => {
    it('should return false when export is not enabled', () => {
      expect(isEventTypeVisibleToPeers('spawn', undefined)).toBe(false);
      expect(isEventTypeVisibleToPeers('spawn', { exportEvents: false })).toBe(false);
    });

    it('should return true for any type when visibleEventTypes is empty', () => {
      const visibility: PeerVisibilityConfig = { exportEvents: true, visibleEventTypes: [] };
      expect(isEventTypeVisibleToPeers('spawn', visibility)).toBe(true);
      expect(isEventTypeVisibleToPeers('message', visibility)).toBe(true);
      expect(isEventTypeVisibleToPeers('task', visibility)).toBe(true);
    });

    it('should filter by whitelist when visibleEventTypes is specified', () => {
      const visibility: PeerVisibilityConfig = {
        exportEvents: true,
        visibleEventTypes: ['spawn', 'terminate'],
      };
      expect(isEventTypeVisibleToPeers('spawn', visibility)).toBe(true);
      expect(isEventTypeVisibleToPeers('terminate', visibility)).toBe(true);
      expect(isEventTypeVisibleToPeers('message', visibility)).toBe(false);
    });
  });

  describe('isAgentVisibleToPeers', () => {
    it('should return false when export is not enabled', () => {
      expect(isAgentVisibleToPeers('agent-1', undefined)).toBe(false);
      expect(isAgentVisibleToPeers('agent-1', { exportEvents: false })).toBe(false);
    });

    it('should return true for any agent when visibleAgents is empty', () => {
      const visibility: PeerVisibilityConfig = { exportEvents: true, visibleAgents: [] };
      expect(isAgentVisibleToPeers('agent-1', visibility)).toBe(true);
      expect(isAgentVisibleToPeers('agent-2', visibility)).toBe(true);
    });

    it('should filter by whitelist when visibleAgents is specified', () => {
      const visibility: PeerVisibilityConfig = {
        exportEvents: true,
        visibleAgents: ['public-agent-1', 'public-agent-2'],
      };
      expect(isAgentVisibleToPeers('public-agent-1', visibility)).toBe(true);
      expect(isAgentVisibleToPeers('public-agent-2', visibility)).toBe(true);
      expect(isAgentVisibleToPeers('private-agent', visibility)).toBe(false);
    });
  });

  describe('filterEventsForPeer', () => {
    const testEvents = [
      { type: 'spawn', source: { agent_id: 'agent-1' }, payload: {} },
      { type: 'message', source: { agent_id: 'agent-1' }, payload: {} },
      { type: 'spawn', source: { agent_id: 'agent-2' }, payload: {} },
      { type: 'terminate', source: { agent_id: 'agent-2' }, payload: {} },
    ];

    it('should return empty array when export is disabled', () => {
      expect(filterEventsForPeer(testEvents, undefined)).toEqual([]);
      expect(filterEventsForPeer(testEvents, { exportEvents: false })).toEqual([]);
    });

    it('should return all events when fully permissive', () => {
      const visibility: PeerVisibilityConfig = {
        exportEvents: true,
        visibleEventTypes: [],
        visibleAgents: [],
      };
      expect(filterEventsForPeer(testEvents, visibility)).toEqual(testEvents);
    });

    it('should filter by event type', () => {
      const visibility: PeerVisibilityConfig = {
        exportEvents: true,
        visibleEventTypes: ['spawn'],
        visibleAgents: [],
      };
      const filtered = filterEventsForPeer(testEvents, visibility);
      expect(filtered).toHaveLength(2);
      expect(filtered.every(e => e.type === 'spawn')).toBe(true);
    });

    it('should filter by agent', () => {
      const visibility: PeerVisibilityConfig = {
        exportEvents: true,
        visibleEventTypes: [],
        visibleAgents: ['agent-1'],
      };
      const filtered = filterEventsForPeer(testEvents, visibility);
      expect(filtered).toHaveLength(2);
      expect(filtered.every(e => e.source.agent_id === 'agent-1')).toBe(true);
    });

    it('should filter by both event type and agent', () => {
      const visibility: PeerVisibilityConfig = {
        exportEvents: true,
        visibleEventTypes: ['spawn'],
        visibleAgents: ['agent-2'],
      };
      const filtered = filterEventsForPeer(testEvents, visibility);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toEqual({ type: 'spawn', source: { agent_id: 'agent-2' }, payload: {} });
    });
  });
});
