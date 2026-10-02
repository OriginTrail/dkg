// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

import type {
  ContextGraphAgentGateAuthority,
  ContextGraphAgentGateUnavailableReason,
} from './context-graph-authority.js';
import type { SwmTransportAuthority } from './swm-transport-authority.js';

export interface ContextGraphAgentGateAuthorityInput {
  contextGraphId: string;
  getTransportAuthority(): Promise<SwmTransportAuthority>;
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

function conclusiveTransportGate(
  transportAuthority: SwmTransportAuthority,
): ContextGraphAgentGateAuthority | null {
  if (transportAuthority.kind === 'private-roster') {
    const seen = new Set<string>();
    const accepted: string[] = [];
    for (const value of transportAuthority.participantAgents) {
      if (!ethers.isAddress(value)) continue;
      const checksum = ethers.getAddress(value);
      const key = checksum.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      accepted.push(checksum);
    }
    return { kind: 'available', agentAddresses: accepted };
  }
  if (transportAuthority.kind === 'unavailable') {
    return unavailableAuthority(transportAuthority.reason, transportAuthority.detail);
  }
  return null;
}

/**
 * Canonical signing/encryption gate precedence: registered chain, active
 * accepted RFC-64 private roster, then the legacy local projection.
 */
export async function resolveContextGraphAgentGateAuthorityDecision(
  input: ContextGraphAgentGateAuthorityInput,
): Promise<ContextGraphAgentGateAuthority> {
  const transportAuthority = await input.getTransportAuthority();
  const conclusiveGate = conclusiveTransportGate(transportAuthority);
  if (conclusiveGate !== null) return conclusiveGate;

  const meta = await input.getLegacyMeta();
  // Metadata is an async boundary. A private RFC-64 policy can activate or a
  // private registration can commit while it awaits the store; in either case
  // that exact roster must supersede the captured legacy/approved projection.
  const currentConclusiveGate = conclusiveTransportGate(
    await input.getTransportAuthority(),
  );
  if (currentConclusiveGate !== null) return currentConclusiveGate;

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
