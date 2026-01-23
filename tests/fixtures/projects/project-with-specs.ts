/**
 * Project with Sudocode Specs Fixtures
 *
 * Projects pre-configured with specs and issues for testing.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7f2l Phase 4: Fixtures Library
 */

import type { TempRepoOptions, PartialSpec, PartialIssue } from "../repos/types.js";
import { TYPESCRIPT_PROJECT } from "./typescript-project.js";

/**
 * Sample specs for testing
 */
export const SAMPLE_SPECS: PartialSpec[] = [
  {
    id: "s-auth",
    title: "User Authentication System",
    description: `## Overview
Implement a secure user authentication system.

## Requirements
- Support email/password login
- JWT token management
- Session handling

## Acceptance Criteria
- Users can register with email/password
- Users can login and receive JWT
- Invalid credentials return 401`,
  },
  {
    id: "s-api",
    title: "REST API Design",
    description: `## Overview
Design and implement REST API endpoints.

## Endpoints
- GET /users - List users
- POST /users - Create user
- GET /users/:id - Get user
- PUT /users/:id - Update user
- DELETE /users/:id - Delete user

## Standards
- Use JSON for request/response
- Follow REST conventions
- Include proper error handling`,
  },
];

/**
 * Sample issues for testing
 */
export const SAMPLE_ISSUES: PartialIssue[] = [
  {
    id: "i-auth-login",
    title: "Implement login endpoint",
    implements: "s-auth",
  },
  {
    id: "i-auth-jwt",
    title: "Add JWT token generation",
    implements: "s-auth",
  },
  {
    id: "i-api-users",
    title: "Create users CRUD endpoints",
    implements: "s-api",
  },
];

/**
 * TypeScript project with sudocode specs and issues
 */
export const PROJECT_WITH_SPECS: TempRepoOptions = {
  initialFiles: TYPESCRIPT_PROJECT,
  withDataplane: true,
  withSudocode: true,
  sudocodeSpecs: SAMPLE_SPECS,
  sudocodeIssues: SAMPLE_ISSUES,
};

/**
 * Create project with custom specs and issues
 */
export function createProjectWithSpecs(
  specs: PartialSpec[],
  issues: PartialIssue[],
  initialFiles: Record<string, string> = TYPESCRIPT_PROJECT
): TempRepoOptions {
  return {
    initialFiles,
    withDataplane: true,
    withSudocode: true,
    sudocodeSpecs: specs,
    sudocodeIssues: issues,
  };
}

/**
 * Project with hierarchical specs (parent-child relationships)
 */
export const PROJECT_WITH_HIERARCHICAL_SPECS: TempRepoOptions = {
  initialFiles: TYPESCRIPT_PROJECT,
  withDataplane: true,
  withSudocode: true,
  sudocodeSpecs: [
    {
      id: "s-main",
      title: "Main Feature",
      description: "The main feature specification",
    },
    {
      id: "s-sub1",
      title: "Sub-feature 1",
      description: "First sub-feature",
      parent: "s-main",
    },
    {
      id: "s-sub2",
      title: "Sub-feature 2",
      description: "Second sub-feature",
      parent: "s-main",
    },
  ],
  sudocodeIssues: [
    {
      id: "i-main",
      title: "Implement main feature",
      implements: "s-main",
    },
    {
      id: "i-sub1",
      title: "Implement sub-feature 1",
      implements: "s-sub1",
    },
    {
      id: "i-sub2",
      title: "Implement sub-feature 2",
      implements: "s-sub2",
    },
  ],
};

/**
 * Project with blocked issues (dependency chain)
 */
export const PROJECT_WITH_BLOCKED_ISSUES: TempRepoOptions = {
  initialFiles: TYPESCRIPT_PROJECT,
  withDataplane: true,
  withSudocode: true,
  sudocodeSpecs: [
    {
      id: "s-pipeline",
      title: "Data Pipeline",
      description: "Build data processing pipeline",
    },
  ],
  sudocodeIssues: [
    {
      id: "i-setup",
      title: "Setup infrastructure",
      implements: "s-pipeline",
    },
    {
      id: "i-ingest",
      title: "Implement data ingestion",
      implements: "s-pipeline",
      blockedBy: ["i-setup"],
    },
    {
      id: "i-transform",
      title: "Implement data transformation",
      implements: "s-pipeline",
      blockedBy: ["i-ingest"],
    },
    {
      id: "i-output",
      title: "Implement data output",
      implements: "s-pipeline",
      blockedBy: ["i-transform"],
    },
  ],
};
