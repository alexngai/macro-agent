/**
 * Sudocode Issue Fixtures
 *
 * Predefined issues for testing.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7f2l Phase 4: Fixtures Library
 */

import type { PartialIssue } from "../repos/types.js";

/**
 * Simple implementation issue
 */
export const SIMPLE_ISSUE: PartialIssue = {
  id: "i-simple",
  title: "Implement simple feature",
  implements: "s-simple",
};

/**
 * Auth-related issues
 */
export const AUTH_ISSUES: PartialIssue[] = [
  {
    id: "i-auth-login",
    title: "Implement login endpoint",
    implements: "s-auth",
  },
  {
    id: "i-auth-register",
    title: "Implement registration endpoint",
    implements: "s-auth",
  },
  {
    id: "i-auth-jwt",
    title: "Add JWT token handling",
    implements: "s-auth",
    blockedBy: ["i-auth-login"],
  },
  {
    id: "i-auth-refresh",
    title: "Implement token refresh",
    implements: "s-auth",
    blockedBy: ["i-auth-jwt"],
  },
];

/**
 * API-related issues
 */
export const API_ISSUES: PartialIssue[] = [
  {
    id: "i-api-users",
    title: "Create users CRUD",
    implements: "s-api",
  },
  {
    id: "i-api-resources",
    title: "Create resources CRUD",
    implements: "s-api",
  },
  {
    id: "i-api-errors",
    title: "Add error handling",
    implements: "s-api",
  },
];

/**
 * Create issue with custom properties
 */
export function createIssue(
  id: string,
  title: string,
  options: Partial<PartialIssue> = {}
): PartialIssue {
  return {
    id,
    title,
    ...options,
  };
}

/**
 * Create blocked issue chain
 */
export function createBlockedIssueChain(
  specId: string,
  titles: string[]
): PartialIssue[] {
  return titles.map((title, index) => ({
    id: `i-${specId}-${index}`,
    title,
    implements: specId,
    blockedBy: index > 0 ? [`i-${specId}-${index - 1}`] : undefined,
  }));
}

/**
 * Issues with parallel and sequential dependencies
 */
export const COMPLEX_ISSUE_SET: PartialIssue[] = [
  // Setup phase (parallel)
  {
    id: "i-setup-db",
    title: "Setup database",
    implements: "s-core",
  },
  {
    id: "i-setup-auth",
    title: "Setup auth",
    implements: "s-core",
  },
  // Build phase (depends on setup)
  {
    id: "i-build-models",
    title: "Build data models",
    implements: "s-core",
    blockedBy: ["i-setup-db"],
  },
  {
    id: "i-build-middleware",
    title: "Build middleware",
    implements: "s-core",
    blockedBy: ["i-setup-auth"],
  },
  // Integration phase (depends on build)
  {
    id: "i-integrate",
    title: "Integration",
    implements: "s-core",
    blockedBy: ["i-build-models", "i-build-middleware"],
  },
];

/**
 * Issues for testing task assignment
 */
export const ASSIGNABLE_ISSUES: PartialIssue[] = [
  {
    id: "i-task-1",
    title: "Task 1 - Easy",
    implements: "s-simple",
  },
  {
    id: "i-task-2",
    title: "Task 2 - Medium",
    implements: "s-simple",
  },
  {
    id: "i-task-3",
    title: "Task 3 - Hard",
    implements: "s-simple",
  },
];

/**
 * Issues that represent a typical feature implementation
 */
export const FEATURE_IMPLEMENTATION_ISSUES: PartialIssue[] = [
  {
    id: "i-feature-design",
    title: "Design feature architecture",
    implements: "s-feature-main",
  },
  {
    id: "i-feature-backend",
    title: "Implement backend",
    implements: "s-feature-api",
    blockedBy: ["i-feature-design"],
  },
  {
    id: "i-feature-frontend",
    title: "Implement frontend",
    implements: "s-feature-ui",
    blockedBy: ["i-feature-design"],
  },
  {
    id: "i-feature-integration",
    title: "Integration testing",
    implements: "s-feature-main",
    blockedBy: ["i-feature-backend", "i-feature-frontend"],
  },
];
