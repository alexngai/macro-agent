/**
 * REST API request/response types.
 *
 * @module api/types
 */

import type { Express } from "express";

// =============================================================================
// Server
// =============================================================================

export interface ApiServer {
  /** Express application instance */
  app: Express;
  /** Start listening */
  start(): Promise<void>;
  /** Stop the server */
  stop(): Promise<void>;
}

export interface ApiServerConfig {
  port?: number;
  host?: string;
}

// =============================================================================
// Responses
// =============================================================================

export interface HealthResponse {
  ok: true;
  uptime: number;
  version: string;
}

export interface ErrorResponse {
  error: string;
}
