/**
 * ACP CLI tests
 *
 * Tests for the ACP CLI entry point, including argument parsing
 * and combined server configuration.
 */

import { describe, it, expect } from "vitest";
import { parseArgs, type ACPServerOptions } from "../acp.js";

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

  describe("--api option", () => {
    it("should parse --api flag", () => {
      const result = parseArgs(["--api"]);
      expect(result.api).toBe(true);
    });

    it("should not set api if flag not provided", () => {
      const result = parseArgs([]);
      expect(result.api).toBeUndefined();
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
        "--api",
        "--port", "9000",
        "--host", "127.0.0.1",
      ]);

      expect(result).toEqual({
        cwd: "/project",
        api: true,
        port: 9000,
        host: "127.0.0.1",
      });
    });

    it("should parse options in any order", () => {
      const result = parseArgs([
        "--api",
        "--host", "0.0.0.0",
        "--cwd", "/my/project",
        "--port", "4000",
      ]);

      expect(result).toEqual({
        cwd: "/my/project",
        api: true,
        port: 4000,
        host: "0.0.0.0",
      });
    });

    it("should parse --api with --port only", () => {
      const result = parseArgs(["--api", "--port", "5000"]);

      expect(result).toEqual({
        api: true,
        port: 5000,
      });
    });

    it("should parse --api with --host only", () => {
      const result = parseArgs(["--api", "--host", "0.0.0.0"]);

      expect(result).toEqual({
        api: true,
        host: "0.0.0.0",
      });
    });
  });

  describe("edge cases", () => {
    it("should return empty object for no arguments", () => {
      const result = parseArgs([]);
      expect(result).toEqual({});
    });

    it("should ignore unknown options", () => {
      const result = parseArgs(["--unknown", "value", "--api"]);
      expect(result.api).toBe(true);
      expect(result).not.toHaveProperty("unknown");
    });

    it("should use process.argv when no args provided", () => {
      // Save original argv
      const originalArgv = process.argv;

      try {
        process.argv = ["node", "acp.js", "--api", "--port", "7777"];
        const result = parseArgs();
        expect(result.api).toBe(true);
        expect(result.port).toBe(7777);
      } finally {
        // Restore original argv
        process.argv = originalArgv;
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// API Server Integration Tests
// ─────────────────────────────────────────────────────────────────

describe("API Server Configuration", () => {
  describe("option combinations", () => {
    it("should enable API server when --api flag is set", () => {
      const options = parseArgs(["--api"]);
      expect(options.api).toBe(true);
    });

    it("should use specified port when --port is provided with --api", () => {
      const options = parseArgs(["--api", "--port", "8080"]);
      expect(options.api).toBe(true);
      expect(options.port).toBe(8080);
    });

    it("should use specified host when --host is provided with --api", () => {
      const options = parseArgs(["--api", "--host", "0.0.0.0"]);
      expect(options.api).toBe(true);
      expect(options.host).toBe("0.0.0.0");
    });

    it("should allow --port without --api (port is stored but server not started)", () => {
      const options = parseArgs(["--port", "9000"]);
      expect(options.port).toBe(9000);
      expect(options.api).toBeUndefined();
    });
  });

  describe("default values behavior", () => {
    it("should use default port 3001 when not specified", () => {
      const options = parseArgs(["--api"]);
      // Default is applied in main(), not parseArgs()
      expect(options.port).toBeUndefined();
      // The actual default (3001) is applied when creating the server
    });

    it("should use default host localhost when not specified", () => {
      const options = parseArgs(["--api"]);
      // Default is applied in main(), not parseArgs()
      expect(options.host).toBeUndefined();
      // The actual default (localhost) is applied when creating the server
    });
  });
});
