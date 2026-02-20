/**
 * Authentication Token Utilities
 *
 * Provides token generation, secure comparison, and per-agent
 * token management for the macro-agent server.
 */

import * as crypto from "crypto";

// =============================================================================
// Token Generation
// =============================================================================

/**
 * Generate a cryptographically random hex token.
 */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

// =============================================================================
// Secure Comparison
// =============================================================================

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

// =============================================================================
// Agent Token Manager
// =============================================================================

/**
 * Manages per-agent authentication tokens.
 *
 * Each spawned agent gets a unique token at spawn time. The token is
 * passed to the subprocess via environment variable and validated on
 * every MCP bridge RPC call.
 */
export class AgentTokenManager {
  private tokens = new Map<string, string>();

  /**
   * Create and store a token for an agent. Returns the generated token.
   */
  createToken(agentId: string): string {
    const token = generateToken();
    this.tokens.set(agentId, token);
    return token;
  }

  /**
   * Verify that a token matches the one stored for an agent.
   */
  verifyToken(agentId: string, token: string): boolean {
    const stored = this.tokens.get(agentId);
    if (!stored) return false;
    return secureCompare(stored, token);
  }

  /**
   * Revoke an agent's token (e.g., on terminate).
   */
  revokeToken(agentId: string): boolean {
    return this.tokens.delete(agentId);
  }

  /**
   * Check if an agent has a registered token.
   */
  hasToken(agentId: string): boolean {
    return this.tokens.has(agentId);
  }
}
