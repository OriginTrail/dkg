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
  readMetadataRevision(): number;
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
  origin?: 'agent-gate-revision',
): Extract<ContextGraphAgentGateAuthority, { kind: 'unavailable' }> {
  return {
    kind: 'unavailable',
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(origin === undefined ? {} : { origin }),
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
  // A concurrent metadata write can invalidate a legacy roster while its
  // store read is in flight. Re-read the entire decision a bounded number of
  // times so an ordinary create/write burst does not strand SWM publishing.
  // Never return a roster captured before the final revision check.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const conclusiveGate = conclusiveTransportGate(await input.getTransportAuthority());
    if (conclusiveGate !== null) return conclusiveGate;

    const metadataRevision = input.readMetadataRevision();
    const meta = await input.getLegacyMeta();
    // A private policy or registration can activate during the store read.
    const currentConclusiveGate = conclusiveTransportGate(await input.getTransportAuthority());
    if (currentConclusiveGate !== null) return currentConclusiveGate;
    if (input.readMetadataRevision() !== metadataRevision) continue;

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
  return unavailableAuthority(
    'local-existence-unavailable',
    `Context graph "${input.contextGraphId}" metadata authority changed while resolving its agent gate`,
    'agent-gate-revision',
  );
}
