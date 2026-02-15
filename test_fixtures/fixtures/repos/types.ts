/**
 * Types for TempRepoFactory
 */

import type Database from "better-sqlite3";

/**
 * Options for creating a temporary git repository
 */
export interface TempRepoOptions {
  /** Initial file structure (path -> content) */
  initialFiles?: Record<string, string>;

  /** Initial branch name (default: 'main') */
  initialBranch?: string;

  /** Create a bare repository */
  bare?: boolean;

  /** Add a remote origin URL */
  remoteOrigin?: string;

  /** Initialize dataplane schema (creates SQLite database) */
  withDataplane?: boolean;

  /** Additional branches to create */
  branches?: BranchConfig[];
}

/**
 * Configuration for creating additional branches
 */
export interface BranchConfig {
  /** Branch name */
  name: string;

  /** Branch to create from (default: initial branch) */
  from?: string;

  /** Files to add/modify on this branch */
  files?: Record<string, string>;

  /** Commit message (default: "Create branch {name}") */
  commit?: string;
}

/**
 * Partial spec for test fixtures
 */
export interface PartialSpec {
  id?: string;
  title: string;
  description?: string;
  priority?: number;
  tags?: string[];
  /** Parent spec ID for hierarchical organization */
  parent?: string;
}

/**
 * Partial issue for test fixtures
 */
export interface PartialIssue {
  id?: string;
  title: string;
  description?: string;
  status?: "open" | "in_progress" | "blocked" | "closed";
  priority?: number;
  implements?: string; // spec id
  tags?: string[];
  /** Parent issue ID */
  parent?: string;
  /** Issue IDs that block this issue */
  blockedBy?: string[];
}

/**
 * Commit information
 */
export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: Date;
}

/**
 * Temporary repository instance
 */
export interface TempRepo {
  /** Path to the repository root */
  readonly path: string;

  /** Path to the .git directory */
  readonly gitDir: string;

  /** SQLite database (if withDataplane was true) */
  readonly db?: Database.Database;

  /** Path to the database file */
  readonly dbPath?: string;

  // ── Git Helpers ──────────────────────────────────────────────────────────

  /**
   * Execute a git command in the repository
   * @param args Git command arguments (without 'git' prefix)
   * @returns Command output
   */
  git(args: string): string;

  /**
   * Write a file to the repository
   * @param filePath Relative path from repo root
   * @param content File content
   */
  writeFile(filePath: string, content: string): void;

  /**
   * Read a file from the repository
   * @param filePath Relative path from repo root
   * @returns File content
   */
  readFile(filePath: string): string;

  /**
   * Check if a file exists
   * @param filePath Relative path from repo root
   */
  fileExists(filePath: string): boolean;

  /**
   * Stage all changes and commit
   * @param message Commit message
   * @returns Commit hash
   */
  commit(message: string): string;

  /**
   * Checkout a branch
   * @param branch Branch name
   * @param create Create the branch if it doesn't exist
   */
  checkout(branch: string, create?: boolean): void;

  /**
   * Get list of all branches
   */
  getBranches(): string[];

  /**
   * Get current branch name
   */
  getCurrentBranch(): string;

  /**
   * Get commit log
   * @param limit Maximum number of commits to return
   */
  getCommitLog(limit?: number): CommitInfo[];

  /**
   * Check if repository has uncommitted changes
   */
  hasUncommittedChanges(): boolean;

  // ── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * Clean up the temporary repository and all resources
   */
  cleanup(): Promise<void>;
}
