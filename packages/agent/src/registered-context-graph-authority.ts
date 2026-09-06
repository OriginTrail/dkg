// SPDX-License-Identifier: Apache-2.0

type LiveOnChainAccessPolicyUnavailable = {
  kind: 'unavailable';
  reason: 'chain-access-policy-timeout' | 'chain-access-policy-unknown';
  detail?: string;
};

/** Stable public contract for registered Context Graph authority state. */
export type RegisteredContextGraphAuthority =
  | { kind: 'unregistered' }
  | { kind: 'public'; onChainId: bigint }
  | { kind: 'private'; onChainId: bigint; participantAgents: string[] }
  | (LiveOnChainAccessPolicyUnavailable & { onChainId: bigint })
  | {
      kind: 'unavailable';
      reason:
        | 'chain-name-binding-unavailable'
        | 'local-chain-binding-unavailable'
        | 'local-existence-unavailable'
        | 'chain-access-policy-unavailable'
        | 'chain-participant-authority-unsupported'
        | 'chain-participant-authority-unavailable'
        | 'chain-participant-authority-invalid';
      onChainId?: bigint;
      detail?: string;
    };
