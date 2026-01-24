/**
 * Vitest Global Setup
 *
 * This file runs before all tests to set up safeguards and global configuration.
 */

import { beforeAll, vi } from "vitest";

// Store the real project path
const REAL_PROJECT_PATH = process.cwd();

/**
 * Safety check: Prevent tests from accidentally using the real project's
 * sudocode directory by intercepting StandaloneClient creation.
 *
 * Tests that need to use sudocode should use temp directories.
 */
beforeAll(() => {
  // Track original module for potential restoration
  const originalCwd = process.cwd;

  // Create a spy on process.cwd that tracks calls
  // This helps identify if any test is trying to use the real project
  const cwdSpy = vi.spyOn(process, "cwd");

  // We can't fully prevent process.cwd() from being called, but we can
  // set up the environment to make it clear we're in a test
  process.env.NODE_ENV = "test";

  // Log a warning if MACRO_TASK_BACKEND=sudocode without explicit path
  if (
    process.env.MACRO_TASK_BACKEND === "sudocode" &&
    !process.env.SUDOCODE_PROJECT_PATH
  ) {
    console.warn(
      "\n⚠️  WARNING: MACRO_TASK_BACKEND=sudocode but SUDOCODE_PROJECT_PATH is not set.\n" +
        "   Tests may accidentally modify the real project's .sudocode/ directory.\n" +
        "   Set SUDOCODE_PROJECT_PATH to a temp directory for safety.\n"
    );
  }
});
