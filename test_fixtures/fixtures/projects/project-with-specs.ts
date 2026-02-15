/**
 * Project Fixtures with Pre-configured Data
 *
 * Projects pre-configured with dataplane for testing.
 */

import type { TempRepoOptions } from "../repos/types.js";
import { TYPESCRIPT_PROJECT } from "./typescript-project.js";

/**
 * TypeScript project with dataplane enabled
 */
export const PROJECT_WITH_SPECS: TempRepoOptions = {
  initialFiles: TYPESCRIPT_PROJECT,
  withDataplane: true,
};

/**
 * Create project with dataplane and custom files
 */
export function createProjectWithSpecs(
  initialFiles: Record<string, string> = TYPESCRIPT_PROJECT
): TempRepoOptions {
  return {
    initialFiles,
    withDataplane: true,
  };
}

/**
 * Project with dataplane and branches
 */
export const PROJECT_WITH_HIERARCHICAL_SPECS: TempRepoOptions = {
  initialFiles: TYPESCRIPT_PROJECT,
  withDataplane: true,
};

/**
 * Project with dataplane for dependency testing
 */
export const PROJECT_WITH_BLOCKED_ISSUES: TempRepoOptions = {
  initialFiles: TYPESCRIPT_PROJECT,
  withDataplane: true,
};
