/**
 * Integration tests for Sudocode CLI operations
 *
 * These tests use the real @sudocode-ai/cli package with a temp SQLite database
 * to verify that our integration with sudocode works correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestContext,
  createTestIssue,
  createTestSpec,
  createBlockingRelationship,
  createImplementsRelationship,
  getIssue,
  listIssues,
  updateIssue,
  getSpec,
  listSpecs,
  getOutgoingRelationships,
  getIncomingRelationships,
  getReadyIssues,
  type TestContext,
} from "./test-utils.js";

describe("Sudocode CLI Integration", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe("Issue Operations", () => {
    it("should create and retrieve an issue", () => {
      const issue = createTestIssue(ctx, {
        title: "Test Issue",
        content: "Test content",
      });

      expect(issue.id).toMatch(/^i-/);
      expect(issue.title).toBe("Test Issue");
      expect(issue.content).toBe("Test content");
      expect(issue.status).toBe("open");
      expect(issue.priority).toBe(2);

      const retrieved = getIssue(ctx.db, issue.id);
      expect(retrieved).toEqual(issue);
    });

    it("should list issues with filters", () => {
      const issue1 = createTestIssue(ctx, { title: "Issue 1", status: "open" });
      const issue2 = createTestIssue(ctx, {
        title: "Issue 2",
        status: "in_progress",
      });
      const issue3 = createTestIssue(ctx, {
        title: "Issue 3",
        status: "closed",
      });

      const allIssues = listIssues(ctx.db);
      expect(allIssues).toHaveLength(3);

      const openIssues = listIssues(ctx.db, { status: "open" });
      expect(openIssues).toHaveLength(1);
      expect(openIssues[0].id).toBe(issue1.id);

      const inProgressIssues = listIssues(ctx.db, { status: "in_progress" });
      expect(inProgressIssues).toHaveLength(1);
      expect(inProgressIssues[0].id).toBe(issue2.id);

      const closedIssues = listIssues(ctx.db, { status: "closed" });
      expect(closedIssues).toHaveLength(1);
      expect(closedIssues[0].id).toBe(issue3.id);
    });

    it("should update an issue", () => {
      const issue = createTestIssue(ctx, { title: "Original Title" });

      const updated = updateIssue(ctx.db, issue.id, {
        title: "Updated Title",
        status: "in_progress",
      });

      expect(updated.title).toBe("Updated Title");
      expect(updated.status).toBe("in_progress");

      const retrieved = getIssue(ctx.db, issue.id);
      expect(retrieved?.title).toBe("Updated Title");
      expect(retrieved?.status).toBe("in_progress");
    });

    it("should support issue hierarchy (parent/child)", () => {
      const parent = createTestIssue(ctx, { title: "Parent Issue" });
      const child = createTestIssue(ctx, {
        title: "Child Issue",
        parent_id: parent.id,
      });

      expect(child.parent_id).toBe(parent.id);

      const children = listIssues(ctx.db, { parent_id: parent.id });
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(child.id);
    });
  });

  describe("Spec Operations", () => {
    it("should create and retrieve a spec", () => {
      const spec = createTestSpec(ctx, {
        title: "Test Spec",
        content: "Spec content",
      });

      expect(spec.id).toMatch(/^s-/);
      expect(spec.title).toBe("Test Spec");
      expect(spec.content).toBe("Spec content");
      expect(spec.priority).toBe(2);

      const retrieved = getSpec(ctx.db, spec.id);
      expect(retrieved).toEqual(spec);
    });

    it("should list specs", () => {
      createTestSpec(ctx, { title: "Spec 1" });
      createTestSpec(ctx, { title: "Spec 2" });
      createTestSpec(ctx, { title: "Spec 3" });

      const specs = listSpecs(ctx.db);
      expect(specs).toHaveLength(3);
    });
  });

  describe("Relationship Operations", () => {
    it("should create a blocking relationship between issues", () => {
      const blocker = createTestIssue(ctx, { title: "Blocker Issue" });
      const blocked = createTestIssue(ctx, { title: "Blocked Issue" });

      createBlockingRelationship(ctx.db, blocker.id, blocked.id);

      // Check outgoing relationships from blocker
      const outgoing = getOutgoingRelationships(ctx.db, blocker.id, "issue");
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].to_id).toBe(blocked.id);
      expect(outgoing[0].relationship_type).toBe("blocks");

      // Check incoming relationships to blocked
      const incoming = getIncomingRelationships(ctx.db, blocked.id, "issue");
      expect(incoming).toHaveLength(1);
      expect(incoming[0].from_id).toBe(blocker.id);
      expect(incoming[0].relationship_type).toBe("blocks");
    });

    it("should create an implements relationship between issue and spec", () => {
      const spec = createTestSpec(ctx, { title: "Feature Spec" });
      const issue = createTestIssue(ctx, { title: "Implement Feature" });

      createImplementsRelationship(ctx.db, issue.id, spec.id);

      // Check outgoing from issue
      const outgoing = getOutgoingRelationships(ctx.db, issue.id, "issue");
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].to_id).toBe(spec.id);
      expect(outgoing[0].relationship_type).toBe("implements");

      // Check incoming to spec
      const incoming = getIncomingRelationships(ctx.db, spec.id, "spec");
      expect(incoming).toHaveLength(1);
      expect(incoming[0].from_id).toBe(issue.id);
    });

    it("should auto-update blocked status when adding a blocks relationship", () => {
      const blocker = createTestIssue(ctx, { title: "Blocker", status: "open" });
      const blocked = createTestIssue(ctx, { title: "Blocked", status: "open" });

      // Adding a blocks relationship should set the blocked issue to 'blocked' status
      createBlockingRelationship(ctx.db, blocker.id, blocked.id);

      const updatedBlocked = getIssue(ctx.db, blocked.id);
      expect(updatedBlocked?.status).toBe("blocked");
    });

    it("should auto-unblock when blocker is closed", () => {
      const blocker = createTestIssue(ctx, { title: "Blocker", status: "open" });
      const blocked = createTestIssue(ctx, { title: "Blocked", status: "open" });

      createBlockingRelationship(ctx.db, blocker.id, blocked.id);

      // Verify blocked is now 'blocked'
      let blockedIssue = getIssue(ctx.db, blocked.id);
      expect(blockedIssue?.status).toBe("blocked");

      // Close the blocker
      updateIssue(ctx.db, blocker.id, { status: "closed" });

      // Blocked issue should now be 'open' again
      blockedIssue = getIssue(ctx.db, blocked.id);
      expect(blockedIssue?.status).toBe("open");
    });
  });

  describe("Ready Issues", () => {
    it("should return issues without blockers", () => {
      const ready1 = createTestIssue(ctx, { title: "Ready 1", status: "open" });
      const ready2 = createTestIssue(ctx, { title: "Ready 2", status: "open" });
      const blocker = createTestIssue(ctx, {
        title: "Blocker",
        status: "open",
      });
      const blocked = createTestIssue(ctx, {
        title: "Blocked",
        status: "open",
      });

      createBlockingRelationship(ctx.db, blocker.id, blocked.id);

      const readyIssues = getReadyIssues(ctx.db);

      // ready1, ready2, and blocker should be ready (not blocked)
      // blocked should NOT be in ready list
      const readyIds = readyIssues.map((i) => i.id);
      expect(readyIds).toContain(ready1.id);
      expect(readyIds).toContain(ready2.id);
      expect(readyIds).toContain(blocker.id);
      expect(readyIds).not.toContain(blocked.id);
    });

    it("should include previously blocked issues after blocker is closed", () => {
      const blocker = createTestIssue(ctx, { title: "Blocker", status: "open" });
      const blocked = createTestIssue(ctx, { title: "Blocked", status: "open" });

      createBlockingRelationship(ctx.db, blocker.id, blocked.id);

      // Initially blocked is not ready
      let readyIssues = getReadyIssues(ctx.db);
      let readyIds = readyIssues.map((i) => i.id);
      expect(readyIds).not.toContain(blocked.id);

      // Close the blocker
      updateIssue(ctx.db, blocker.id, { status: "closed" });

      // Now blocked should be ready
      readyIssues = getReadyIssues(ctx.db);
      readyIds = readyIssues.map((i) => i.id);
      expect(readyIds).toContain(blocked.id);
    });
  });

  describe("Complex Scenarios", () => {
    it("should handle a chain of blockers", () => {
      // Create a chain: A blocks B blocks C
      const issueA = createTestIssue(ctx, { title: "Issue A", status: "open" });
      const issueB = createTestIssue(ctx, { title: "Issue B", status: "open" });
      const issueC = createTestIssue(ctx, { title: "Issue C", status: "open" });

      createBlockingRelationship(ctx.db, issueA.id, issueB.id);
      createBlockingRelationship(ctx.db, issueB.id, issueC.id);

      // Only A should be ready
      let readyIssues = getReadyIssues(ctx.db);
      let readyIds = readyIssues.map((i) => i.id);
      expect(readyIds).toContain(issueA.id);
      expect(readyIds).not.toContain(issueB.id);
      expect(readyIds).not.toContain(issueC.id);

      // Close A - B should become ready, C still blocked
      updateIssue(ctx.db, issueA.id, { status: "closed" });
      readyIssues = getReadyIssues(ctx.db);
      readyIds = readyIssues.map((i) => i.id);
      expect(readyIds).toContain(issueB.id);
      expect(readyIds).not.toContain(issueC.id);

      // Close B - C should become ready
      updateIssue(ctx.db, issueB.id, { status: "closed" });
      readyIssues = getReadyIssues(ctx.db);
      readyIds = readyIssues.map((i) => i.id);
      expect(readyIds).toContain(issueC.id);
    });

    it("should handle multiple blockers", () => {
      // C is blocked by both A and B
      const issueA = createTestIssue(ctx, { title: "Issue A", status: "open" });
      const issueB = createTestIssue(ctx, { title: "Issue B", status: "open" });
      const issueC = createTestIssue(ctx, { title: "Issue C", status: "open" });

      createBlockingRelationship(ctx.db, issueA.id, issueC.id);
      createBlockingRelationship(ctx.db, issueB.id, issueC.id);

      // C should be blocked
      let issueC_status = getIssue(ctx.db, issueC.id);
      expect(issueC_status?.status).toBe("blocked");

      // Close A - C should still be blocked by B
      updateIssue(ctx.db, issueA.id, { status: "closed" });
      issueC_status = getIssue(ctx.db, issueC.id);
      expect(issueC_status?.status).toBe("blocked");

      // Close B - C should now be unblocked
      updateIssue(ctx.db, issueB.id, { status: "closed" });
      issueC_status = getIssue(ctx.db, issueC.id);
      expect(issueC_status?.status).toBe("open");
    });

    it("should handle spec with multiple implementing issues", () => {
      const spec = createTestSpec(ctx, { title: "Feature Spec" });
      const issue1 = createTestIssue(ctx, { title: "Part 1" });
      const issue2 = createTestIssue(ctx, { title: "Part 2" });
      const issue3 = createTestIssue(ctx, { title: "Part 3" });

      createImplementsRelationship(ctx.db, issue1.id, spec.id);
      createImplementsRelationship(ctx.db, issue2.id, spec.id);
      createImplementsRelationship(ctx.db, issue3.id, spec.id);

      // All issues should reference the spec
      const incoming = getIncomingRelationships(ctx.db, spec.id, "spec");
      expect(incoming).toHaveLength(3);

      const implementerIds = incoming.map((r) => r.from_id);
      expect(implementerIds).toContain(issue1.id);
      expect(implementerIds).toContain(issue2.id);
      expect(implementerIds).toContain(issue3.id);
    });
  });
});
