/**
 * Federation Envelope Handling
 *
 * Wraps and unwraps messages for cross-system federation communication.
 * The envelope adds metadata needed for routing and tracing across systems.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { SystemId } from "../types.js";

// =============================================================================
// Envelope Types
// =============================================================================

/**
 * Federation metadata attached to cross-system messages.
 */
export interface FederationMetadata {
  /** Source system identifier */
  sourceSystem: SystemId;

  /** Target system identifier */
  targetSystem: SystemId;

  /** Unix timestamp when envelope was created */
  timestamp: number;

  /** Optional correlation ID for request/response tracking */
  correlationId?: string;
}

/**
 * Federation envelope wrapping a message for cross-system transport.
 */
export interface FederationEnvelope<T = unknown> {
  /** The wrapped message payload */
  message: T;

  /** Federation routing metadata */
  federation: FederationMetadata;
}

// =============================================================================
// Envelope Functions
// =============================================================================

/**
 * Wrap a message in a federation envelope.
 *
 * @param message - The message to wrap
 * @param sourceSystem - The source system identifier
 * @param targetSystem - The target system identifier
 * @param options - Optional envelope options
 * @returns The wrapped envelope
 */
export function wrapMessage<T>(
  message: T,
  sourceSystem: SystemId,
  targetSystem: SystemId,
  options?: {
    correlationId?: string;
    timestamp?: number;
  }
): FederationEnvelope<T> {
  return {
    message,
    federation: {
      sourceSystem,
      targetSystem,
      timestamp: options?.timestamp ?? Date.now(),
      ...(options?.correlationId && { correlationId: options.correlationId }),
    },
  };
}

/**
 * Unwrap a message from a federation envelope.
 *
 * @param envelope - The envelope to unwrap
 * @returns The unwrapped message
 */
export function unwrapMessage<T>(envelope: FederationEnvelope<T>): T {
  return envelope.message;
}

/**
 * Get the federation metadata from an envelope.
 *
 * @param envelope - The envelope
 * @returns The federation metadata
 */
export function getMetadata(envelope: FederationEnvelope): FederationMetadata {
  return envelope.federation;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if an object is a valid federation envelope.
 *
 * @param obj - The object to check
 * @returns True if the object is a valid federation envelope
 */
export function isEnvelope(obj: unknown): obj is FederationEnvelope {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const envelope = obj as Record<string, unknown>;

  // Must have message property
  if (!("message" in envelope)) {
    return false;
  }

  // Must have federation metadata
  if (!("federation" in envelope) || typeof envelope.federation !== "object") {
    return false;
  }

  const federation = envelope.federation as Record<string, unknown>;

  // Required federation fields
  if (typeof federation.sourceSystem !== "string") {
    return false;
  }
  if (typeof federation.targetSystem !== "string") {
    return false;
  }
  if (typeof federation.timestamp !== "number") {
    return false;
  }

  // Optional correlationId must be string if present
  if (
    "correlationId" in federation &&
    typeof federation.correlationId !== "string"
  ) {
    return false;
  }

  return true;
}

/**
 * Validate envelope metadata.
 *
 * @param envelope - The envelope to validate
 * @returns Array of validation errors, empty if valid
 */
export function validateEnvelope(envelope: FederationEnvelope): string[] {
  const errors: string[] = [];

  if (!envelope.federation.sourceSystem) {
    errors.push("sourceSystem is required");
  }

  if (!envelope.federation.targetSystem) {
    errors.push("targetSystem is required");
  }

  if (typeof envelope.federation.timestamp !== "number") {
    errors.push("timestamp must be a number");
  } else if (envelope.federation.timestamp <= 0) {
    errors.push("timestamp must be positive");
  }

  if (envelope.federation.sourceSystem === envelope.federation.targetSystem) {
    errors.push("sourceSystem and targetSystem cannot be the same");
  }

  return errors;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create a response envelope from a request envelope.
 * Swaps source and target systems.
 *
 * @param requestEnvelope - The original request envelope
 * @param responseMessage - The response message
 * @returns A new envelope for the response
 */
export function createResponseEnvelope<T>(
  requestEnvelope: FederationEnvelope,
  responseMessage: T
): FederationEnvelope<T> {
  return wrapMessage(
    responseMessage,
    requestEnvelope.federation.targetSystem,
    requestEnvelope.federation.sourceSystem,
    {
      correlationId: requestEnvelope.federation.correlationId,
    }
  );
}

/**
 * Check if an envelope is a response to a request.
 *
 * @param request - The request envelope
 * @param response - The potential response envelope
 * @returns True if response matches the request
 */
export function isResponseTo(
  request: FederationEnvelope,
  response: FederationEnvelope
): boolean {
  // Systems must be swapped
  if (
    response.federation.sourceSystem !== request.federation.targetSystem ||
    response.federation.targetSystem !== request.federation.sourceSystem
  ) {
    return false;
  }

  // If request had correlationId, response must match
  if (request.federation.correlationId) {
    return response.federation.correlationId === request.federation.correlationId;
  }

  return true;
}

/**
 * Get age of an envelope in milliseconds.
 *
 * @param envelope - The envelope
 * @param now - Current timestamp (defaults to Date.now())
 * @returns Age in milliseconds
 */
export function getEnvelopeAge(
  envelope: FederationEnvelope,
  now: number = Date.now()
): number {
  return now - envelope.federation.timestamp;
}
