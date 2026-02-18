import { describe, it, expect } from "vitest";
import { generateToken, secureCompare, AgentTokenManager } from "../token.js";

describe("generateToken", () => {
  it("generates a hex string of expected length", () => {
    const token = generateToken();
    // 32 bytes = 64 hex chars
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("generates different tokens each time", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });

  it("respects custom byte length", () => {
    const token = generateToken(16);
    expect(token).toHaveLength(32); // 16 bytes = 32 hex chars
  });
});

describe("secureCompare", () => {
  it("returns true for identical strings", () => {
    expect(secureCompare("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(secureCompare("abc123", "xyz789")).toBe(false);
  });

  it("returns false for different length strings", () => {
    expect(secureCompare("short", "longer-string")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(secureCompare("", "")).toBe(true);
  });
});

describe("AgentTokenManager", () => {
  it("creates and verifies a token", () => {
    const mgr = new AgentTokenManager();
    const token = mgr.createToken("agent-1");
    expect(token).toHaveLength(64);
    expect(mgr.verifyToken("agent-1", token)).toBe(true);
  });

  it("rejects wrong token", () => {
    const mgr = new AgentTokenManager();
    mgr.createToken("agent-1");
    expect(mgr.verifyToken("agent-1", "wrong-token")).toBe(false);
  });

  it("rejects unknown agent", () => {
    const mgr = new AgentTokenManager();
    expect(mgr.verifyToken("unknown", "any-token")).toBe(false);
  });

  it("revokes a token", () => {
    const mgr = new AgentTokenManager();
    const token = mgr.createToken("agent-1");
    expect(mgr.revokeToken("agent-1")).toBe(true);
    expect(mgr.verifyToken("agent-1", token)).toBe(false);
    expect(mgr.hasToken("agent-1")).toBe(false);
  });

  it("revoke returns false for unknown agent", () => {
    const mgr = new AgentTokenManager();
    expect(mgr.revokeToken("unknown")).toBe(false);
  });

  it("hasToken returns correct state", () => {
    const mgr = new AgentTokenManager();
    expect(mgr.hasToken("agent-1")).toBe(false);
    mgr.createToken("agent-1");
    expect(mgr.hasToken("agent-1")).toBe(true);
  });

  it("createToken overwrites previous token", () => {
    const mgr = new AgentTokenManager();
    const token1 = mgr.createToken("agent-1");
    const token2 = mgr.createToken("agent-1");
    expect(token1).not.toBe(token2);
    expect(mgr.verifyToken("agent-1", token1)).toBe(false);
    expect(mgr.verifyToken("agent-1", token2)).toBe(true);
  });

  it("manages multiple agents independently", () => {
    const mgr = new AgentTokenManager();
    const t1 = mgr.createToken("agent-1");
    const t2 = mgr.createToken("agent-2");
    expect(mgr.verifyToken("agent-1", t1)).toBe(true);
    expect(mgr.verifyToken("agent-2", t2)).toBe(true);
    // Cross-validation fails
    expect(mgr.verifyToken("agent-1", t2)).toBe(false);
    expect(mgr.verifyToken("agent-2", t1)).toBe(false);
  });
});
