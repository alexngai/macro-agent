/**
 * MergeQueue Schema
 *
 * Database schema for the merge queue table.
 *
 * @module workspace/merge-queue/schema
 * @implements [[s-bcqm]] Merge Queue Schema section
 */

import type Database from 'better-sqlite3';

/**
 * Table name for merge requests.
 * Uses prefix to support table namespacing.
 */
export function getMergeRequestsTableName(prefix: string = ''): string {
  return `${prefix}merge_requests`;
}

/**
 * SQL for creating the merge_requests table.
 */
export function getCreateTableSQL(tableName: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      worker_branch TEXT NOT NULL,
      worker_agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 100,
      position INTEGER,
      submitted_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      merge_commit TEXT,
      conflict_files TEXT,
      resolver_task_id TEXT,
      metadata TEXT
    )
  `;
}

/**
 * SQL for creating indexes on the merge_requests table.
 */
export function getCreateIndexesSQL(tableName: string): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_stream_status
     ON ${tableName}(stream_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_priority
     ON ${tableName}(stream_id, priority, submitted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_task
     ON ${tableName}(task_id)`,
  ];
}

/**
 * Initialize the merge_requests table and indexes.
 *
 * @param db - Database connection
 * @param tablePrefix - Table name prefix (default: '')
 */
export function initMergeQueueSchema(
  db: Database.Database,
  tablePrefix: string = ''
): void {
  const tableName = getMergeRequestsTableName(tablePrefix);

  // Create table
  db.exec(getCreateTableSQL(tableName));

  // Create indexes
  for (const indexSQL of getCreateIndexesSQL(tableName)) {
    db.exec(indexSQL);
  }
}

/**
 * Check if the merge_requests table exists.
 *
 * @param db - Database connection
 * @param tablePrefix - Table name prefix (default: '')
 * @returns True if table exists
 */
export function mergeQueueTableExists(
  db: Database.Database,
  tablePrefix: string = ''
): boolean {
  const tableName = getMergeRequestsTableName(tablePrefix);
  const result = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    )
    .get(tableName);
  return !!result;
}
