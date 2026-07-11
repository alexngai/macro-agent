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
  /**
   * Bearer token required on every request except `/api/health`. Falls back to
   * the `MACRO_SERVER_TOKEN` env var. When unset, the server refuses to bind to
   * a non-loopback host (see auth/server-auth).
   */
  token?: string;
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
