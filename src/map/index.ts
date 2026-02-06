/**
 * MAP (Multi-Agent Protocol) Integration Module
 *
 * This module provides MAP protocol support for macro-agent, enabling:
 * - External client connections via MAP protocol
 * - Federation with other MAP-compliant systems
 * - Standardized multi-agent communication
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

// Core types
export * from "./types.js";

// Adapter types
export * from "./adapter/index.js";

// Federation types and handler
export * from "./federation/index.js";
