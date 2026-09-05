// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

import type { RegisteredContextGraphAuthority } from './dkg-agent-cg-resolve.js';

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

export type ContextGraphAuthorityUnavailableReason = {
  [Reason in ContextGraphAgentGateUnavailableReason]:
  typeof CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS[Reason]['retryable'] extends true
    ? Reason
    : never;
}[ContextGraphAgentGateUnavailableReason];

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE =
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE' as const;

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME =
  'ContextGraphAuthorityUnavailableError' as const;

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS = Object.freeze(
  (Object.keys(CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS) as ContextGraphAgentGateUnavailableReason[])
    .filter((reason): reason is ContextGraphAuthorityUnavailableReason => (
      CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS[reason].retryable
    )),
);

/** The narrow, serialization-safe disposition consumed across package boundaries. */
export interface ContextGraphAuthorityUnavailableMarker {
  readonly code: typeof CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
}

export class ContextGraphAuthorityUnavailableError extends Error {
  readonly code = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
  readonly reason: ContextGraphAuthorityUnavailableReason;
  readonly detail?: string;

  constructor(
    message: string,
    options: { reason: ContextGraphAuthorityUnavailableReason; detail?: string },
  ) {
    super(message);
    this.name = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME;
    this.reason = options.reason;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

/** Structural so retry disposition survives serialization and package copies. */
export function isContextGraphAuthorityUnavailableMarker(
  value: unknown,
): value is ContextGraphAuthorityUnavailableMarker {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  try {
    return Reflect.get(value, 'code') === CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
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
      retryable: boolean;
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

export function isRetryableContextGraphAuthorityReason(
  reason: ContextGraphAgentGateUnavailableReason,
): reason is ContextGraphAuthorityUnavailableReason {
  return CONTEXT_GRAPH_AUTHORITY_REASON_DISPOSITIONS[reason].retryable;
}

function unavailableAuthority(
  reason: ContextGraphAgentGateUnavailableReason,
  detail?: string,
): Extract<ContextGraphAgentGateAuthority, { kind: 'unavailable' }> {
  return {
    kind: 'unavailable',
    reason,
    ...(detail === undefined ? {} : { detail }),
    retryable: isRetryableContextGraphAuthorityReason(reason),
  };
}

/** Convert the canonical disposition to the public error/marker contract once. */
export function createContextGraphAuthorityError(
  message: string,
  failure: { reason: ContextGraphAgentGateUnavailableReason; detail?: string },
): Error {
  if (!isRetryableContextGraphAuthorityReason(failure.reason)) return new Error(message);
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
