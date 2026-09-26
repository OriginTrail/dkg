// SPDX-License-Identifier: Apache-2.0

/**
 * Typed context-graph read-authority resolution.
 *
 * This module owns precedence between the registered-chain authority, RFC-64
 * activation policy, and legacy local metadata. Callers that only need a
 * boolean can adapt `outcome === 'allowed'`; recovery and diagnostics retain
 * the distinction between an authoritative denial and unavailable authority.
 */

import { isChainRpcTransportError } from '@origintrail-official/dkg-chain';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import type {
  RegisteredContextGraphAuthority,
  RegisteredContextGraphAuthorityUnavailableReason,
} from './registered-context-graph-authority.js';

export type ContextGraphReadAuthorityOutcome = 'allowed' | 'denied' | 'unavailable';

export type ContextGraphReadAuthoritySource =
  | 'system'
  | 'registered-chain'
  | 'rfc64-private'
  | 'rfc64-public'
  | 'legacy-local';

/**
 * What could not answer when authority is `unavailable`, for server-side
 * diagnostics only (#2834): `store` is the local triple store or the metadata
 * in it, `chain` is chain RPC or the finalized chain index, `local-state` is
 * in-process registration or bootstrap state, and `unknown` is a failure whose
 * error says neither.
 */
export type ContextGraphReadAuthorityDependency = 'store' | 'chain' | 'local-state' | 'unknown';

export interface ContextGraphReadAuthorityDecision {
  outcome: ContextGraphReadAuthorityOutcome;
  source: ContextGraphReadAuthoritySource;
  reason: string;
  metadataBootstrap: 'eligible' | 'forbidden';
  onChainId?: bigint;
  /** Set when `outcome` is `unavailable`. */
  dependency?: ContextGraphReadAuthorityDependency;
}

export const CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE =
  'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE' as const;

/**
 * Scoped queries must preserve the distinction between an authoritative deny
 * and an authority source that could not answer. The daemon recognizes the
 * stable code structurally so this internal error does not become part of the
 * public agent package surface.
 */
export class ContextGraphReadAuthorityUnavailableError extends Error {
  readonly code = CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE;
  readonly retryable = true;
  readonly contextGraphId: string;
  readonly source: ContextGraphReadAuthoritySource;
  readonly reason: string;
  readonly dependency: ContextGraphReadAuthorityDependency;

  constructor(
    contextGraphId: string,
    decision: Pick<ContextGraphReadAuthorityDecision, 'source' | 'reason' | 'dependency'>,
  ) {
    const dependency = decision.dependency ?? 'unknown';
    super(
      `Context Graph read authority is unavailable for "${contextGraphId}" `
      + `(${decision.source}/${decision.reason}/${dependency})`,
    );
    this.name = 'ContextGraphReadAuthorityUnavailableError';
    this.contextGraphId = contextGraphId;
    this.source = decision.source;
    this.reason = decision.reason;
    this.dependency = dependency;
  }
}

/** The dependency behind each typed registered-authority failure. */
const REGISTERED_AUTHORITY_UNAVAILABLE_DEPENDENCY: Readonly<
  Record<RegisteredContextGraphAuthorityUnavailableReason, ContextGraphReadAuthorityDependency>
> = {
  'chain-access-policy-timeout': 'chain',
  'chain-access-policy-unknown': 'chain',
  'chain-access-policy-unavailable': 'chain',
  'chain-name-binding-unavailable': 'chain',
  'chain-participant-authority-unsupported': 'chain',
  'chain-participant-authority-unavailable': 'chain',
  'chain-participant-authority-invalid': 'chain',
  'finalized-name-absence-unaccepted': 'chain',
  'authority-circuit-open': 'chain',
  'local-existence-unavailable': 'store',
  'local-chain-binding-unavailable': 'local-state',
};

/**
 * The dependency a caught authority-source error belongs to, read from the
 * stable codes of it and its `cause` chain: store deadlines, recovery and
 * admission shedding, or chain RPC transport failures.
 */
export function contextGraphReadAuthorityDependencyOf(error: unknown): ContextGraphReadAuthorityDependency {
  try {
    let current = error;
    for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
      if (isStoreOperationTimeoutError(current) || isStoreSchedulerBusyError(current)) return 'store';
      if (isChainRpcTransportError(current)) return 'chain';
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // A hostile error shape says nothing about its dependency.
  }
  return 'unknown';
}

export interface ContextGraphReadAuthorityInput {
  contextGraphId: string;
  callerAgentAddress?: string;
  allowSubscriptionFallback: boolean;
  isSystemContextGraph: boolean;
  getPeerId(): string;
  getAllowedPeers(): Promise<string[] | null>;
  getRegisteredAuthority(): Promise<RegisteredContextGraphAuthority>;
  isAgentAllowed(agentAddress: string | undefined, roster: readonly string[]): boolean;
  hasLocalAgentInRoster(roster: readonly string[]): boolean;
  resolveRfc64PrivateRoster(): readonly string[] | null | undefined;
  rfc64LocalAgentAddress?: string;
  defaultAgentAddress?: string;
  hasAcceptedRfc64PublicPolicy: boolean;
  isPendingMetadata: boolean;
  isPrivateLocalGraph(): Promise<boolean>;
  getLocalAgentGate(): Promise<string[] | null>;
  getLegacyParticipants(): Promise<string[] | null>;
  hasLegacySubscription: boolean;
  getLocalIdentityId(): Promise<bigint>;
}

const decision = (
  outcome: ContextGraphReadAuthorityOutcome,
  source: ContextGraphReadAuthoritySource,
  reason: string,
  onChainId?: bigint,
  metadataBootstrap: 'eligible' | 'forbidden' = outcome === 'denied' ? 'forbidden' : 'eligible',
): ContextGraphReadAuthorityDecision => ({
  outcome,
  source,
  reason,
  metadataBootstrap,
  ...(onChainId === undefined ? {} : { onChainId }),
});

const unavailable = (
  source: ContextGraphReadAuthoritySource,
  reason: string,
  dependency: ContextGraphReadAuthorityDependency,
  onChainId?: bigint,
): ContextGraphReadAuthorityDecision => ({ ...decision('unavailable', source, reason, onChainId), dependency });

export async function resolveContextGraphReadAuthorityDecision(
  input: ContextGraphReadAuthorityInput,
): Promise<ContextGraphReadAuthorityDecision> {
  if (input.isSystemContextGraph) {
    return decision('allowed', 'system', 'system-context-graph');
  }

  let registeredAuthority: RegisteredContextGraphAuthority;
  try {
    registeredAuthority = await input.getRegisteredAuthority();
  } catch (error) {
    return unavailable(
      'registered-chain',
      'registered-authority-error',
      contextGraphReadAuthorityDependencyOf(error),
    );
  }
  if (registeredAuthority.kind === 'unavailable') {
    return unavailable(
      'registered-chain',
      registeredAuthority.reason,
      REGISTERED_AUTHORITY_UNAVAILABLE_DEPENDENCY[registeredAuthority.reason] ?? 'unknown',
      registeredAuthority.onChainId,
    );
  }
  if (registeredAuthority.kind === 'public') {
    return decision('allowed', 'registered-chain', 'chain-public', registeredAuthority.onChainId);
  }
  if (registeredAuthority.kind === 'private') {
    const onChainAgents = registeredAuthority.participantAgents;
    const agentAllowed = input.callerAgentAddress
      ? input.isAgentAllowed(input.callerAgentAddress, onChainAgents)
      : input.hasLocalAgentInRoster(onChainAgents);
    if (!agentAllowed) {
      return decision('denied', 'registered-chain', 'agent-not-in-chain-roster', registeredAuthority.onChainId);
    }
    let allowedPeers: string[] | null;
    try {
      allowedPeers = await input.getAllowedPeers();
    } catch (error) {
      return unavailable(
        'registered-chain',
        'peer-authority-unavailable',
        contextGraphReadAuthorityDependencyOf(error),
        registeredAuthority.onChainId,
      );
    }
    if (allowedPeers !== null && !allowedPeers.includes(input.getPeerId())) {
      return decision('denied', 'registered-chain', 'local-peer-not-allowed', registeredAuthority.onChainId);
    }
    return decision('allowed', 'registered-chain', 'chain-participant', registeredAuthority.onChainId);
  }

  const rfc64Roster = input.resolveRfc64PrivateRoster();
  if (rfc64Roster !== undefined) {
    if (rfc64Roster === null) {
      return decision('denied', 'rfc64-private', 'invalid-private-policy-roster');
    }
    const effectiveCaller = input.callerAgentAddress
      ?? input.rfc64LocalAgentAddress
      ?? input.defaultAgentAddress;
    return input.isAgentAllowed(effectiveCaller, rfc64Roster)
      ? decision('allowed', 'rfc64-private', 'rfc64-participant')
      : decision('denied', 'rfc64-private', 'agent-not-in-rfc64-roster');
  }
  if (input.hasAcceptedRfc64PublicPolicy) {
    return decision('allowed', 'rfc64-public', 'accepted-public-policy');
  }

  // A durable join approval may restore a minimal subscription row before its
  // authenticated private definition arrives. Absence of that metadata is not
  // proof the graph is public, so the legacy local-public fallback must remain
  // closed during this bootstrap window.
  if (input.isPendingMetadata) {
    return unavailable('legacy-local', 'pending-authoritative-metadata', 'local-state');
  }

  let isPrivate: boolean;
  try {
    isPrivate = await input.isPrivateLocalGraph();
  } catch (error) {
    return unavailable('legacy-local', 'local-access-policy-unavailable', contextGraphReadAuthorityDependencyOf(error));
  }
  if (!isPrivate) return decision('allowed', 'legacy-local', 'local-public');

  let allowedPeers: string[] | null;
  try {
    allowedPeers = await input.getAllowedPeers();
  } catch (error) {
    return unavailable('legacy-local', 'peer-authority-unavailable', contextGraphReadAuthorityDependencyOf(error));
  }

  let agentGateAddresses: string[] | null;
  try {
    agentGateAddresses = await input.getLocalAgentGate();
  } catch (error) {
    return unavailable('legacy-local', 'local-agent-authority-unavailable', contextGraphReadAuthorityDependencyOf(error));
  }
  const agentGateAllowed = agentGateAddresses === null
    ? false
    : input.callerAgentAddress
      ? input.isAgentAllowed(input.callerAgentAddress, agentGateAddresses)
      : input.hasLocalAgentInRoster(agentGateAddresses);

  if (agentGateAddresses !== null && allowedPeers !== null) {
    return allowedPeers.includes(input.getPeerId()) && agentGateAllowed
      ? decision('allowed', 'legacy-local', 'local-agent-and-peer-allowlist')
      : decision('denied', 'legacy-local', 'local-agent-or-peer-not-allowed');
  }
  if (agentGateAddresses !== null) {
    return agentGateAllowed
      ? decision('allowed', 'legacy-local', 'local-agent-allowlist')
      : decision('denied', 'legacy-local', 'local-agent-not-allowed');
  }

  let participants: string[] | null;
  try {
    participants = await input.getLegacyParticipants();
  } catch (error) {
    return unavailable(
      'legacy-local',
      'legacy-participant-authority-unavailable',
      contextGraphReadAuthorityDependencyOf(error),
    );
  }
  if ((!participants || participants.length === 0) && allowedPeers !== null) {
    return allowedPeers.includes(input.getPeerId())
      ? decision('allowed', 'legacy-local', 'legacy-peer-allowlist')
      : decision('denied', 'legacy-local', 'legacy-peer-not-allowed');
  }
  if (!participants || participants.length === 0) {
    return input.allowSubscriptionFallback && input.hasLegacySubscription
      ? decision('allowed', 'legacy-local', 'legacy-subscription')
      : decision('denied', 'legacy-local', 'no-read-authority', undefined, 'eligible');
  }
  if (
    input.callerAgentAddress
    && participants.some((participant) => (
      participant.toLowerCase() === input.callerAgentAddress!.toLowerCase()
    ))
  ) {
    return decision('allowed', 'legacy-local', 'legacy-caller-participant');
  }
  if (
    input.defaultAgentAddress
    && participants.some((participant) => (
      participant.toLowerCase() === input.defaultAgentAddress!.toLowerCase()
    ))
  ) {
    return decision('allowed', 'legacy-local', 'legacy-local-agent-participant');
  }

  let localIdentityId = 0n;
  try {
    localIdentityId = await input.getLocalIdentityId();
  } catch {
    // Preserve the legacy decision: identity lookup failure does not turn a
    // positive participant or peer fact into a denial, but supplies no allow.
  }
  if (localIdentityId > 0n && participants.includes(String(localIdentityId))) {
    return decision('allowed', 'legacy-local', 'legacy-local-identity-participant');
  }
  if (allowedPeers?.includes(input.getPeerId())) {
    return decision('allowed', 'legacy-local', 'legacy-peer-invitation');
  }
  if (
    localIdentityId === 0n
    && input.allowSubscriptionFallback
    && input.hasLegacySubscription
  ) {
    return decision('allowed', 'legacy-local', 'legacy-edge-subscription');
  }
  return decision('denied', 'legacy-local', 'legacy-participant-not-allowed');
}
