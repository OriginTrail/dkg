/**
 * Canonical trusted-local transport profile for current-finalized EVM reads.
 *
 * These limits belong to the generic finalized-read boundary. EIP-1271 is one
 * specialization of this profile; changing signature-verification policy must
 * not implicitly redefine unrelated finalized reads.
 */
export const CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1 =
  '0x0000000000000000000000000000000000000000' as const;
export const CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1 = 1_000_000n;
export const CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1 = 64 * 1024;
export const CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1 = 4_000;
export const CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1 = 2;
export const CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1 = 10_000;
export const CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1 = 4;
export const CURRENT_FINALIZED_EVM_READ_ENDPOINT_ATTEMPT_POLICY_V1 =
  'distinct-configured-endpoints-no-same-endpoint-retry' as const;
export const CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1 = 4;
// Absolute transport ceiling. Domain readers own tighter ABI-specific caps.
export const CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1 = 16 * 1024;

export const CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1 = Object.freeze([
  'unsupported-chain',
  'chain-mismatch',
  'finalized-state-unavailable',
  'rpc-unavailable',
  'rpc-timeout',
  'concurrency-saturated',
  'resource-limit',
  'revert',
  'no-code',
  'malformed-return',
] as const);

export type CurrentFinalizedEvmCallErrorCodeV1 =
  (typeof CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1)[number];

/** Closed failure vocabulary implemented by the finalized-state RPC gateway. */
export class CurrentFinalizedEvmCallErrorV1 extends Error {
  readonly code: CurrentFinalizedEvmCallErrorCodeV1;

  constructor(
    code: CurrentFinalizedEvmCallErrorCodeV1,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    if (!CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1.includes(code)) {
      throw new TypeError(`Unsupported current-finalized EVM call error code: ${String(code)}`);
    }
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CurrentFinalizedEvmCallErrorV1';
    this.code = code;
    // Package-internal typed failures finish their own fields before freezing.
    if (new.target === CurrentFinalizedEvmCallErrorV1) Object.freeze(this);
  }
}
