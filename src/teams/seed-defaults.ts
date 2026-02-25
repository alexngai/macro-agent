/**
 * Seed Default Team Templates
 *
 * Copies bundled default team templates from the macro-agent package
 * to the project's .multiagent/teams/ directory on first use.
 * Idempotent — only copies templates that don't already exist.
 *
 * @module teams/seed-defaults
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Package root: up from src/teams/ → src/ → package root
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const BUNDLED_TEAMS_DIR = path.join(PACKAGE_ROOT, ".multiagent", "teams");
const TEAMS_DIR = ".multiagent/teams";

/**
 * Copy bundled default team templates to the project's .multiagent/teams/ directory.
 *
 * Only copies templates that don't already exist at the target path —
 * user-customized templates are never overwritten. Safe to call on every startup.
 *
 * @param basePath - Project root directory (e.g., process.cwd())
 * @returns Names of templates that were copied
 */
export async function seedDefaultTemplates(basePath: string): Promise<string[]> {
  const targetDir = path.join(basePath, TEAMS_DIR);
  const seeded: string[] = [];

  // Check if bundled templates exist in the package
  if (!fs.existsSync(BUNDLED_TEAMS_DIR)) return seeded;

  let bundledTemplates: fs.Dirent[];
  try {
    bundledTemplates = fs.readdirSync(BUNDLED_TEAMS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
  } catch {
    return seeded;
  }

  if (bundledTemplates.length === 0) return seeded;

  // Ensure target directory exists
  fs.mkdirSync(targetDir, { recursive: true });

  for (const templateDir of bundledTemplates) {
    const targetTemplatePath = path.join(targetDir, templateDir.name);
    if (fs.existsSync(targetTemplatePath)) continue; // Don't overwrite

    // Recursive copy of the entire template directory
    copyDirRecursive(
      path.join(BUNDLED_TEAMS_DIR, templateDir.name),
      targetTemplatePath,
    );
    seeded.push(templateDir.name);
  }

  return seeded;
}

/**
 * Recursively copy a directory tree.
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
