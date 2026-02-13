/**
 * ACP CLI tests
 *
 * Tests for the ACP CLI entry point, including argument parsing
 * and combined server configuration.
 */

import { describe, it, expect } from "vitest";
import { parseArgs, type ACPServerOptions } from "../parse-args.js";

// ─────────────────────────────────────────────────────────────────
// parseArgs Tests
// ─────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  describe("--cwd option", () => {
    it("should parse --cwd option", () => {
      const result = parseArgs(["--cwd", "/path/to/project"]);
      expect(result.cwd).toBe("/path/to/project");
    });

    it("should not set cwd if no value provided", () => {
      const result = parseArgs(["--cwd"]);
      expect(result.cwd).toBeUndefined();
    });

    it("should handle cwd with spaces in path", () => {
      const result = parseArgs(["--cwd", "/path/with spaces/project"]);
      expect(result.cwd).toBe("/path/with spaces/project");
    });
  });

  describe("--acp option", () => {
    it("should parse --acp flag", () => {
      const result = parseArgs(["--acp"]);
      expect(result.acp).toBe(true);
    });

    it("should not set acp if flag not provided (default is full server mode)", () => {
      const result = parseArgs([]);
      expect(result.acp).toBeUndefined();
    });
  });

  describe("--port option", () => {
    it("should parse --port option", () => {
      const result = parseArgs(["--port", "8080"]);
      expect(result.port).toBe(8080);
    });

    it("should not set port if no value provided", () => {
      const result = parseArgs(["--port"]);
      expect(result.port).toBeUndefined();
    });

    it("should handle port as integer", () => {
      const result = parseArgs(["--port", "3000"]);
      expect(result.port).toBe(3000);
      expect(typeof result.port).toBe("number");
    });
  });

  describe("--host option", () => {
    it("should parse --host option", () => {
      const result = parseArgs(["--host", "0.0.0.0"]);
      expect(result.host).toBe("0.0.0.0");
    });

    it("should not set host if no value provided", () => {
      const result = parseArgs(["--host"]);
      expect(result.host).toBeUndefined();
    });

    it("should handle localhost", () => {
      const result = parseArgs(["--host", "localhost"]);
      expect(result.host).toBe("localhost");
    });
  });

  describe("combined options", () => {
    it("should parse all options together", () => {
      const result = parseArgs([
        "--cwd", "/project",
        "--acp",
        "--port", "9000",
        "--host", "127.0.0.1",
      ]);

      expect(result).toEqual({
        cwd: "/project",
        acp: true,
        port: 9000,
        host: "127.0.0.1",
      });
    });

    it("should parse options in any order", () => {
      const result = parseArgs([
        "--acp",
        "--host", "0.0.0.0",
        "--cwd", "/my/project",
        "--port", "4000",
      ]);

      expect(result).toEqual({
        cwd: "/my/project",
        acp: true,
        port: 4000,
        host: "0.0.0.0",
      });
    });

    it("should parse server options without --acp (full server mode)", () => {
      const result = parseArgs(["--port", "5000", "--host", "0.0.0.0"]);

      expect(result).toEqual({
        port: 5000,
        host: "0.0.0.0",
      });
    });

    it("should parse --acp with --cwd (stdio ACP mode)", () => {
      const result = parseArgs(["--acp", "--cwd", "/project"]);

      expect(result).toEqual({
        acp: true,
        cwd: "/project",
      });
    });
  });

  describe("edge cases", () => {
    it("should return empty object for no arguments (defaults to full server mode)", () => {
      const result = parseArgs([]);
      expect(result).toEqual({});
    });

    it("should ignore unknown options", () => {
      const result = parseArgs(["--unknown", "value", "--acp"]);
      expect(result.acp).toBe(true);
      expect(result).not.toHaveProperty("unknown");
    });

    it("should use process.argv when no args provided", () => {
      // Save original argv
      const originalArgv = process.argv;

      try {
        process.argv = ["node", "acp.js", "--acp", "--port", "7777"];
        const result = parseArgs();
        expect(result.acp).toBe(true);
        expect(result.port).toBe(7777);
      } finally {
        // Restore original argv
        process.argv = originalArgv;
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// Server Mode Tests
// ─────────────────────────────────────────────────────────────────

describe("Server Mode Configuration", () => {
  describe("default behavior (full server mode)", () => {
    it("should run full server mode when no --acp flag is set", () => {
      const options = parseArgs([]);
      expect(options.acp).toBeUndefined();
      // When acp is undefined, main() runs full server mode
    });

    it("should use specified port in full server mode", () => {
      const options = parseArgs(["--port", "8080"]);
      expect(options.acp).toBeUndefined();
      expect(options.port).toBe(8080);
    });

    it("should use specified host in full server mode", () => {
      const options = parseArgs(["--host", "0.0.0.0"]);
      expect(options.acp).toBeUndefined();
      expect(options.host).toBe("0.0.0.0");
    });
  });

  describe("stdio ACP mode (--acp flag)", () => {
    it("should enable stdio ACP mode when --acp flag is set", () => {
      const options = parseArgs(["--acp"]);
      expect(options.acp).toBe(true);
    });

    it("should allow --cwd with --acp for embedded use", () => {
      const options = parseArgs(["--acp", "--cwd", "/path/to/project"]);
      expect(options.acp).toBe(true);
      expect(options.cwd).toBe("/path/to/project");
    });
  });

  describe("default values behavior", () => {
    it("should use default port 3001 when not specified", () => {
      const options = parseArgs([]);
      // Default is applied in main(), not parseArgs()
      expect(options.port).toBeUndefined();
      // The actual default (3001) is applied when creating the server
    });

    it("should use default host localhost when not specified", () => {
      const options = parseArgs([]);
      // Default is applied in main(), not parseArgs()
      expect(options.host).toBeUndefined();
      // The actual default (localhost) is applied when creating the server
    });
  });
});
