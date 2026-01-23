/**
 * Integration Test Utilities for Sudocode
 *
 * Provides helpers for creating real sudocode databases and test fixtures.
 */

import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initDatabase,
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  createSpec,
  getSpec,
  listSpecs,
  addRelationship,
  getOutgoingRelationships,
  getIncomingRelationships,
  generateIssueId,
  generateSpecId,
  getReadyIssues,
} from "@sudocode-ai/cli";
import type { Issue, Spec, IssueStatus } from "@sudocode-ai/types";
import type { Database } from "better-sqlite3";

// =============================================================================
// Test Database Setup
// =============================================================================

export interface TestContext {
  /** Temporary directory for test files */
  tmpDir: string;
  /** SQLite database instance */
  db: Database;
  /** Cleanup function to call after tests */
  cleanup: () => void;
}

/**
 * Create a test context with a real sudocode database
 *
 * Creates the database in {tmpDir}/.sudocode/cache.db to match
 * the structure expected by StandaloneClient.
 */
export function createTestContext(): TestContext {
  const tmpDir = mkdtempSync(join(tmpdir(), "sudocode-test-"));
  const sudocodeDir = join(tmpDir, ".sudocode");
  mkdirSync(sudocodeDir, { recursive: true });
  const dbPath = join(sudocodeDir, "cache.db");
  const db = initDatabase({ path: dbPath });

  return {
    tmpDir,
    db,
    cleanup: () => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// =============================================================================
// Test Fixture Helpers
// =============================================================================

export interface CreateTestIssueOptions {
  title: string;
  content?: string;
  status?: IssueStatus;
  priority?: number;
  parent_id?: string;
}

/**
 * Create a test issue with sensible defaults
 */
export function createTestIssue(
  ctx: TestContext,
  options: CreateTestIssueOptions
): Issue {
  const { id, uuid } = generateIssueId(ctx.db, ctx.tmpDir);
  return createIssue(ctx.db, {
    id,
    uuid,
    title: options.title,
    content: options.content ?? `Content for ${options.title}`,
    status: options.status ?? "open",
    priority: options.priority ?? 2,
    parent_id: options.parent_id,
  });
}

export interface CreateTestSpecOptions {
  title: string;
  content?: string;
  priority?: number;
}

/**
 * Create a test spec with sensible defaults
 */
export function createTestSpec(
  ctx: TestContext,
  options: CreateTestSpecOptions
): Spec {
  const { id, uuid } = generateSpecId(ctx.db, ctx.tmpDir);
  return createSpec(ctx.db, {
    id,
    uuid,
    title: options.title,
    file_path: `${ctx.tmpDir}/${id}.md`,
    content: options.content ?? `Specification for ${options.title}`,
    priority: options.priority ?? 2,
  });
}

/**
 * Create a blocking relationship between two issues
 */
export function createBlockingRelationship(
  db: Database,
  blockerId: string,
  blockedId: string
): void {
  addRelationship(db, {
    from_id: blockerId,
    from_type: "issue",
    to_id: blockedId,
    to_type: "issue",
    relationship_type: "blocks",
  });
}

/**
 * Create an implements relationship between an issue and a spec
 */
export function createImplementsRelationship(
  db: Database,
  issueId: string,
  specId: string
): void {
  addRelationship(db, {
    from_id: issueId,
    from_type: "issue",
    to_id: specId,
    to_type: "spec",
    relationship_type: "implements",
  });
}

// =============================================================================
// Re-export commonly used functions
// =============================================================================

export {
  initDatabase,
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  createSpec,
  getSpec,
  listSpecs,
  addRelationship,
  getOutgoingRelationships,
  getIncomingRelationships,
  generateIssueId,
  generateSpecId,
  getReadyIssues,
};

export type { Issue, Spec, IssueStatus, Database };
