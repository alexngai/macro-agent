/**
 * HierarchyErrors - Error codes and handling for distributed hierarchy operations
 *
 * Provides structured error codes, error class, and factory methods
 * for all hierarchy pattern errors.
 *
 * Error code ranges:
 * - 4000-4099: General hierarchy errors
 * - 4100-4199: Federation-specific errors
 * - 4200-4299: Encapsulation-specific errors
 */

// ─────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────

/**
 * General hierarchy error codes (4000-4099)
 */
export const GENERAL_ERROR_CODES = {
  /** Peer lacks required capability for operation */
  CAPABILITY_DENIED: 4001,
  /** Cannot reach target peer */
  PEER_UNAVAILABLE: 4002,
  /** Remote peer declined the task */
  TASK_REJECTED: 4003,
  /** Task exceeded timeout without completion */
  TASK_TIMEOUT: 4004,
  /** Malformed request parameters */
  INVALID_REQUEST: 4005,
  /** Unexpected error during processing */
  INTERNAL_ERROR: 4006,
} as const;

/**
 * Federation-specific error codes (4100-4199)
 */
export const FEDERATION_ERROR_CODES = {
  /** Remote peer declined federation */
  FEDERATION_REJECTED: 4101,
  /** Requested agent doesn't exist in hierarchy */
  REMOTE_AGENT_NOT_FOUND: 4102,
  /** Federation ID doesn't exist */
  FEDERATION_NOT_FOUND: 4103,
  /** Cannot mount the requested agent */
  MOUNT_DENIED: 4104,
  /** Federation already exists with this peer */
  ALREADY_FEDERATED: 4105,
} as const;

/**
 * Encapsulation-specific error codes (4200-4299)
 */
export const ENCAPSULATION_ERROR_CODES = {
  /** Parent rejected encapsulation registration */
  REGISTRATION_REJECTED: 4201,
  /** Proxy agent ID doesn't exist */
  PROXY_NOT_FOUND: 4202,
  /** Already registered with this parent */
  ALREADY_REGISTERED: 4203,
  /** Not registered as encapsulated child */
  NOT_REGISTERED: 4204,
} as const;

/**
 * All error codes
 */
export const HIERARCHY_ERROR_CODES = {
  ...GENERAL_ERROR_CODES,
  ...FEDERATION_ERROR_CODES,
  ...ENCAPSULATION_ERROR_CODES,
} as const;

/**
 * Error code type
 */
export type HierarchyErrorCode =
  (typeof HIERARCHY_ERROR_CODES)[keyof typeof HIERARCHY_ERROR_CODES];

/**
 * Error name type (for human-readable messages)
 */
export type HierarchyErrorName = keyof typeof HIERARCHY_ERROR_CODES;

/**
 * Map from error code to name
 */
const ERROR_CODE_TO_NAME: Record<HierarchyErrorCode, HierarchyErrorName> = {
  4001: "CAPABILITY_DENIED",
  4002: "PEER_UNAVAILABLE",
  4003: "TASK_REJECTED",
  4004: "TASK_TIMEOUT",
  4005: "INVALID_REQUEST",
  4006: "INTERNAL_ERROR",
  4101: "FEDERATION_REJECTED",
  4102: "REMOTE_AGENT_NOT_FOUND",
  4103: "FEDERATION_NOT_FOUND",
  4104: "MOUNT_DENIED",
  4105: "ALREADY_FEDERATED",
  4201: "REGISTRATION_REJECTED",
  4202: "PROXY_NOT_FOUND",
  4203: "ALREADY_REGISTERED",
  4204: "NOT_REGISTERED",
};

// ─────────────────────────────────────────────────────────────────
// Error Class
// ─────────────────────────────────────────────────────────────────

/**
 * Error class for hierarchy operations
 */
export class HierarchyError extends Error {
  /** Numeric error code */
  readonly errorCode: HierarchyErrorCode;
  /** Additional error data */
  readonly data?: unknown;

  constructor(code: HierarchyErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "HierarchyError";
    this.errorCode = code;
    this.data = data;
  }

  /**
   * Get the error name (e.g., "CAPABILITY_DENIED")
   */
  get errorName(): HierarchyErrorName {
    return ERROR_CODE_TO_NAME[this.errorCode];
  }

  /**
   * Convert to a response error object
   */
  toResponseError(): { code: number; message: string; data?: unknown } {
    return {
      code: this.errorCode,
      message: this.errorName,
      data: this.data,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// Factory Methods - General Errors
// ─────────────────────────────────────────────────────────────────

/**
 * Create a CAPABILITY_DENIED error
 */
export function capabilityDenied(
  capability: string,
  peerId?: string
): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.CAPABILITY_DENIED,
    `Peer lacks required capability: ${capability}`,
    { capability, peerId }
  );
}

/**
 * Create a PEER_UNAVAILABLE error
 */
export function peerUnavailable(peerId: string, reason?: string): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.PEER_UNAVAILABLE,
    `Cannot reach peer: ${peerId}${reason ? ` (${reason})` : ""}`,
    { peerId, reason }
  );
}

/**
 * Create a TASK_REJECTED error
 */
export function taskRejected(taskId: string, reason?: string): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.TASK_REJECTED,
    `Task rejected: ${taskId}${reason ? ` (${reason})` : ""}`,
    { taskId, reason }
  );
}

/**
 * Create a TASK_TIMEOUT error
 */
export function taskTimeout(taskId: string, timeoutMs?: number): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.TASK_TIMEOUT,
    `Task timeout: ${taskId}${timeoutMs ? ` after ${timeoutMs}ms` : ""}`,
    { taskId, timeoutMs }
  );
}

/**
 * Create an INVALID_REQUEST error
 */
export function invalidRequest(reason: string, details?: unknown): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.INVALID_REQUEST,
    `Invalid request: ${reason}`,
    details
  );
}

/**
 * Create an INTERNAL_ERROR error
 */
export function internalError(message: string, cause?: unknown): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.INTERNAL_ERROR,
    `Internal error: ${message}`,
    { cause }
  );
}

// ─────────────────────────────────────────────────────────────────
// Factory Methods - Federation Errors
// ─────────────────────────────────────────────────────────────────

/**
 * Create a FEDERATION_REJECTED error
 */
export function federationRejected(peerId: string, reason?: string): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.FEDERATION_REJECTED,
    `Federation rejected by peer: ${peerId}${reason ? ` (${reason})` : ""}`,
    { peerId, reason }
  );
}

/**
 * Create a REMOTE_AGENT_NOT_FOUND error
 */
export function remoteAgentNotFound(agentId: string, peerId?: string): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.REMOTE_AGENT_NOT_FOUND,
    `Remote agent not found: ${agentId}`,
    { agentId, peerId }
  );
}

/**
 * Create a FEDERATION_NOT_FOUND error
 */
export function federationNotFound(federationId: string): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.FEDERATION_NOT_FOUND,
    `Federation not found: ${federationId}`,
    { federationId }
  );
}

/**
 * Create a MOUNT_DENIED error
 */
export function mountDenied(agentId: string, reason?: string): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.MOUNT_DENIED,
    `Cannot mount agent: ${agentId}${reason ? ` (${reason})` : ""}`,
    { agentId, reason }
  );
}

/**
 * Create an ALREADY_FEDERATED error
 */
export function alreadyFederated(peerId: string): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.ALREADY_FEDERATED,
    `Already federated with peer: ${peerId}`,
    { peerId }
  );
}

// ─────────────────────────────────────────────────────────────────
// Factory Methods - Encapsulation Errors
// ─────────────────────────────────────────────────────────────────

/**
 * Create a REGISTRATION_REJECTED error
 */
export function registrationRejected(
  parentPeerId: string,
  reason?: string
): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.REGISTRATION_REJECTED,
    `Registration rejected by parent: ${parentPeerId}${reason ? ` (${reason})` : ""}`,
    { parentPeerId, reason }
  );
}

/**
 * Create a PROXY_NOT_FOUND error
 */
export function proxyNotFound(proxyAgentId: string): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.PROXY_NOT_FOUND,
    `Proxy agent not found: ${proxyAgentId}`,
    { proxyAgentId }
  );
}

/**
 * Create an ALREADY_REGISTERED error
 */
export function alreadyRegistered(parentPeerId: string): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.ALREADY_REGISTERED,
    `Already registered with parent: ${parentPeerId}`,
    { parentPeerId }
  );
}

/**
 * Create a NOT_REGISTERED error
 */
export function notRegistered(parentPeerId: string): HierarchyError {
  return new HierarchyError(
    HIERARCHY_ERROR_CODES.NOT_REGISTERED,
    `Not registered with parent: ${parentPeerId}`,
    { parentPeerId }
  );
}

// ─────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────

/**
 * Check if an error is a HierarchyError
 */
export function isHierarchyError(error: unknown): error is HierarchyError {
  return error instanceof HierarchyError;
}

/**
 * Get the error name from a code
 */
export function getErrorName(code: number): HierarchyErrorName | null {
  return ERROR_CODE_TO_NAME[code as HierarchyErrorCode] ?? null;
}

/**
 * Check if an error code is in the general range
 */
export function isGeneralError(code: number): boolean {
  return code >= 4000 && code < 4100;
}

/**
 * Check if an error code is in the federation range
 */
export function isFederationError(code: number): boolean {
  return code >= 4100 && code < 4200;
}

/**
 * Check if an error code is in the encapsulation range
 */
export function isEncapsulationError(code: number): boolean {
  return code >= 4200 && code < 4300;
}

/**
 * Convert any error to a HierarchyError
 * If already a HierarchyError, returns it as-is.
 * Otherwise wraps it in an INTERNAL_ERROR.
 */
export function toHierarchyError(error: unknown): HierarchyError {
  if (isHierarchyError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return internalError(error.message, { originalError: error.name });
  }

  return internalError(String(error));
}
