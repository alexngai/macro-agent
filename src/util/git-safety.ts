/**
 * Git input-safety helpers.
 *
 * Centralizes validation for values that get passed to `git` when any part of
 * the input can originate from an untrusted source (an OpenHive hub envelope, a
 * federated peer, a team template, etc.). Callers MUST use `execFileSync("git",
 * [...])` with array args — never a shell string — and validate refs/remotes/
 * URLs/paths through these helpers first.
 *
 * @module util/git-safety
 */

import * as path from "node:path";

/**
 * Git refs, branch names, and remote names we accept. Deliberately strict:
 * word chars plus `._/-`. Rejects shell metacharacters, whitespace, and (via
 * {@link assertSafeGitRef}) leading `-` (which git would treat as an option)
 * and `..` (ref-traversal / path escapes).
 */
const SAFE_REF_RE = /^[A-Za-z0-9._/-]+$/;

/** URL schemes we allow `git clone`/`fetch` to talk to. */
const ALLOWED_URL_SCHEMES = new Set(["https:", "ssh:", "git:", "http:"]);

export class GitInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitInputError";
  }
}

/**
 * Validate a git ref / branch / remote name. Throws {@link GitInputError} on
 * anything that isn't a plain ref token. Returns the value for convenient
 * inline use.
 */
export function assertSafeGitRef(value: string, label = "ref"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitInputError(`Invalid git ${label}: empty`);
  }
  if (value.length > 255) {
    throw new GitInputError(`Invalid git ${label}: too long`);
  }
  if (value.startsWith("-")) {
    // A leading dash would be parsed by git as an option flag.
    throw new GitInputError(`Invalid git ${label}: must not start with '-'`);
  }
  if (value.includes("..")) {
    throw new GitInputError(`Invalid git ${label}: must not contain '..'`);
  }
  if (!SAFE_REF_RE.test(value)) {
    throw new GitInputError(
      `Invalid git ${label}: only letters, digits and '._/-' are allowed`,
    );
  }
  return value;
}

/**
 * Validate a repository URL for `git clone`/`fetch`. Accepts only
 * http(s)/ssh/git schemes and rejects anything that isn't a parseable URL or
 * that git would treat as an option (leading `-`). Returns the URL string.
 */
export function assertSafeRepoUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitInputError("Invalid repo URL: empty");
  }
  if (value.startsWith("-")) {
    throw new GitInputError("Invalid repo URL: must not start with '-'");
  }
  // scp-like syntax (user@host:path) is not a URL; reject it in favour of an
  // explicit ssh:// URL so parsing (and scheme validation) is unambiguous.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GitInputError("Invalid repo URL: not a valid URL");
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new GitInputError(
      `Invalid repo URL: scheme '${parsed.protocol}' is not allowed`,
    );
  }
  return value;
}

/**
 * Resolve `candidate` under `baseDir` and assert it stays inside. Returns the
 * absolute, contained path. Guards against absolute-path override and `../`
 * escapes for filesystem locations derived from untrusted input.
 */
export function containPath(baseDir: string, candidate: string): string {
  const base = path.resolve(baseDir);
  // Treat the candidate as relative to the base by stripping any leading
  // separators, so an absolute `candidate` can't override the base.
  const rel = candidate.replace(/^[/\\]+/, "");
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new GitInputError(
      `Unsafe path: '${candidate}' escapes base directory '${baseDir}'`,
    );
  }
  return resolved;
}
