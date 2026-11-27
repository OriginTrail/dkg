// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphDiscoveryMetadata, ContextGraphSub } from './dkg-agent-types.js';
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';

/** Return the existing row only when its activation owner must commit first. */
export function projectDiscoveredContextGraphSubscription(
  existing: ContextGraphSub | undefined,
  metadata: ContextGraphDiscoveryMetadata,
  dormancy: ContextGraphDormancyReason | undefined,
): ContextGraphSub {
  if (
    (existing?.subscribed === true || existing?.coreHosted === true)
    && dormancy === 'authorityUnavailable'
  ) {
    // Deferred activation installs a provisional row before awaiting its
    // authority/durability boundary. Even an identical discovery save advances
    // its revision and clears dormancy, stranding the rolled-back activation.
    // Keep that owner's row untouched until it commits; enrich on a later pass.
    return existing;
  }
  return {
    ...existing,
    syncMode: existing?.syncMode ?? 'always-on',
    name: metadata.name ?? existing?.name,
    subscribed: existing?.subscribed === true,
    synced: existing?.synced === true,
    sharedMemorySynced: existing?.sharedMemorySynced === true,
    metaSynced: existing?.metaSynced === true,
    participantAgents: metadata.participantAgents ?? existing?.participantAgents,
  };
}
