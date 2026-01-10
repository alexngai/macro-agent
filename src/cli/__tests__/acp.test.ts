/**
 * ACP CLI tests
 *
 * Tests for the ACP CLI entry point, including argument parsing,
 * port auto-discovery, and API server integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type AddressInfo } from "node:net";
import { parseArgs, findAvailablePort, type ACPServerOptions } from "../acp.js";

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
// findAvailablePort Tests
// ─────────────────────────────────────────────────────────────────

describe("findAvailablePort", () => {
  it("should return a valid port number", async () => {
    const port = await findAvailablePort();

    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("should return different ports on consecutive calls", async () => {
    // Get first port
    const port1 = await findAvailablePort();

    // Occupy that port
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(port1, "localhost", () => resolve());
    });

    try {
      // Get another port - should be different since port1 is occupied
      const port2 = await findAvailablePort();
      expect(port2).not.toBe(port1);
    } finally {
      // Clean up
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should respect the host parameter", async () => {
    const port = await findAvailablePort("127.0.0.1");

    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
  });

  it("should return a port that can actually be used", async () => {
    const port = await findAvailablePort();

    // Try to actually use the port
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, "localhost", () => resolve());
    });

    // Verify server is listening on the expected port
    const address = server.address() as AddressInfo;
    expect(address.port).toBe(port);

    // Clean up
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should work with 0.0.0.0 host", async () => {
    const port = await findAvailablePort("0.0.0.0");

    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Integration Tests (API Server with ACP)
// ─────────────────────────────────────────────────────────────────

describe("ACP with API Server Integration", () => {
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

    it("should allow --port without --api (port is ignored without --api)", () => {
      const options = parseArgs(["--port", "9000"]);
      expect(options.port).toBe(9000);
      expect(options.api).toBeUndefined();
    });
  });

  describe("port auto-discovery integration", () => {
    it("should be able to find port when no port specified", async () => {
      const options = parseArgs(["--api"]);

      // Simulate what main() does when no port is specified
      const host = options.host ?? "localhost";
      const port = options.port ?? (await findAvailablePort(host));

      expect(typeof port).toBe("number");
      expect(port).toBeGreaterThan(0);
    });

    it("should use specified port when provided", async () => {
      const options = parseArgs(["--api", "--port", "8888"]);

      const host = options.host ?? "localhost";
      const port = options.port ?? (await findAvailablePort(host));

      expect(port).toBe(8888);
    });
  });
});
