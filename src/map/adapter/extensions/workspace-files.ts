/**
 * Workspace File Search Extension Methods (_macro/workspace/files/*)
 *
 * Exposes file search and read capabilities for agent workspaces to
 * external MAP clients (e.g., TUI file attachment system).
 *
 * Methods:
 * - _macro/workspace/files/search - Search files by query
 * - _macro/workspace/files/list - List files in a directory
 * - _macro/workspace/files/read - Read file contents
 *
 * Security: All file operations are scoped to the agent's workspace path.
 * Path traversal is rejected.
 *
 * @see specs/s-5vx8 File Attachment System
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { AgentId } from "../../../store/types/index.js";
import type { InternalWorkspace } from "./workspace.js";
import { RPCError } from "../rpc-handler.js";
import * as fs from "fs";
import * as path from "path";

// =============================================================================
// Request/Response Types
// =============================================================================

interface FileSearchParams {
  /** Agent whose workspace to search */
  agentId: string;
  /** Search query (matched against filenames) */
  query: string;
  /** Subdirectory to search within (relative to workspace root) */
  cwd?: string;
  /** Max results to return (default 50) */
  limit?: number;
}

interface FileListParams {
  /** Agent whose workspace to list */
  agentId: string;
  /** Directory to list (relative to workspace root, default ".") */
  directory?: string;
}

interface FileReadParams {
  /** Agent whose workspace to read from */
  agentId: string;
  /** File path relative to workspace root */
  path: string;
  /** Optional line range */
  lineRange?: { start: number; end: number };
}

/**
 * File search result
 */
interface FileSearchResult {
  /** Relative path from workspace root */
  path: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** File size in bytes (undefined for directories) */
  size?: number;
  /** MIME type guess based on extension */
  mime?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Directories to always exclude from search */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
  "vendor",
  ".cache",
  ".turbo",
]);

/** Binary file extensions to exclude from search */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
  ".sqlite", ".db",
]);

/** Common MIME type mappings */
const MIME_MAP: Record<string, string> = {
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".css": "text/css",
  ".html": "text/html",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".rb": "text/x-ruby",
  ".sh": "text/x-shellscript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".xml": "text/xml",
  ".sql": "text/x-sql",
  ".txt": "text/plain",
  ".env": "text/plain",
  ".gitignore": "text/plain",
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_FILE_READ_SIZE = 10 * 1024 * 1024; // 10MB

// =============================================================================
// Extension Services
// =============================================================================

/**
 * Services required for workspace file search extension
 */
export interface WorkspaceFileServices {
  /** Get workspace for an agent */
  getWorkspace: (agentId: AgentId) => InternalWorkspace | null;
  /** Check if agent exists */
  agentExists: (agentId: AgentId) => boolean;
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Resolve and validate a path within a workspace root.
 * Rejects path traversal attempts.
 */
function resolveWorkspacePath(workspacePath: string, relativePath: string): string {
  const resolved = path.resolve(workspacePath, relativePath);
  if (!resolved.startsWith(workspacePath)) {
    throw RPCError.invalidParams("Path traversal not allowed");
  }
  return resolved;
}

/**
 * Guess MIME type from file extension
 */
function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "text/plain";
}

/**
 * Check if a directory name should be excluded from search
 */
function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || name.startsWith(".");
}

/**
 * Check if a file has a binary extension
 */
function isBinaryFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Recursively search for files matching a query.
 */
async function searchFiles(
  rootDir: string,
  searchDir: string,
  query: string,
  limit: number,
): Promise<FileSearchResult[]> {
  const results: FileSearchResult[] = [];
  const queryLower = query.toLowerCase();
  const hasPathSeparator = query.includes("/");

  async function walk(dir: string, depth: number): Promise<void> {
    if (results.length >= limit || depth > 20) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of entries) {
      if (results.length >= limit) break;

      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) continue;

        const relativePath = path.relative(rootDir, path.join(dir, entry.name));

        // For path queries, check if directory path matches
        if (hasPathSeparator && relativePath.toLowerCase().includes(queryLower)) {
          results.push({ path: relativePath + "/", isDirectory: true });
        }

        await walk(path.join(dir, entry.name), depth + 1);
      } else {
        if (isBinaryFile(entry.name)) continue;

        const relativePath = path.relative(rootDir, path.join(dir, entry.name));
        const matchTarget = hasPathSeparator ? relativePath : entry.name;

        if (matchTarget.toLowerCase().includes(queryLower)) {
          let size: number | undefined;
          try {
            const stat = await fs.promises.stat(path.join(dir, entry.name));
            size = stat.size;
          } catch {
            // Skip files we can't stat
          }

          results.push({
            path: relativePath,
            isDirectory: false,
            size,
            mime: guessMime(entry.name),
          });
        }
      }
    }
  }

  await walk(searchDir, 0);

  // Sort: path depth (shallow first) → alphabetical
  results.sort((a, b) => {
    const aDepth = a.path.split("/").length;
    const bDepth = b.path.split("/").length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    return a.path.localeCompare(b.path);
  });

  return results.slice(0, limit);
}

// =============================================================================
// Handler Implementations
// =============================================================================

function createSearchHandler(services: WorkspaceFileServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { agentId, query, cwd, limit: rawLimit } = (params ?? {}) as FileSearchParams;

    if (!agentId) {
      throw RPCError.invalidParams("agentId is required");
    }
    if (!query || typeof query !== "string") {
      throw RPCError.invalidParams("query is required and must be a string");
    }

    if (!services.agentExists(agentId as AgentId)) {
      throw RPCError.notFound("agent", agentId);
    }

    const workspace = services.getWorkspace(agentId as AgentId);
    if (!workspace) {
      return { files: [] };
    }

    const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const searchRoot = cwd
      ? resolveWorkspacePath(workspace.path, cwd)
      : workspace.path;

    const files = await searchFiles(workspace.path, searchRoot, query, limit);
    return { files };
  };
}

function createListHandler(services: WorkspaceFileServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { agentId, directory = "." } = (params ?? {}) as FileListParams;

    if (!agentId) {
      throw RPCError.invalidParams("agentId is required");
    }

    if (!services.agentExists(agentId as AgentId)) {
      throw RPCError.notFound("agent", agentId);
    }

    const workspace = services.getWorkspace(agentId as AgentId);
    if (!workspace) {
      return { files: [] };
    }

    const dirPath = resolveWorkspacePath(workspace.path, directory);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      throw RPCError.invalidParams(`Directory not found: ${directory}`);
    }

    const files: FileSearchResult[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) continue;
        files.push({
          path: path.relative(workspace.path, path.join(dirPath, entry.name)) + "/",
          isDirectory: true,
        });
      } else {
        if (isBinaryFile(entry.name)) continue;
        let size: number | undefined;
        try {
          const stat = await fs.promises.stat(path.join(dirPath, entry.name));
          size = stat.size;
        } catch {
          // Skip
        }
        files.push({
          path: path.relative(workspace.path, path.join(dirPath, entry.name)),
          isDirectory: false,
          size,
          mime: guessMime(entry.name),
        });
      }
    }

    // Sort directories first, then alphabetically
    files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    return { files };
  };
}

function createReadHandler(services: WorkspaceFileServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { agentId, path: filePath, lineRange } = (params ?? {}) as FileReadParams;

    if (!agentId) {
      throw RPCError.invalidParams("agentId is required");
    }
    if (!filePath || typeof filePath !== "string") {
      throw RPCError.invalidParams("path is required and must be a string");
    }

    if (!services.agentExists(agentId as AgentId)) {
      throw RPCError.notFound("agent", agentId);
    }

    const workspace = services.getWorkspace(agentId as AgentId);
    if (!workspace) {
      throw RPCError.invalidParams(`Agent ${agentId} has no workspace`);
    }

    const absolutePath = resolveWorkspacePath(workspace.path, filePath);

    // Check file exists and get size
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch {
      throw RPCError.invalidParams(`File not found: ${filePath}`);
    }

    if (stat.isDirectory()) {
      throw RPCError.invalidParams(`Path is a directory: ${filePath}`);
    }

    if (stat.size > MAX_FILE_READ_SIZE) {
      throw RPCError.resourceLimitExceeded(
        `File too large: ${stat.size} bytes (max ${MAX_FILE_READ_SIZE})`
      );
    }

    let text = await fs.promises.readFile(absolutePath, "utf-8");

    // Apply line range if specified
    if (lineRange) {
      const { start, end } = lineRange;
      if (typeof start !== "number" || typeof end !== "number" || start < 1 || end < start) {
        throw RPCError.invalidParams("lineRange must have start >= 1 and end >= start");
      }
      const lines = text.split("\n");
      text = lines.slice(start - 1, end).join("\n");
    }

    return {
      text,
      mime: guessMime(filePath),
      size: stat.size,
    };
  };
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register workspace file search extension methods with the MAPAdapter.
 *
 * @param adapter - MAPAdapter instance
 * @param services - Workspace file search services
 */
export function registerWorkspaceFileExtensions(
  adapter: MAPAdapter,
  services: WorkspaceFileServices,
): void {
  adapter.registerExtension("_macro/workspace/files/search", createSearchHandler(services));
  adapter.registerExtension("_macro/workspace/files/list", createListHandler(services));
  adapter.registerExtension("_macro/workspace/files/read", createReadHandler(services));
}

/**
 * Unregister workspace file search extension methods.
 *
 * @param adapter - MAPAdapter instance
 */
export function unregisterWorkspaceFileExtensions(adapter: MAPAdapter): void {
  adapter.unregisterExtension("_macro/workspace/files/search");
  adapter.unregisterExtension("_macro/workspace/files/list");
  adapter.unregisterExtension("_macro/workspace/files/read");
}
