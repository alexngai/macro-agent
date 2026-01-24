/**
 * Steering Module
 *
 * Context injection and in-flight steering for agents.
 *
 * @module steering
 * @see s-9rld In-Flight Steering spec
 */

// Types
export type {
  InjectionSource,
  InjectionOptions,
  InjectionMethod,
  InjectionResult,
  InjectableSession,
  InjectionDeps,
} from "./types.js";

// Core functions
export {
  injectContext,
  createInjector,
  formatInjectedContent,
} from "./inject.js";
