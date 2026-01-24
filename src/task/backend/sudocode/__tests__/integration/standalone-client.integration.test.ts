/**
 * Integration tests for StandaloneClient
 *
 * These tests use the real @sudocode-ai/cli package with a temp SQLite database
 * to verify that the StandaloneClient implementation works correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  StandaloneClient,
  createStandaloneClient,
} from "../../standalone-client.js";
import {
  createTestContext,
  createTestIssue,
  createTestSpec,
  createBlockingRelationship,
  createImplementsRelationship,
  type TestContext,
} from "./test-utils.js";

describe("StandaloneClient Integration", () => {
  let tmpDir: string;
  let client: StandaloneClient;

  beforeEach(async () => {
    // Create a fresh temp directory for each test
    tmpDir = mkdtempSync(join(tmpdir(), "sudocode-client-test-"));
  });

  afterEach(() => {
    // Clean up temp directory (client cleanup is handled per-describe block)
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("Initialization", () => {
    it("should initialize with a new project directory", async () => {
      client = await createStandaloneClient({ projectPath: tmpDir });
      expect(client.isReady()).toBe(true);
    });

    it("should create .sudocode directory if it doesn't exist", async () => {
      const { existsSync } = await import("fs");
      expect(existsSync(join(tmpDir, ".sudocode"))).toBe(false);

      client = await createStandaloneClient({ projectPath: tmpDir });

      expect(existsSync(join(tmpDir, ".sudocode"))).toBe(true);
      expect(existsSync(join(tmpDir, ".sudocode", "cache.db"))).toBe(true);
    });

    it("should close cleanly", async () => {
      client = await createStandaloneClient({ projectPath: tmpDir });
      expect(client.isReady()).toBe(true);

      client.close();

      expect(client.isReady()).toBe(false);
    });
  });

  describe("Issue Operations", () => {
    let ctx: TestContext;

    beforeEach(async () => {
      // Create a test context and use its directory for the client
      ctx = createTestContext();
      tmpDir = ctx.tmpDir;
      client = await createStandaloneClient({ projectPath: tmpDir });
    });

    afterEach(() => {
      if (client) client.close();
    });

    it("should retrieve an issue created via CLI", async () => {
      // Create issue directly via CLI
      const createdIssue = createTestIssue(ctx, {
        title: "Test Issue",
        content: "Test content",
      });

      // Retrieve via client
      const issue = await client.getIssue(createdIssue.id);

      expect(issue).not.toBeNull();
      expect(issue!.id).toBe(createdIssue.id);
      expect(issue!.title).toBe("Test Issue");
      expect(issue!.content).toBe("Test content");
    });

    it("should return null for non-existent issue", async () => {
      const issue = await client.getIssue("i-nonexistent");
      expect(issue).toBeNull();
    });

    it("should list issues", async () => {
      createTestIssue(ctx, { title: "Issue 1", status: "open" });
      createTestIssue(ctx, { title: "Issue 2", status: "in_progress" });
      createTestIssue(ctx, { title: "Issue 3", status: "closed" });

      const issues = await client.listIssues();
      expect(issues).toHaveLength(3);
    });

    it("should filter issues by status", async () => {
      createTestIssue(ctx, { title: "Open Issue", status: "open" });
      createTestIssue(ctx, { title: "Closed Issue", status: "closed" });

      const openIssues = await client.listIssues({ status: "open" });
      expect(openIssues).toHaveLength(1);
      expect(openIssues[0].title).toBe("Open Issue");
    });

    it("should search issues by text", async () => {
      createTestIssue(ctx, { title: "Fix the bug", content: "A bug fix" });
      createTestIssue(ctx, { title: "Add feature", content: "New feature" });

      const bugIssues = await client.listIssues({ search: "bug" });
      expect(bugIssues).toHaveLength(1);
      expect(bugIssues[0].title).toBe("Fix the bug");
    });

    it("should get ready issues (no blockers)", async () => {
      const ready1 = createTestIssue(ctx, { title: "Ready 1", status: "open" });
      const blocker = createTestIssue(ctx, {
        title: "Blocker",
        status: "open",
      });
      const blocked = createTestIssue(ctx, {
        title: "Blocked",
        status: "open",
      });

      createBlockingRelationship(ctx.db, blocker.id, blocked.id);

      const readyIssues = await client.getReadyIssues();
      const readyIds = readyIssues.map((i) => i.id);

      expect(readyIds).toContain(ready1.id);
      expect(readyIds).toContain(blocker.id);
      expect(readyIds).not.toContain(blocked.id);
    });

    it("should update an issue", async () => {
      const issue = createTestIssue(ctx, {
        title: "Original",
        status: "open",
      });

      const updated = await client.updateIssue(issue.id, {
        title: "Updated",
        status: "in_progress",
      });

      expect(updated.title).toBe("Updated");
      expect(updated.status).toBe("in_progress");

      // Verify persistence
      const retrieved = await client.getIssue(issue.id);
      expect(retrieved!.title).toBe("Updated");
      expect(retrieved!.status).toBe("in_progress");
    });
  });

  describe("Relationship Operations", () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = createTestContext();
      tmpDir = ctx.tmpDir;
      client = await createStandaloneClient({ projectPath: tmpDir });
    });

    afterEach(() => {
      if (client) client.close();
    });

    it("should create a blocks relationship", async () => {
      const blocker = createTestIssue(ctx, { title: "Blocker" });
      const blocked = createTestIssue(ctx, { title: "Blocked" });

      await client.createLink(blocker.id, blocked.id, "blocks");

      // Verify the relationship was created
      const blockers = await client.getBlockers(blocked.id);
      expect(blockers).toHaveLength(1);
      expect(blockers[0].id).toBe(blocker.id);
    });

    it("should get blockers for an issue", async () => {
      const blocker1 = createTestIssue(ctx, { title: "Blocker 1" });
      const blocker2 = createTestIssue(ctx, { title: "Blocker 2" });
      const blocked = createTestIssue(ctx, { title: "Blocked" });

      createBlockingRelationship(ctx.db, blocker1.id, blocked.id);
      createBlockingRelationship(ctx.db, blocker2.id, blocked.id);

      const blockers = await client.getBlockers(blocked.id);
      expect(blockers).toHaveLength(2);

      const blockerIds = blockers.map((b) => b.id);
      expect(blockerIds).toContain(blocker1.id);
      expect(blockerIds).toContain(blocker2.id);
    });

    it("should get issues that a given issue blocks", async () => {
      const blocker = createTestIssue(ctx, { title: "Blocker" });
      const blocked1 = createTestIssue(ctx, { title: "Blocked 1" });
      const blocked2 = createTestIssue(ctx, { title: "Blocked 2" });

      createBlockingRelationship(ctx.db, blocker.id, blocked1.id);
      createBlockingRelationship(ctx.db, blocker.id, blocked2.id);

      const blocking = await client.getBlocking(blocker.id);
      expect(blocking).toHaveLength(2);

      const blockedIds = blocking.map((b) => b.id);
      expect(blockedIds).toContain(blocked1.id);
      expect(blockedIds).toContain(blocked2.id);
    });

    it("should remove a blocks relationship", async () => {
      const blocker = createTestIssue(ctx, { title: "Blocker" });
      const blocked = createTestIssue(ctx, { title: "Blocked" });

      createBlockingRelationship(ctx.db, blocker.id, blocked.id);

      // Verify relationship exists
      let blockers = await client.getBlockers(blocked.id);
      expect(blockers).toHaveLength(1);

      // Remove via client
      await client.removeLink(blocker.id, blocked.id, "blocks");

      // Verify relationship is gone
      blockers = await client.getBlockers(blocked.id);
      expect(blockers).toHaveLength(0);
    });
  });

  describe("Spec Operations", () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = createTestContext();
      tmpDir = ctx.tmpDir;
      client = await createStandaloneClient({ projectPath: tmpDir });
    });

    afterEach(() => {
      if (client) client.close();
    });

    it("should retrieve a spec created via CLI", async () => {
      const createdSpec = createTestSpec(ctx, {
        title: "Test Spec",
        content: "Spec content",
      });

      const spec = await client.getSpec(createdSpec.id);

      expect(spec).not.toBeNull();
      expect(spec!.id).toBe(createdSpec.id);
      expect(spec!.title).toBe("Test Spec");
      expect(spec!.content).toBe("Spec content");
    });

    it("should return null for non-existent spec", async () => {
      const spec = await client.getSpec("s-nonexistent");
      expect(spec).toBeNull();
    });

    it("should list specs", async () => {
      createTestSpec(ctx, { title: "Spec 1" });
      createTestSpec(ctx, { title: "Spec 2" });
      createTestSpec(ctx, { title: "Spec 3" });

      const specs = await client.listSpecs();
      expect(specs).toHaveLength(3);
    });

    it("should search specs by text", async () => {
      createTestSpec(ctx, { title: "Auth Spec", content: "Authentication" });
      createTestSpec(ctx, { title: "Database Spec", content: "Database design" });

      const authSpecs = await client.listSpecs({ search: "Auth" });
      expect(authSpecs).toHaveLength(1);
      expect(authSpecs[0].title).toBe("Auth Spec");
    });
  });

  describe("Issue-Spec Relationships", () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = createTestContext();
      tmpDir = ctx.tmpDir;
      client = await createStandaloneClient({ projectPath: tmpDir });
    });

    afterEach(() => {
      if (client) client.close();
    });

    it("should create an implements relationship via client", async () => {
      const spec = createTestSpec(ctx, { title: "Feature Spec" });
      const issue = createTestIssue(ctx, { title: "Implement Feature" });

      await client.createLink(issue.id, spec.id, "implements");

      // Note: We can't easily verify this without exposing relationship queries
      // but the operation should complete without error
    });
  });

  describe("Event Subscriptions", () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = createTestContext();
      tmpDir = ctx.tmpDir;
      client = await createStandaloneClient({
        projectPath: tmpDir,
        pollInterval: 100, // Fast polling for tests
      });
    });

    afterEach(() => {
      if (client) client.close();
    });

    it("should emit events when updating an issue", async () => {
      const issue = createTestIssue(ctx, { title: "Test", status: "open" });

      const events: Array<{ type: string; issueId: string }> = [];
      const unsubscribe = client.onIssueChange((event) => {
        events.push({ type: event.type, issueId: event.issueId });
      });

      // Update via client
      await client.updateIssue(issue.id, { status: "in_progress" });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("status_changed");
      expect(events[0].issueId).toBe(issue.id);

      unsubscribe();
    });

    it("should filter events by issue ID", async () => {
      const issue1 = createTestIssue(ctx, { title: "Issue 1" });
      const issue2 = createTestIssue(ctx, { title: "Issue 2" });

      const events: string[] = [];
      const unsubscribe = client.onIssueChange(issue1.id, (event) => {
        events.push(event.issueId);
      });

      // Update both issues
      await client.updateIssue(issue1.id, { title: "Updated 1" });
      await client.updateIssue(issue2.id, { title: "Updated 2" });

      // Should only see events for issue1
      expect(events).toHaveLength(1);
      expect(events[0]).toBe(issue1.id);

      unsubscribe();
    });

    it("should unsubscribe correctly", async () => {
      const issue = createTestIssue(ctx, { title: "Test" });

      const events: string[] = [];
      const unsubscribe = client.onIssueChange((event) => {
        events.push(event.issueId);
      });

      // First update should be captured
      await client.updateIssue(issue.id, { title: "Update 1" });
      expect(events).toHaveLength(1);

      // Unsubscribe
      unsubscribe();

      // Second update should not be captured
      await client.updateIssue(issue.id, { title: "Update 2" });
      expect(events).toHaveLength(1);
    });
  });
});
