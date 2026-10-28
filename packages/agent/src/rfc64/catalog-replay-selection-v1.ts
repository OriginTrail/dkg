// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from '../dkg-agent.js';

/** Receiving and serving have independent authority after an edge unsubscribes. */
export function selectCatalogReplayGraphsV1(agent: DKGAgent, purpose: 'receiver' | 'serving', configuredIds: readonly string[]): readonly string[] {
  const ids = new Set([...agent.readRfc64CatalogResponsibilitiesV1().map(selection => selection.contextGraphId),
    ...configuredIds]);
  return Object.freeze([...ids].filter(id => {
    const authority = purpose === 'receiver' ? agent.resolveRfc64CatalogReceiverAuthorityV1(id)
      : agent.resolveRfc64CatalogServingAuthorityV1(id);
    return authority.active && authority.mode !== 'legacy';
  }).sort());
}
