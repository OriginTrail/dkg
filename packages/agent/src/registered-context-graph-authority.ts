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

/**
 * Which chain view proves a registered Context Graph's current authority.
 *
 * `live-current` performs point reads against current chain state and is the
 * default for mutation, encryption rosters, subscription admission, and legacy
 * consumers. The two finalized modes consume the complete deployment-scoped
 * finalized authority snapshot instead, so a slow live RPC cannot stall a
 * read-only decision, and differ only in the lane: `finalized-index` (scoped
 * query authorization) reads through the shared authority circuit's
 * foreground lane, while `finalized-index-or-live` (read-only host/sync/share
 * gates and the encryption policy bit) bypasses the circuit, so the retained
 * projection answers even while the pool is exhausted.
 *
 * Finalized evidence fails closed: a malformed, inactive, or name-mismatched
 * snapshot never falls back. No evidence falls back to the bounded
 * current-state read: no finalized capability, a lane fault, deadline, or open
 * circuit, an absent snapshot, and a private roster the reader could not serve
 * fresh or that the caller must read live (`requireLiveRosterForPrivate`). A
 * public snapshot answers at any provenance.
 */
export type ContextGraphAuthorityReadMode =
  | 'live-current'
  | 'finalized-index'
  | 'finalized-index-or-live';
