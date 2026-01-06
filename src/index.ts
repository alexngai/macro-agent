/**
 * macro-agent - Multi-agent orchestration system
 */

// Store - core event store and types
export {
  createEventStore,
  type EventStore,
  type AgentChangeCallback,
  type TaskChangeCallback,
  type MessageCallback,
  type Unsubscribe,
} from './store/event-store.js';

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
  type StoreConfig,
  CURRENT_EVENT_VERSION,
} from './store/types/index.js';

// Agent manager
export {
  createAgentManager,
  type AgentManager,
  type AgentManagerConfig,
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
  type AgentConfig as SpawnAgentConfig,
} from './agent/types.js';

export { generateSystemPrompt } from './agent/system-prompt.js';

// Task manager
export {
  createTaskManager,
  type TaskManager,
} from './task/task-manager.js';

export {
  type CreateTaskOptions,
  type UpdateTaskOptions,
  type TaskFilter,
  type SubtaskStatus,
  TaskManagerError,
  type TaskManagerErrorCode,
  VALID_STATUS_TRANSITIONS,
} from './task/types.js';

// Message router
export {
  createMessageRouter,
  type MessageRouter,
  type MessageRouterConfig,
} from './router/message-router.js';

export {
  type MessageTarget,
  type MessageSender,
  type SendMessageRequest,
  type SentMessage,
  type ReceivedMessage,
  type GetMessagesOptions,
  type Channel,
  type ChannelType,
  type DefaultSubscriptionOptions,
  type StatusType as RouterStatusType,
  type EmitStatusRequest,
  type StatusNotification,
  type TruncationConfig,
  RoutingError,
  type RoutingErrorCode,
  DEFAULT_TRUNCATION_CONFIG,
} from './router/types.js';

// MCP server
export {
  createMCPServer,
  type MCPServerConfig,
  type MCPServices,
  type MCPServerInstance,
} from './mcp/mcp-server.js';

export {
  type ToolContext,
  type SpawnAgentInput,
  type SpawnAgentOutput,
  type EmitStatusInput,
  type EmitStatusOutput,
  type SendMessageInput,
  type SendMessageOutput,
  type CheckMessagesInput,
  type CheckMessagesOutput,
  type QueryIndexInput,
  type QueryIndexOutput,
  type GetHierarchyInput,
  type GetHierarchyOutput,
  type HierarchyNode as MCPHierarchyNode,
  type GetAgentSummaryInput,
  type GetAgentSummaryOutput,
  type StopAgentInput,
  type StopAgentOutput,
  type CreateTaskInput,
  type CreateTaskOutput,
  type GetTaskInput,
  type GetTaskOutput,
  MCPToolError,
  type MCPToolErrorCode,
} from './mcp/types.js';

// API server
export {
  createAPIServer,
  type APIServer,
  type APIServerConfig,
  type APIServices,
} from './api/server.js';

export {
  type SystemStatus,
  type InitRequest,
  type InitResponse,
  type ConversationMessageRequest,
  type ConversationMessageResponse,
  type ConversationHistoryEntry,
  type ConversationHistoryResponse,
  type AgentSummary,
  type AgentDetail,
  type AgentListResponse,
  type HierarchyNode as APIHierarchyNode,
  type HierarchyResponse,
  type TaskSummary,
  type TaskDetail,
  type TaskListResponse,
  type EventSummary,
  type EventListResponse,
  type WSMessage,
  type WSMessageType,
  type WSSubscribeMessage,
  type WSAgentUpdate,
  type WSTaskUpdate,
  type WSConversationMessage,
  type AgentQueryParams,
  type TaskQueryParams,
  type EventQueryParams,
  type APIError,
} from './api/types.js';

// ACP - Agent Communication Protocol support
export {
  SessionMapper,
  MacroAgent,
  ACPError,
  type MacroAgentConfig,
  type ACPSessionId,
  type SessionMapping,
  type SpawnAgentRequest as ACPSpawnAgentRequest,
  type SpawnAgentResponse as ACPSpawnAgentResponse,
  type GetHierarchyRequest as ACPGetHierarchyRequest,
  type GetHierarchyResponse as ACPGetHierarchyResponse,
  type GetTaskRequest as ACPGetTaskRequest,
  type GetTaskResponse as ACPGetTaskResponse,
  type MountAgentRequest,
  type MountAgentResponse,
  type ForkAgentRequest,
  type ForkAgentResponse,
  type ACPExtensionMethod,
  type ACPExtensionRequests,
  type ACPExtensionResponses,
  type ACPErrorCode,
} from './acp/index.js';
