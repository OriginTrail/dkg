// SPDX-License-Identifier: Apache-2.0

/**
 * Typed context-graph read-authority resolution.
 *
 * This module owns precedence between the registered-chain authority, RFC-64
 * activation policy, and legacy local metadata. Callers that only need a
 * boolean can adapt `outcome === 'allowed'`; recovery and diagnostics retain
 * the distinction between an authoritative denial and unavailable authority.
 */

import type { RegisteredContextGraphAuthority } from
  './registered-context-graph-authority.js';

export type ContextGraphReadAuthorityOutcome = 'allowed' | 'denied' | 'unavailable';

export type ContextGraphReadAuthoritySource =
  | 'system'
  | 'registered-chain'
  | 'rfc64-private'
  | 'rfc64-public'
  | 'legacy-local';

export interface ContextGraphReadAuthorityDecision {
  outcome: ContextGraphReadAuthorityOutcome;
  source: ContextGraphReadAuthoritySource;
  reason: string;
  metadataBootstrap: 'eligible' | 'forbidden';
  onChainId?: bigint;
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

export async function resolveContextGraphReadAuthorityDecision(
  input: ContextGraphReadAuthorityInput,
): Promise<ContextGraphReadAuthorityDecision> {
  if (input.isSystemContextGraph) {
    return decision('allowed', 'system', 'system-context-graph');
  }

  let registeredAuthority: RegisteredContextGraphAuthority;
  try {
    registeredAuthority = await input.getRegisteredAuthority();
  } catch {
    return decision('unavailable', 'registered-chain', 'registered-authority-error');
  }
  if (registeredAuthority.kind === 'unavailable') {
    return decision(
      'unavailable',
      'registered-chain',
      registeredAuthority.reason,
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
    } catch {
      return decision('unavailable', 'registered-chain', 'peer-authority-unavailable', registeredAuthority.onChainId);
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
    return decision('unavailable', 'legacy-local', 'pending-authoritative-metadata');
  }

  let isPrivate: boolean;
  try {
    isPrivate = await input.isPrivateLocalGraph();
  } catch {
    return decision('unavailable', 'legacy-local', 'local-access-policy-unavailable');
  }
  if (!isPrivate) return decision('allowed', 'legacy-local', 'local-public');

  let allowedPeers: string[] | null;
  try {
    allowedPeers = await input.getAllowedPeers();
  } catch {
    return decision('unavailable', 'legacy-local', 'peer-authority-unavailable');
  }

  let agentGateAddresses: string[] | null;
  try {
    agentGateAddresses = await input.getLocalAgentGate();
  } catch {
    return decision('unavailable', 'legacy-local', 'local-agent-authority-unavailable');
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
  } catch {
    return decision('unavailable', 'legacy-local', 'legacy-participant-authority-unavailable');
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
