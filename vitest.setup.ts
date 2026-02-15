/**
 * Vitest Global Setup
 *
 * This file runs before all tests to set up safeguards and global configuration.
 */

import { beforeAll, vi } from "vitest";

beforeAll(() => {
  // Set up the environment to make it clear we're in a test
  process.env.NODE_ENV = "test";
});
