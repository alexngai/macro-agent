/**
 * Tests for createTaskBackend factory function
 *
 * Covers:
 * - Memory backend returns no socketPath
 * - OpenTasks backend with explicit socketPath returns it
 * - OpenTasks backend with autoStart returns daemon's socketPath
 * - Unknown backend type throws
 *
 * @module task/backend/__tests__/create-task-backend.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventStore, type EventStore } from "../../../store/event-store.js";

// Mock opentasks to avoid real daemon operations
vi.mock("opentasks", () => ({
  checkExistingDaemon: vi.fn(),
  createDaemonWithStore: vi.fn(),
  OpenTasksClient: vi.fn(),
}));

// Mock the opentasks client module
vi.mock("../opentasks/client.js", () => ({
  IPCOpenTasksClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    call: vi.fn().mockResolvedValue({}),
    createIssue: vi.fn(),
    getIssue: vi.fn(),
    updateIssue: vi.fn(),
    deleteIssue: vi.fn(),
    listIssues: vi.fn(),
    getReadyIssues: vi.fn(),
    createEdge: vi.fn(),
    removeEdge: vi.fn(),
    getBlockers: vi.fn(),
    getBlocking: vi.fn(),
    task: vi.fn(),
    taskTransition: vi.fn(),
    taskReady: vi.fn(),
    taskAssign: vi.fn(),
    taskValidActions: vi.fn(),
    listProviders: vi.fn(),
  })),
  createOpenTasksClient: vi.fn().mockImplementation(async () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    call: vi.fn().mockResolvedValue({}),
    createIssue: vi.fn(),
    getIssue: vi.fn(),
    updateIssue: vi.fn(),
    deleteIssue: vi.fn(),
    listIssues: vi.fn(),
    getReadyIssues: vi.fn(),
    createEdge: vi.fn(),
    removeEdge: vi.fn(),
    getBlockers: vi.fn(),
    getBlocking: vi.fn(),
    task: vi.fn(),
    taskTransition: vi.fn(),
    taskReady: vi.fn(),
    taskAssign: vi.fn(),
    taskValidActions: vi.fn(),
    listProviders: vi.fn(),
  })),
  OpenTasksClientError: class extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

// Mock the opentasks backend
vi.mock("../opentasks/backend.js", () => ({
  OpenTasksTaskBackend: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    onChange: vi.fn(),
  })),
}));

// Mock daemon-manager
vi.mock("../opentasks/daemon-manager.js", () => ({
  DaemonManager: vi.fn().mockImplementation(() => ({
    ensureDaemon: vi.fn().mockResolvedValue({
      client: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      },
      socketPath: "/tmp/auto-daemon.sock",
      ownsDaemon: true,
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    connectProject: vi.fn().mockResolvedValue(undefined),
    getConnectedProjects: vi.fn().mockReturnValue([]),
  })),
}));

describe("createTaskBackend", () => {
  let eventStore: EventStore;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await eventStore.close();
  });

  it("should return no socketPath for memory backend", async () => {
    const { createTaskBackend } = await import("../index.js");

    const result = await createTaskBackend(
      { backend: { type: "memory" } },
      eventStore
    );

    expect(result.backend).toBeDefined();
    expect(result.socketPath).toBeUndefined();
    expect(result.shutdown).toBeUndefined();
  });

  it("should return explicit socketPath for opentasks with socketPath config", async () => {
    const { createTaskBackend } = await import("../index.js");

    const result = await createTaskBackend(
      { backend: { type: "opentasks", socketPath: "/tmp/explicit.sock" } },
      eventStore
    );

    expect(result.backend).toBeDefined();
    expect(result.socketPath).toBe("/tmp/explicit.sock");
    expect(result.openTasksClient).toBeDefined();
    expect(result.shutdown).toBeDefined();
    // No connectProject when using direct socket (no DaemonManager)
    expect(result.connectProject).toBeUndefined();
  });

  it("should return daemon socketPath for opentasks with autoStart", async () => {
    const { createTaskBackend } = await import("../index.js");

    const result = await createTaskBackend(
      { backend: { type: "opentasks" } }, // autoStart defaults to true
      eventStore
    );

    expect(result.backend).toBeDefined();
    expect(result.socketPath).toBe("/tmp/auto-daemon.sock");
    expect(result.openTasksClient).toBeDefined();
    expect(result.shutdown).toBeDefined();
    expect(result.connectProject).toBeDefined();
    expect(result.getConnectedProjects).toBeDefined();
  });

  it("should return no socketPath for opentasks with autoStart disabled", async () => {
    const { createTaskBackend } = await import("../index.js");

    const result = await createTaskBackend(
      { backend: { type: "opentasks", autoStart: false } },
      eventStore
    );

    expect(result.backend).toBeDefined();
    // autoStart=false, no socketPath in config → socket path unknown
    expect(result.socketPath).toBeUndefined();
    expect(result.openTasksClient).toBeDefined();
    expect(result.shutdown).toBeDefined();
    // No DaemonManager when autoStart is false
    expect(result.connectProject).toBeUndefined();
  });

  it("should throw for unknown backend type", async () => {
    const { createTaskBackend } = await import("../index.js");

    await expect(
      createTaskBackend(
        { backend: { type: "unknown" as any } },
        eventStore
      )
    ).rejects.toThrow("Unknown backend type");
  });

  it("should call backend.close() before daemon shutdown", async () => {
    const { createTaskBackend } = await import("../index.js");

    const result = await createTaskBackend(
      { backend: { type: "opentasks" } }, // autoStart defaults to true
      eventStore
    );

    expect(result.shutdown).toBeDefined();

    // Track call order
    const callOrder: string[] = [];
    const { DaemonManager } = await import("../opentasks/daemon-manager.js");
    const mockInstance = vi.mocked(DaemonManager).mock.results[0]?.value;
    if (mockInstance) {
      mockInstance.shutdown.mockImplementation(async () => {
        callOrder.push("daemon_shutdown");
      });
    }

    // backend.close() is called within the shutdown wrapper
    const backend = result.backend as any;
    const originalClose = backend.close?.bind(backend);
    backend.close = vi.fn(async () => {
      callOrder.push("backend_close");
      if (originalClose) await originalClose();
    });

    await result.shutdown!();

    expect(callOrder).toEqual(["backend_close", "daemon_shutdown"]);
  });
});
