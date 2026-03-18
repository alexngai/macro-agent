/**
 * Control Socket — lifecycle RPC for MCP subprocesses
 *
 * @module control
 */

export { ControlServer, type ControlServerConfig, type AgentHealthStatus } from "./control-server.js";
export { ControlClient } from "./control-client.js";
export type {
  ControlCommand,
  ControlResponse,
  ControlSuccessResponse,
  ControlErrorResponse,
  SpawnCommand,
  TerminateCommand,
  HealthCheckCommand,
} from "./types.js";
