/**
 * TempRepoFactory - Creates temporary git repositories for testing
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import Database from "better-sqlite3";

import type {
  TempRepoOptions,
  TempRepo,
  BranchConfig,
  CommitInfo,
} from "./types.js";

/**
 * Create a temporary git repository for testing
 */
export async function createTempRepo(
  options: TempRepoOptions = {}
): Promise<TempRepo> {
  const {
    initialFiles = {},
    initialBranch = "main",
    bare = false,
    remoteOrigin,
    withDataplane = false,
    withSudocode = false,
    sudocodeSpecs = [],
    sudocodeIssues = [],
    branches = [],
  } = options;

  // Create temp directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "macro-test-repo-"));
  const repoPath = bare ? tempDir : path.join(tempDir, "repo");

  if (!bare) {
    fs.mkdirSync(repoPath);
  }

  // Helper to run git commands
  const git = (args: string, cwd: string = repoPath): string => {
    try {
      return execSync(`git ${args}`, {
        cwd,
        stdio: "pipe",
        encoding: "utf8",
      }).trim();
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string };
      throw new Error(
        `Git command failed: git ${args}\n${execError.stderr || execError.message}`
      );
    }
  };

  // Helper to write files
  const writeFile = (filePath: string, content: string): void => {
    const fullPath = path.join(repoPath, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content);
  };

  // Initialize git repo
  if (bare) {
    git(`init --bare -b ${initialBranch}`, repoPath);
  } else {
    git(`init -b ${initialBranch}`);
    git('config user.email "test@macro-agent.test"');
    git('config user.name "Test User"');
  }

  // Add remote origin if specified
  if (remoteOrigin) {
    git(`remote add origin ${remoteOrigin}`);
  }

  // Create initial files (only for non-bare repos)
  if (!bare) {
    // Always create at least one file for initial commit
    const hasFiles = Object.keys(initialFiles).length > 0;
    if (!hasFiles) {
      writeFile("README.md", "# Test Repository\n");
    }

    // Write all initial files
    for (const [filePath, content] of Object.entries(initialFiles)) {
      writeFile(filePath, content);
    }

    // Create initial commit
    git("add .");
    git('commit -m "Initial commit"');
  }

  // Create additional branches
  for (const branchConfig of branches) {
    await createBranch(repoPath, git, writeFile, branchConfig, initialBranch);
  }

  // Switch back to initial branch
  if (branches.length > 0 && !bare) {
    git(`checkout ${initialBranch}`);
  }

  // Setup database if requested
  let db: Database.Database | undefined;
  let dbPath: string | undefined;

  if (withDataplane) {
    dbPath = path.join(repoPath, ".dataplane", "tracker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);

    // Initialize dataplane schema (minimal for testing)
    initializeDataplaneSchema(db);

    if (withSudocode) {
      initializeSudocodeSchema(db);

      // Create specs and issues
      for (const spec of sudocodeSpecs) {
        createSpec(db, spec);
      }
      for (const issue of sudocodeIssues) {
        createIssue(db, issue);
      }
    }
  }

  // Build TempRepo object
  const tempRepo: TempRepo = {
    path: repoPath,
    gitDir: bare ? repoPath : path.join(repoPath, ".git"),
    db,
    dbPath,

    git: (args: string) => git(args),

    writeFile: (filePath: string, content: string) => writeFile(filePath, content),

    readFile: (filePath: string): string => {
      const fullPath = path.join(repoPath, filePath);
      return fs.readFileSync(fullPath, "utf8");
    },

    fileExists: (filePath: string): boolean => {
      const fullPath = path.join(repoPath, filePath);
      return fs.existsSync(fullPath);
    },

    commit: (message: string): string => {
      git("add .");
      git(`commit -m "${message.replace(/"/g, '\\"')}"`);
      return git("rev-parse HEAD");
    },

    checkout: (branch: string, create = false): void => {
      if (create) {
        git(`checkout -b ${branch}`);
      } else {
        git(`checkout ${branch}`);
      }
    },

    getBranches: (): string[] => {
      return git("branch --list")
        .split("\n")
        .map((b) => b.trim().replace(/^\* /, ""))
        .filter(Boolean);
    },

    getCurrentBranch: (): string => {
      return git("rev-parse --abbrev-ref HEAD");
    },

    getCommitLog: (limit = 10): CommitInfo[] => {
      const format = "%H|%h|%s|%an|%aI";
      const output = git(`log -${limit} --pretty=format:"${format}"`);
      if (!output) return [];

      return output.split("\n").map((line) => {
        const [hash, shortHash, message, author, dateStr] = line.split("|");
        return {
          hash,
          shortHash,
          message,
          author,
          date: new Date(dateStr),
        };
      });
    },

    hasUncommittedChanges: (): boolean => {
      const status = git("status --porcelain");
      return status.length > 0;
    },

    cleanup: async (): Promise<void> => {
      // Close database if open
      if (db) {
        db.close();
      }

      // Remove temp directory
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };

  return tempRepo;
}

/**
 * Create an additional branch with optional files
 */
async function createBranch(
  repoPath: string,
  git: (args: string) => string,
  writeFile: (path: string, content: string) => void,
  config: BranchConfig,
  defaultFrom: string
): Promise<void> {
  const { name, from = defaultFrom, files = {}, commit } = config;

  // Checkout the base branch
  git(`checkout ${from}`);

  // Create and switch to new branch
  git(`checkout -b ${name}`);

  // Write files if any
  const hasFiles = Object.keys(files).length > 0;
  if (hasFiles) {
    for (const [filePath, content] of Object.entries(files)) {
      writeFile(filePath, content);
    }

    // Commit the changes
    git("add .");
    git(`commit -m "${commit || `Create branch ${name}`}"`);
  }
}

/**
 * Initialize minimal dataplane schema for testing
 */
function initializeDataplaneSchema(db: Database.Database): void {
  db.exec(`
    -- Streams table
    CREATE TABLE IF NOT EXISTS dataplane_streams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      coordinator_id TEXT,
      base_branch TEXT DEFAULT 'main',
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      status TEXT DEFAULT 'active'
    );

    -- Worktrees table
    CREATE TABLE IF NOT EXISTS dataplane_worktrees (
      agent_id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      branch TEXT,
      stream_id TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      FOREIGN KEY (stream_id) REFERENCES dataplane_streams(id)
    );

    -- Tasks table
    CREATE TABLE IF NOT EXISTS dataplane_tasks (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      title TEXT,
      description TEXT,
      status TEXT DEFAULT 'open',
      assigned_agent TEXT,
      branch_name TEXT,
      priority INTEGER DEFAULT 100,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      started_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (stream_id) REFERENCES dataplane_streams(id)
    );

    -- Merge requests table
    CREATE TABLE IF NOT EXISTS macro_merge_requests (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      task_id TEXT,
      worker_branch TEXT NOT NULL,
      worker_agent_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 100,
      position INTEGER,
      submitted_at INTEGER DEFAULT (unixepoch() * 1000),
      started_at INTEGER,
      completed_at INTEGER,
      merge_commit TEXT,
      conflict_files TEXT,
      resolver_task_id TEXT,
      metadata TEXT
    );
  `);
}

/**
 * Initialize sudocode schema for testing
 */
function initializeSudocodeSchema(db: Database.Database): void {
  db.exec(`
    -- Specs table
    CREATE TABLE IF NOT EXISTS sudocode_specs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER DEFAULT 2,
      tags TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- Issues table
    CREATE TABLE IF NOT EXISTS sudocode_issues (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'open',
      priority INTEGER DEFAULT 2,
      tags TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- Links table
    CREATE TABLE IF NOT EXISTS sudocode_links (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (from_id, to_id, type)
    );
  `);
}

/**
 * Create a spec in the database
 */
function createSpec(
  db: Database.Database,
  spec: { id?: string; title: string; description?: string; priority?: number; tags?: string[] }
): string {
  const id = spec.id || `s-${Date.now().toString(36)}`;
  db.prepare(`
    INSERT INTO sudocode_specs (id, title, description, priority, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    spec.title,
    spec.description || "",
    spec.priority || 2,
    JSON.stringify(spec.tags || [])
  );
  return id;
}

/**
 * Create an issue in the database
 */
function createIssue(
  db: Database.Database,
  issue: {
    id?: string;
    title: string;
    description?: string;
    status?: string;
    priority?: number;
    implements?: string;
    tags?: string[];
  }
): string {
  const id = issue.id || `i-${Date.now().toString(36)}`;
  db.prepare(`
    INSERT INTO sudocode_issues (id, title, description, status, priority, tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    issue.title,
    issue.description || "",
    issue.status || "open",
    issue.priority || 2,
    JSON.stringify(issue.tags || [])
  );

  // Create implements link if specified
  if (issue.implements) {
    db.prepare(`
      INSERT INTO sudocode_links (from_id, to_id, type)
      VALUES (?, ?, 'implements')
    `).run(id, issue.implements);
  }

  return id;
}

export { createSpec, createIssue };
