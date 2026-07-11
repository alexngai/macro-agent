/**
 * Server authentication helpers.
 *
 * The macro-agent network servers (REST API, ACP WebSocket, MAP WebSocket) all
 * default-bind to loopback and are opt-in. When an operator exposes one on a
 * non-loopback interface it MUST be authenticated, otherwise it becomes an
 * unauthenticated remote agent-spawn endpoint (i.e. remote code execution).
 *
 * The shared token is `config.serverToken` (also injected into spawned agents
 * as `MACRO_SERVER_TOKEN`), so the same secret authenticates callers and
 * children. These helpers centralize:
 *  - resolving the effective token (config → env),
 *  - deciding whether a bind host is loopback,
 *  - a fail-closed guard that refuses non-loopback binds without a token,
 *  - extracting/validating a bearer token from an HTTP/WS request.
 *
 * @module auth/server-auth
 */

import type * as http from "node:http";
import { secureCompare } from "./token.js";

/** Hosts we consider loopback-only (safe to expose without auth). */
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
]);

/**
 * Resolve the effective server token: explicit config value, else the
 * `MACRO_SERVER_TOKEN` environment variable. Empty strings are treated as
 * "no token".
 */
export function resolveServerToken(configToken?: string): string | undefined {
  const token = configToken ?? process.env.MACRO_SERVER_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

/** True if `host` is a loopback address that is safe to bind without auth. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Fail-closed bind guard. Throws if a server would listen on a non-loopback
 * host without an auth token configured. Call this before `listen()`.
 */
export function assertBindAllowed(
  label: string,
  host: string,
  token: string | undefined,
): void {
  if (!token && !isLoopbackHost(host)) {
    throw new Error(
      `[${label}] Refusing to bind to non-loopback host '${host}' without an auth token. ` +
        `Set config.serverToken (or the MACRO_SERVER_TOKEN env var) to enable authenticated ` +
        `remote access, or bind to 127.0.0.1 for local-only use.`,
    );
  }
}

/** Extract a bearer token from an `Authorization: Bearer <token>` header value. */
export function extractBearerToken(
  headerValue: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof value !== "string") return undefined;
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

/**
 * Validate an incoming HTTP/WebSocket request against the configured token.
 * When no token is configured, requests are allowed (the bind guard keeps such
 * servers loopback-only). Accepts the token via `Authorization: Bearer` or a
 * `?token=` query parameter (the latter for WebSocket clients that cannot set
 * headers).
 */
export function isRequestAuthorized(
  token: string | undefined,
  req: Pick<http.IncomingMessage, "headers" | "url">,
): boolean {
  if (!token) return true;
  const fromHeader = extractBearerToken(req.headers?.authorization);
  let fromQuery: string | undefined;
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    fromQuery = url.searchParams.get("token") ?? undefined;
  } catch {
    // Malformed URL — treat as no query token.
  }
  const provided = fromHeader ?? fromQuery;
  return provided !== undefined && secureCompare(token, provided);
}
