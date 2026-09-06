// SPDX-License-Identifier: Apache-2.0

/** Fail-closed outcomes from the live on-chain access-policy read. */
export const LIVE_ON_CHAIN_ACCESS_POLICY_UNAVAILABLE_REASONS = Object.freeze([
  'chain-access-policy-timeout',
  'chain-access-policy-unknown',
] as const);

export type LiveOnChainAccessPolicyUnavailableReason =
  (typeof LIVE_ON_CHAIN_ACCESS_POLICY_UNAVAILABLE_REASONS)[number];

export type LiveOnChainAccessPolicyUnavailable = {
  kind: 'unavailable';
  reason: LiveOnChainAccessPolicyUnavailableReason;
  detail?: string;
};

export type LiveOnChainAccessPolicyState =
  | { kind: 'available'; accessPolicy: 0 | 1 }
  | LiveOnChainAccessPolicyUnavailable;

/** Every unavailable outcome emitted by registered Context Graph authority. */
export const REGISTERED_CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS = Object.freeze([
  'chain-name-binding-unavailable',
  'local-chain-binding-unavailable',
  'local-existence-unavailable',
  'chain-access-policy-unavailable',
  ...LIVE_ON_CHAIN_ACCESS_POLICY_UNAVAILABLE_REASONS,
  'chain-participant-authority-unsupported',
  'chain-participant-authority-unavailable',
  'chain-participant-authority-invalid',
] as const);

export type RegisteredContextGraphAuthorityUnavailableReason =
  (typeof REGISTERED_CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS)[number];

/** Stable public contract for registered Context Graph authority state. */
export type RegisteredContextGraphAuthority =
  | { kind: 'unregistered' }
  | { kind: 'public'; onChainId: bigint }
  | { kind: 'private'; onChainId: bigint; participantAgents: string[] }
  | (LiveOnChainAccessPolicyUnavailable & { onChainId: bigint })
  | {
      kind: 'unavailable';
      reason: Exclude<
        RegisteredContextGraphAuthorityUnavailableReason,
        LiveOnChainAccessPolicyUnavailableReason
      >;
      onChainId?: bigint;
      detail?: string;
    };
