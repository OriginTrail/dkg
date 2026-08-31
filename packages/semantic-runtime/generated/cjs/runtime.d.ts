/* tslint:disable */
/* eslint-disable */

/**
 * Returns `(ABI_VERSION << 16) | SCHEMA_VERSION`.
 */
export function runtime_abi_version(): number;

/**
 * Re-decodes and re-analyzes canonical plan bytes inside the execution Wasm
 * boundary. A matching hash alone is deliberately insufficient.
 */
export function runtime_admit_plan(input: Uint8Array): Uint8Array;

/**
 * Applies one bounded event to an existing runtime handle.
 */
export function runtime_apply_event(handle: number, input: Uint8Array): Uint8Array;

/**
 * Drives the admitted plan inside Wasm until it completes or requests one
 * external operation. External results are explicit inputs on the next call.
 */
export function runtime_apply_plan(handle: number, input: Uint8Array): Uint8Array;

/**
 * Compiles bounded declarative source using the same Rust implementation
 * used by native tooling. Source is parsed as data and never evaluated.
 */
export function runtime_compile_strategy(input: Uint8Array): Uint8Array;

/**
 * Creates one empty runtime state and returns an encoded numeric handle.
 */
export function runtime_create(input: Uint8Array): Uint8Array;

/**
 * Drops one runtime handle. A second drop returns `false` rather than trapping.
 */
export function runtime_drop(handle: number, input: Uint8Array): Uint8Array;

/**
 * Drops one materialized plan handle. Repeated drops return `false`.
 */
export function runtime_drop_plan(handle: number, input: Uint8Array): Uint8Array;

/**
 * Returns redaction-safe state for an existing runtime handle.
 */
export function runtime_inspect(handle: number, input: Uint8Array): Uint8Array;

/**
 * Returns redaction-safe state for a materialized supervised plan.
 */
export function runtime_inspect_plan(handle: number, input: Uint8Array): Uint8Array;

/**
 * Reports current WebAssembly linear-memory bytes for observability.
 */
export function runtime_memory_bytes(): number;

/**
 * Phase 0 watchdog-only operation. The Worker refuses it unless explicitly
 * booted with test operations enabled.
 */
export function runtime_phase0_test_hang(): void;

/**
 * Phase 0 trap-only operation used by the Worker replacement test.
 */
export function runtime_phase0_test_trap(): void;

/**
 * Restores snapshot bytes into a new runtime handle.
 */
export function runtime_restore(input: Uint8Array): Uint8Array;

/**
 * Returns an encoded snapshot for an existing runtime handle.
 */
export function runtime_snapshot(handle: number, input: Uint8Array): Uint8Array;

/**
 * Re-admits and materializes a supervised plan into live logical processes.
 * The initial executor supports only ordered emits and one investigator call
 * per agent; every other expression or external operation fails closed.
 */
export function runtime_start_plan(input: Uint8Array): Uint8Array;

/**
 * Test-only native/Wasm conformance vector for the V1 supervised kernel.
 * The Worker refuses this operation unless explicitly booted in test mode.
 */
export function runtime_v1_conformance_vector(): Uint8Array;
