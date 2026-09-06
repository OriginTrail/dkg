// SPDX-License-Identifier: Apache-2.0

/** Fail-closed outcomes from the live on-chain access-policy read. */
export type LiveOnChainAccessPolicyUnavailableReason =
  | 'chain-access-policy-timeout'
  | 'chain-access-policy-unknown';

export type LiveOnChainAccessPolicyUnavailable = {
  kind: 'unavailable';
  reason: LiveOnChainAccessPolicyUnavailableReason;
  detail?: string;
};

export type LiveOnChainAccessPolicyState =
  | { kind: 'available'; accessPolicy: 0 | 1 }
  | LiveOnChainAccessPolicyUnavailable;

/** Every unavailable outcome emitted by registered Context Graph authority. */
export type RegisteredContextGraphAuthorityUnavailableReason =
  | 'chain-name-binding-unavailable'
  | 'local-chain-binding-unavailable'
  | 'local-existence-unavailable'
  | 'chain-access-policy-unavailable'
  | LiveOnChainAccessPolicyUnavailableReason
  | 'chain-participant-authority-unsupported'
  | 'chain-participant-authority-unavailable'
  | 'chain-participant-authority-invalid';

/** Canonical registered Context Graph authority state. */
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

export type ContextGraphAgentGateUnavailableReason =
  | RegisteredContextGraphAuthorityUnavailableReason
  | 'rfc64-private-read-roster-unavailable';

export type ContextGraphAgentGateAuthority =
  | { kind: 'ungated' }
  | { kind: 'available'; agentAddresses: string[] }
  | {
      kind: 'unavailable';
      reason: ContextGraphAgentGateUnavailableReason;
      detail?: string;
    };

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE =
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE' as const;

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME =
  'ContextGraphAuthorityUnavailableError' as const;

const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS = new Set<
  ContextGraphAgentGateUnavailableReason
>([
  'chain-name-binding-unavailable',
  'local-chain-binding-unavailable',
  'local-existence-unavailable',
  'chain-access-policy-unavailable',
  'chain-access-policy-timeout',
  'chain-access-policy-unknown',
  'chain-participant-authority-unsupported',
  'chain-participant-authority-unavailable',
  'chain-participant-authority-invalid',
  'rfc64-private-read-roster-unavailable',
]);

/** Serialization-safe authority failure without caller-specific retry policy. */
export type ContextGraphAuthorityUnavailableMarker = {
  readonly code: typeof CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
  readonly reason: ContextGraphAgentGateUnavailableReason;
  readonly detail?: string;
};

export class ContextGraphAuthorityUnavailableError extends Error {
  readonly code = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
  readonly reason: ContextGraphAgentGateUnavailableReason;
  readonly detail?: string;

  constructor(
    message: string,
    options: { reason: ContextGraphAgentGateUnavailableReason; detail?: string },
  ) {
    super(message);
    this.name = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME;
    this.reason = options.reason;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

export function isContextGraphAuthorityUnavailableMarker(
  value: unknown,
): value is ContextGraphAuthorityUnavailableMarker {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  try {
    if (Reflect.get(value, 'code') !== CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE) return false;
    const reason = Reflect.get(value, 'reason');
    return typeof reason === 'string'
      && CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS.has(
        reason as ContextGraphAgentGateUnavailableReason,
      );
  } catch {
    return false;
  }
}

export function createContextGraphAuthorityError(
  message: string,
  failure: { reason: ContextGraphAgentGateUnavailableReason; detail?: string },
): ContextGraphAuthorityUnavailableError {
  return new ContextGraphAuthorityUnavailableError(message, {
    reason: failure.reason,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  });
}
