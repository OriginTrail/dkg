// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { isCanonicalAuthoritativeContextGraphId } from './context-graph-binding-state.js';
import type { ContextGraphSubInput, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';

/**
 * Restore exact saved identity independently of subscription activity. This
 * projection owns no state, authority reads, network effects or persistence.
 * Conflicting/invalid rows cannot select a numeric slot by snapshot order.
 */
export function projectDormantContextGraphIdentities(
  rows: readonly ContextGraphSubscriptionRecord[],
): ReadonlyMap<string, ContextGraphSubInput> {
  const projected = new Map<string, ContextGraphSubInput | null>();
  for (const row of rows) {
    let identity: ContextGraphSubInput | null = null;
    if (isCanonicalAuthoritativeContextGraphId(row.onChainId)) {
      try {
        const commitment = ethers.keccak256(ethers.toUtf8Bytes(row.id)).toLowerCase();
        const explicitHash = row.onChainHash?.toLowerCase();
        const hashShaped = /^0x[0-9a-f]{64}$/i.test(row.id);
        const wirePlaceholder = hashShaped && explicitHash === row.id.toLowerCase();
        // A legacy hash-keyed row without its hash is ambiguous. Leave it for
        // matching native chain observation to stage/repair rather than invent
        // the commitment of a possible placeholder's literal spelling.
        if ((explicitHash === undefined && !hashShaped) || explicitHash === commitment || wirePlaceholder) {
          identity = {
            name: row.name,
            onChainId: row.onChainId,
            onChainHash: explicitHash ?? commitment,
            syncMode: 'always-on',
            subscribed: false, coreHosted: false, synced: false,
            sharedMemorySynced: false, metaSynced: false,
            lastReconciledOrdinal: row.lastReconciledOrdinal,
          };
        }
      } catch {
        // Invalid UTF-16 cannot establish a committed local graph identity.
      }
    }
    const previous = projected.get(row.id);
    if (projected.has(row.id) && (
      previous === null || identity === null
      || previous?.onChainId !== identity.onChainId
      || previous?.onChainHash !== identity.onChainHash
    )) projected.set(row.id, null);
    else projected.set(row.id, identity);
  }
  return new Map([...projected].filter(
    (entry): entry is [string, ContextGraphSubInput] => entry[1] !== null,
  ));
}
