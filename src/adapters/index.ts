/**
 * Adapter layer — the only touch points between macro-agent and subsystems.
 *
 * @module adapters
 */

export type {
  InboxAdapter,
  TasksAdapter,
  InboxDeliveryEvent,
  SignalFilterFn,
  EmissionValidatorFn,
  RegisterAgentOptions,
  SendMessageOptions,
  DeliveryHandler,
  TaskStatus,
  TaskAction,
  CreateTaskOptions,
  TaskQueryOptions,
  TaskRecord,
} from "./types.js";

export {
  DefaultInboxAdapter,
  type InboxAdapterConfig,
} from "./inbox-adapter.js";

export {
  DefaultTasksAdapter,
  type TasksAdapterConfig,
} from "./tasks-adapter.js";

export {
  ensureOpentasksDaemon,
  type DaemonHandle,
  type EnsureDaemonOptions,
} from "./opentasks-daemon.js";
