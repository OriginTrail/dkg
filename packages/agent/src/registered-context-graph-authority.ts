// SPDX-License-Identifier: Apache-2.0

export type LiveOnChainAccessPolicyUnavailableReason =
  | 'chain-access-policy-timeout'
  | 'chain-access-policy-unknown';

export type LiveOnChainAccessPolicyUnavailable = {
  kind: 'unavailable';
  reason: LiveOnChainAccessPolicyUnavailableReason;
  detail?: string;
};

export type RegisteredContextGraphAuthorityUnavailableReason =
  | LiveOnChainAccessPolicyUnavailableReason
  | 'finalized-name-absence-unaccepted'
  | 'chain-name-binding-unavailable'
  // The shared RFC-64 authority circuit is cooling down. This is a deferral,
  // not a failed chain read: the pool was not contacted, and a caller may
  // retry on the circuit's own cadence.
  | 'authority-circuit-open'
  | 'local-chain-binding-unavailable'
  | 'local-existence-unavailable'
  | 'chain-access-policy-unavailable'
  | 'chain-participant-authority-unsupported'
  | 'chain-participant-authority-unavailable'
  | 'chain-participant-authority-invalid';

type RegisteredContextGraphAuthorityNonPolicyUnavailableReason = Exclude<
  RegisteredContextGraphAuthorityUnavailableReason,
  LiveOnChainAccessPolicyUnavailableReason
>;

export type RegisteredContextGraphAuthorityUnavailable =
  | (LiveOnChainAccessPolicyUnavailable & { onChainId: bigint })
  | {
      kind: 'unavailable';
      reason: RegisteredContextGraphAuthorityNonPolicyUnavailableReason;
      onChainId?: bigint;
      detail?: string;
    };

/** Stable public contract for registered Context Graph authority state. */
export type RegisteredContextGraphAuthority =
  | { kind: 'unregistered' }
  | { kind: 'public'; onChainId: bigint }
  | { kind: 'private'; onChainId: bigint; participantAgents: string[] }
  | RegisteredContextGraphAuthorityUnavailable;
