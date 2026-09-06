// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

import type { RegisteredContextGraphAuthority } from '../../dkg-agent-cg-resolve.js';

type RegisteredAuthorityUnavailableReason = Extract<
  RegisteredContextGraphAuthority,
  { kind: 'unavailable' }
>['reason'];

const CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS = {
  'chain-name-binding-unavailable': { retryable: true },
  'local-chain-binding-unavailable': { retryable: true },
  'local-existence-unavailable': { retryable: true },
  'chain-access-policy-unavailable': { retryable: true },
  'chain-access-policy-timeout': { retryable: true },
  'chain-access-policy-unknown': { retryable: false },
  'chain-participant-authority-unsupported': { retryable: false },
  'chain-participant-authority-unavailable': { retryable: true },
  'chain-participant-authority-invalid': { retryable: false },
  'rfc64-private-read-roster-unavailable': { retryable: true },
} as const satisfies Record<
  RegisteredAuthorityUnavailableReason | 'rfc64-private-read-roster-unavailable',
  { retryable: boolean }
>;

export type ContextGraphAgentGateUnavailableReason =
  keyof typeof CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS;

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE =
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE' as const;

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME =
  'ContextGraphAuthorityUnavailableError' as const;

/** Serialization-safe domain failure with reason-derived retryability. */
export type ContextGraphAuthorityUnavailableMarker = {
  [Reason in ContextGraphAgentGateUnavailableReason]: {
    readonly code: typeof CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
    readonly reason: Reason;
    readonly retryable:
      typeof CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS[Reason]['retryable'];
    readonly detail?: string;
  }
}[ContextGraphAgentGateUnavailableReason];

export class ContextGraphAuthorityUnavailableError<
  Reason extends ContextGraphAgentGateUnavailableReason = ContextGraphAgentGateUnavailableReason,
> extends Error {
  readonly code = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
  readonly reason: Reason;
  readonly retryable:
    typeof CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS[Reason]['retryable'];
  readonly detail?: string;

  constructor(
    message: string,
    options: { reason: Reason; detail?: string },
  ) {
    super(message);
    this.name = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME;
    this.reason = options.reason;
    this.retryable = CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS[options.reason].retryable;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

/** Structural and table-validated so disposition survives package copies safely. */
export function isContextGraphAuthorityUnavailableMarker(
  value: unknown,
): value is ContextGraphAuthorityUnavailableMarker {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  try {
    if (Reflect.get(value, 'code') !== CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE) return false;
    const reason = Reflect.get(value, 'reason');
    if (
      typeof reason !== 'string'
      || !Object.hasOwn(CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS, reason)
    ) {
      return false;
    }
    return Reflect.get(value, 'retryable')
      === CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS[
        reason as ContextGraphAgentGateUnavailableReason
      ].retryable;
  } catch {
    return false;
  }
}

export type ContextGraphAgentGateAuthority =
  | { kind: 'ungated' }
  | { kind: 'available'; agentAddresses: string[] }
  | {
      kind: 'unavailable';
      reason: ContextGraphAgentGateUnavailableReason;
      detail?: string;
    };

export interface ContextGraphAgentGateAuthorityInput {
  contextGraphId: string;
  getRegisteredAuthority(): Promise<RegisteredContextGraphAuthority>;
  resolveRfc64PrivateRoster(): readonly string[] | null | undefined;
  getLegacyMeta(): Promise<{
    allowedAgents: readonly string[];
    participantAgents: readonly string[];
    revokedAgents: readonly string[];
  }>;
  getSubscriptionAgents(): readonly string[];
}

function unavailableAuthority(
  reason: ContextGraphAgentGateUnavailableReason,
  detail?: string,
): Extract<ContextGraphAgentGateAuthority, { kind: 'unavailable' }> {
  return {
    kind: 'unavailable',
    reason,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Convert the canonical disposition to the public error/marker contract once. */
export function createContextGraphAuthorityError<
  Reason extends ContextGraphAgentGateUnavailableReason,
>(
  message: string,
  failure: { reason: Reason; detail?: string },
): ContextGraphAuthorityUnavailableError<Reason> {
  return new ContextGraphAuthorityUnavailableError(message, {
    reason: failure.reason,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  });
}

/**
 * Canonical signing/encryption gate precedence: registered chain, accepted
 * RFC-64 private roster, then the legacy local projection.
 */
export async function resolveContextGraphAgentGateAuthorityDecision(
  input: ContextGraphAgentGateAuthorityInput,
): Promise<ContextGraphAgentGateAuthority> {
  const registeredAuthority = await input.getRegisteredAuthority();
  if (registeredAuthority.kind === 'private') {
    return { kind: 'available', agentAddresses: registeredAuthority.participantAgents };
  }
  if (registeredAuthority.kind === 'unavailable') {
    return unavailableAuthority(registeredAuthority.reason, registeredAuthority.detail);
  }

  const rfc64Roster = registeredAuthority.kind === 'unregistered'
    ? input.resolveRfc64PrivateRoster()
    : undefined;
  if (rfc64Roster !== undefined) {
    if (rfc64Roster === null) {
      return unavailableAuthority('rfc64-private-read-roster-unavailable');
    }
    const seen = new Set<string>();
    const accepted: string[] = [];
    for (const value of rfc64Roster) {
      if (!ethers.isAddress(value)) continue;
      const checksum = ethers.getAddress(value);
      const key = checksum.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      accepted.push(checksum);
    }
    return { kind: 'available', agentAddresses: accepted };
  }

  const meta = await input.getLegacyMeta();
  const seen = new Set<string>();
  const agents: string[] = [];
  let sawAgentGate = false;
  const revoked = new Set(meta.revokedAgents.map((address) => address.toLowerCase()));
  const add = (value: string | undefined) => {
    if (!value || !ethers.isAddress(value)) return;
    const checksum = ethers.getAddress(value);
    const key = checksum.toLowerCase();
    if (revoked.has(key) || seen.has(key)) return;
    seen.add(key);
    agents.push(checksum);
  };

  const subscriptionAgents = input.getSubscriptionAgents();
  if (subscriptionAgents.length > 0) sawAgentGate = true;
  for (const agentAddress of subscriptionAgents) add(agentAddress);

  if (meta.allowedAgents.length > 0 || meta.participantAgents.length > 0) sawAgentGate = true;
  for (const agentAddress of meta.allowedAgents) add(agentAddress);
  for (const agentAddress of meta.participantAgents) add(agentAddress);

  return sawAgentGate
    ? { kind: 'available', agentAddresses: agents }
    : { kind: 'ungated' };
}
