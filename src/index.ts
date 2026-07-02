/**
 * macro-agent - Multi-agent orchestration system (V2)
 */

// Store types (primitives used everywhere)
export {
  type Agent,
  type AgentState,
  type StopReason,
  type AgentConfig,
  type Task,
  type TaskStatus,
  type TaskAction,
  type ArtifactRef,
  type AgentHistoryEntry,
  type Event,
  type EventInput,
  type EventFilter,
  type EventType,
  type EventSource,
  type EventTarget,
  type EventMetadata,
  type AgentId,
  type TaskId,
  type EventId,
  type SessionId,
  type Timestamp,
  type QueuedMessage,
  type Subscription,
  type SubscriptionType,
  CURRENT_EVENT_VERSION,
} from './store/types/index.js';

// Agent manager (interface + V2 factory)
export {
  createAgentManager,
  createAgentManagerV2,
  type AgentManager,
  type AgentManagerConfig,
  type SpawnInterceptor,
} from './agent/agent-manager.js';

export {
  type SpawnAgentOptions,
  type SpawnedAgent,
  type AgentFilter,
  type AgentHierarchy,
  type AgentHierarchyNode,
  type ActiveSession,
  type AgentStopReason,
  type HeadManagerOptions,
  type SystemPromptContext,
  type AgentLifecycleEvent,
  type AgentLifecycleCallback,
  AgentManagerError,
  type AgentManagerErrorCode,
  type MCPServerConfig as AgentMCPServerConfig,
  type MCPServerStdioConfig as AgentMCPServerStdioConfig,
  type MCPServerHttpConfig as AgentMCPServerHttpConfig,
  type AgentConfig as SpawnAgentConfig,
} from './agent/types.js';

export { generateSystemPrompt } from './agent/system-prompt.js';

// Agent store (V2 lifecycle state)
export { AgentStore } from './agent/agent-store.js';

// Adapters (V2 messaging + tasks)
export {
  DefaultInboxAdapter,
} from './adapters/inbox-adapter.js';

export {
  DefaultTasksAdapter,
} from './adapters/tasks-adapter.js';

export {
  type InboxAdapter,
  type TasksAdapter,
} from './adapters/types.js';

// Boot V2
export {
  bootV2,
  type BootV2Config,
  type MacroAgentSystemV2,
} from './boot-v2.js';

// Roles
export {
  type RoleDefinition,
  type RoleRegistry,
  type Capability,
} from './roles/types.js';

export { DefaultRoleRegistry } from './roles/registry.js';
export { AGENT_CAPABILITIES } from './roles/capabilities.js';

// Workspace
export {
  type WorkspaceManager,
  type Workspace,
} from './workspace/types.js';

// Teams - template seeding
export { seedDefaultTemplates } from './teams/seed-defaults.js';

// MAP (sidecar + server)
export { createMAPSidecar, createMAPServerInstance } from './map/index.js';
export type {
  MAPSidecar,
  MAPSidecarConfig,
  MAPServerInstance,
  MapServerConfig,
  TrajectoryCheckpointPayload,
  TrajectoryCheckpointResult,
} from './map/types.js';
