// SPDX-License-Identifier: Apache-2.0

/**
 * Typed context-graph read-authority resolution.
 *
 * This module owns precedence between the registered-chain authority, RFC-64
 * activation policy, and legacy local metadata. Callers that only need a
 * boolean can adapt `outcome === 'allowed'`; recovery and diagnostics retain
 * the distinction between an authoritative denial and unavailable authority.
 */

import { CONTEXT_GRAPH_AUTHORITY_RPC_SITES, withRpcUsageSite } from '@origintrail-official/dkg-chain';
import {
  contextGraphReadAuthorityDependencyOf,
  registeredContextGraphAuthorityUnavailableDependency,
  type ContextGraphReadAuthorityDependency,
} from './context-graph-authority-dependency.js';
import type {
  ContextGraphFinalizedAbsenceDetailCode,
  RegisteredContextGraphAuthority,
} from './registered-context-graph-authority.js';

export {
  contextGraphReadAuthorityDependencyOf,
  type ContextGraphReadAuthorityDependency,
} from './context-graph-authority-dependency.js';

export type ContextGraphReadAuthorityOutcome = 'allowed' | 'denied' | 'unavailable';

export type ContextGraphReadAuthoritySource =
  | 'system'
  | 'registered-chain'
  | 'rfc64-private'
  | 'rfc64-public'
  | 'legacy-local';

interface ContextGraphReadAuthorityDecisionFields {
  source: ContextGraphReadAuthoritySource;
  reason: string;
  metadataBootstrap: 'eligible' | 'forbidden';
  onChainId?: bigint;
  /**
   * Subscription bootstrap's canonical read established source-qualified VM
   * non-applicability AND allowed the caller. A legacy 'unregistered' read
   * fallback or a missing id cannot establish it. Transient, never persisted.
   */
  registration?: 'unregistered';
}

/** An authoritative answer: the read is allowed or denied. */
export interface SettledContextGraphReadAuthorityDecision extends ContextGraphReadAuthorityDecisionFields {
  outcome: 'allowed' | 'denied';
}

/** No authority source could answer; `dependency` says which one could not. */
export interface UnavailableContextGraphReadAuthorityDecision extends ContextGraphReadAuthorityDecisionFields {
  outcome: 'unavailable';
  dependency: ContextGraphReadAuthorityDependency;
  /** The registered authority's classified detail, where it names one; for diagnostics only. */
  detailCode?: ContextGraphFinalizedAbsenceDetailCode;
}

export type ContextGraphReadAuthorityDecision =
  | SettledContextGraphReadAuthorityDecision
  | UnavailableContextGraphReadAuthorityDecision;

interface ScopedContextGraphQueryReadAuthorityInput {
  contextGraphId: string;
  view?: string;
  callerAgentAddress?: string;
  targetsSharedMemory: boolean;
  signal?: AbortSignal;
  resolveAuthority(contextGraphId: string, options: {
    callerAgentAddress?: string;
    allowSubscriptionFallback?: boolean;
    signal?: AbortSignal;
    authorityReadMode: 'finalized-index';
  }): Promise<ContextGraphReadAuthorityDecision>;
  isLocalFirstUnregistered(contextGraphId: string): Promise<boolean>;
  readCurrentBinding(contextGraphId: string): { onChainId?: string; pendingMeta?: boolean } | undefined;
}

/** A local draft read does not grant general graph or shared-memory admission. */
export async function resolveScopedContextGraphQueryReadAuthority(
  input: ScopedContextGraphQueryReadAuthorityInput,
): Promise<ContextGraphReadAuthorityDecision> {
  const authority = await withRpcUsageSite(CONTEXT_GRAPH_AUTHORITY_RPC_SITES.query, () => (
    input.resolveAuthority(input.contextGraphId, {
      callerAgentAddress: input.callerAgentAddress,
      allowSubscriptionFallback: input.targetsSharedMemory ? false : undefined,
      signal: input.signal,
      authorityReadMode: 'finalized-index',
    })
  ));
  if (
    input.view === 'working-memory'
    && authority.outcome === 'denied'
    && authority.source === 'legacy-local'
    && authority.reason === 'no-read-authority'
    && await input.isLocalFirstUnregistered(input.contextGraphId)
    && input.readCurrentBinding(input.contextGraphId)?.onChainId === undefined
    && input.readCurrentBinding(input.contextGraphId)?.pendingMeta !== true
  ) {
    return { ...authority, outcome: 'allowed', reason: 'local-first-working-memory-owner' };
  }
  return authority;
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
  readonly detailCode?: ContextGraphFinalizedAbsenceDetailCode;

  constructor(
    contextGraphId: string,
    decision: Pick<UnavailableContextGraphReadAuthorityDecision, 'source' | 'reason' | 'dependency' | 'detailCode'>,
  ) {
    super(
      `Context Graph read authority is unavailable for "${contextGraphId}" `
      + `(${decision.source}/${decision.reason}/${decision.dependency})`,
    );
    this.name = 'ContextGraphReadAuthorityUnavailableError';
    this.contextGraphId = contextGraphId;
    this.source = decision.source;
    this.reason = decision.reason;
    this.dependency = decision.dependency;
    if (decision.detailCode !== undefined) this.detailCode = decision.detailCode;
  }
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
  outcome: SettledContextGraphReadAuthorityDecision['outcome'],
  source: ContextGraphReadAuthoritySource,
  reason: string,
  onChainId?: bigint,
  metadataBootstrap: 'eligible' | 'forbidden' = outcome === 'denied' ? 'forbidden' : 'eligible',
): SettledContextGraphReadAuthorityDecision => ({
  outcome,
  source,
  reason,
  metadataBootstrap,
  ...(onChainId === undefined ? {} : { onChainId }),
});

/** The one way to build an unavailable decision, so every one names its dependency. */
export function unavailableContextGraphReadAuthorityDecision(
  source: ContextGraphReadAuthoritySource,
  reason: string,
  dependency: ContextGraphReadAuthorityDependency,
  onChainId?: bigint,
  detailCode?: ContextGraphFinalizedAbsenceDetailCode,
): UnavailableContextGraphReadAuthorityDecision {
  return {
    outcome: 'unavailable',
    source,
    reason,
    metadataBootstrap: 'eligible',
    ...(onChainId === undefined ? {} : { onChainId }),
    dependency,
    ...(detailCode === undefined ? {} : { detailCode }),
  };
}

const unavailable = unavailableContextGraphReadAuthorityDecision;

export async function resolveContextGraphReadAuthorityDecision(
  input: ContextGraphReadAuthorityInput,
): Promise<ContextGraphReadAuthorityDecision> {
  return (await resolveContextGraphReadAuthorityResolution(input)).decision;
}

/** Internal combined result; ordinary scoped-read decisions keep their shape. */
export interface ContextGraphReadAuthorityResolution {
  decision: ContextGraphReadAuthorityDecision;
  registration?: 'unregistered';
}

/** Authorize and derive applicability from one canonical registration read. */
export async function resolveContextGraphReadAuthorityResolution(
  input: ContextGraphReadAuthorityInput,
): Promise<ContextGraphReadAuthorityResolution> {
  if (input.isSystemContextGraph) {
    return { decision: decision('allowed', 'system', 'system-context-graph') };
  }

  let registeredAuthority: RegisteredContextGraphAuthority;
  try {
    registeredAuthority = await input.getRegisteredAuthority();
  } catch (error) {
    return {
      decision: unavailable(
        'registered-chain',
        'registered-authority-error',
        contextGraphReadAuthorityDependencyOf(error),
      ),
    };
  }
  const authority = await resolveReadAuthorityFromRegistration(input, registeredAuthority);
  return {
    decision: authority,
    ...(authority.outcome === 'allowed'
      && registeredAuthority.kind === 'unregistered'
      && registeredAuthority.unregisteredEvidence !== undefined
      ? { registration: 'unregistered' as const }
      : {}),
  };
}

async function resolveReadAuthorityFromRegistration(
  input: ContextGraphReadAuthorityInput,
  registeredAuthority: RegisteredContextGraphAuthority,
): Promise<ContextGraphReadAuthorityDecision> {
  if (registeredAuthority.kind === 'unavailable') {
    return unavailable(
      'registered-chain',
      registeredAuthority.reason,
      registeredContextGraphAuthorityUnavailableDependency(registeredAuthority),
      registeredAuthority.onChainId,
      'detailCode' in registeredAuthority ? registeredAuthority.detailCode : undefined,
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

  const approvedPrivateReplica = registeredAuthority.approvedPrivateReplicaAuthority;
  const rfc64Roster = approvedPrivateReplica?.memberAddresses
    ?? input.resolveRfc64PrivateRoster();
  if (rfc64Roster !== undefined) {
    if (rfc64Roster === null) {
      return decision('denied', 'rfc64-private', 'invalid-private-policy-roster');
    }
    const effectiveCaller = input.callerAgentAddress
      ?? approvedPrivateReplica?.approvedAgentAddress
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
