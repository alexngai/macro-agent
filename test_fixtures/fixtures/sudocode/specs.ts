/**
 * Sudocode Spec Fixtures
 *
 * Predefined specs for testing.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7f2l Phase 4: Fixtures Library
 */

import type { PartialSpec } from "../repos/types.js";

/**
 * Simple feature spec
 */
export const SIMPLE_FEATURE_SPEC: PartialSpec = {
  id: "s-simple",
  title: "Simple Feature",
  description: `## Overview
Implement a simple feature.

## Requirements
- Basic functionality
- Tests included

## Acceptance Criteria
- Feature works as expected
- Tests pass`,
};

/**
 * Authentication spec
 */
export const AUTH_SPEC: PartialSpec = {
  id: "s-auth",
  title: "User Authentication",
  description: `## Overview
Implement user authentication system.

## Requirements
- Email/password login
- JWT tokens
- Session management
- Password hashing

## Endpoints
- POST /auth/login
- POST /auth/register
- POST /auth/logout
- GET /auth/me

## Security Requirements
- Passwords hashed with bcrypt
- JWT expires in 1 hour
- Refresh token support`,
};

/**
 * API spec
 */
export const API_SPEC: PartialSpec = {
  id: "s-api",
  title: "REST API",
  description: `## Overview
Design and implement REST API.

## Endpoints
- CRUD for users
- CRUD for resources
- Proper error handling

## Standards
- RESTful conventions
- JSON responses
- Proper HTTP status codes`,
};

/**
 * Database spec
 */
export const DATABASE_SPEC: PartialSpec = {
  id: "s-db",
  title: "Database Layer",
  description: `## Overview
Implement database layer.

## Requirements
- Connection pooling
- Query builder
- Migrations
- Transactions`,
};

/**
 * Create spec with custom content
 */
export function createSpec(
  id: string,
  title: string,
  description: string,
  options: Partial<PartialSpec> = {}
): PartialSpec {
  return {
    id,
    title,
    description,
    ...options,
  };
}

/**
 * Collection of related specs for a full feature
 */
export const FEATURE_SPEC_SET: PartialSpec[] = [
  {
    id: "s-feature-main",
    title: "Main Feature",
    description: "Top-level feature specification",
  },
  {
    id: "s-feature-ui",
    title: "Feature UI",
    description: "UI components for the feature",
    parent: "s-feature-main",
  },
  {
    id: "s-feature-api",
    title: "Feature API",
    description: "API endpoints for the feature",
    parent: "s-feature-main",
  },
  {
    id: "s-feature-db",
    title: "Feature Database",
    description: "Database schema for the feature",
    parent: "s-feature-main",
  },
];

/**
 * Specs with dependencies
 */
export const DEPENDENT_SPECS: PartialSpec[] = [
  {
    id: "s-core",
    title: "Core Library",
    description: "Core library that other specs depend on",
  },
  {
    id: "s-utils",
    title: "Utilities",
    description: "Utility functions",
    parent: "s-core",
  },
  {
    id: "s-app",
    title: "Application",
    description: "Main application that uses core and utils",
  },
];
