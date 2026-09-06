// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

import type {
  ContextGraphAgentGateAuthority,
  ContextGraphAgentGateUnavailableReason,
  RegisteredContextGraphAuthority,
} from './context-graph-authority.js';

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
