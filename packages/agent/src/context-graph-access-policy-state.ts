// SPDX-License-Identifier: Apache-2.0

export type LiveOnChainAccessPolicyUnavailableReason =
  | 'invalid-on-chain-id'
  | 'chain-liveness-unsupported'
  | 'chain-context-graph-inactive'
  | 'chain-liveness-read-timeout'
  | 'chain-access-policy-unsupported'
  | 'chain-access-policy-read-timeout'
  | 'chain-access-policy-invalid';

/**
 * Internal policy-read result that preserves why a fail-closed read was
 * unavailable. Compatibility callers may still project this to `null`.
 */
export type LiveOnChainAccessPolicyState =
  | { kind: 'available'; accessPolicy: 0 | 1 }
  | {
      kind: 'unavailable';
      reason: LiveOnChainAccessPolicyUnavailableReason;
      detail?: string;
    };
