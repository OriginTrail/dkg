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
  | 'chain-name-binding-unavailable'
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
