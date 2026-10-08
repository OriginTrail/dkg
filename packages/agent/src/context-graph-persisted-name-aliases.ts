// SPDX-License-Identifier: Apache-2.0

import { isCanonicalAuthoritativeContextGraphId } from './context-graph-binding-state.js';
import {
  normalizeContextGraphNameHash,
  verifyContextGraphNameCandidate,
} from './context-graph-name-candidate.js';
import type { ContextGraphSubscriptionRecord } from './dkg-agent-types.js';

type PersistedNameBinding = Pick<ContextGraphSubscriptionRecord, 'id' | 'onChainHash' | 'onChainId'>;

/** Name preimages are aliases only when competing durable rows own one slot. */
export function persistedContextGraphIdAliases(
  rows: readonly PersistedNameBinding[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  const placeholders = new Map<string, PersistedNameBinding[]>();
  for (const row of rows) {
    const hash = normalizeContextGraphNameHash(row.id);
    if (hash === null || normalizeContextGraphNameHash(row.onChainHash) !== hash) continue;
    const competing = placeholders.get(hash) ?? [];
    competing.push(row);
    placeholders.set(hash, competing);
  }
  for (const row of rows) {
    const nameHash = normalizeContextGraphNameHash(row.onChainHash);
    if (nameHash === null || row.id.toLowerCase() === nameHash) continue;
    const competing = placeholders.get(nameHash);
    // Equal commitments can name different registry slots. A competing saved
    // placeholder is an alias only when both durable rows prove the same slot.
    if (competing !== undefined && (
      !isCanonicalAuthoritativeContextGraphId(row.onChainId)
      || competing.some((placeholder) => (
        !isCanonicalAuthoritativeContextGraphId(placeholder.onChainId)
        || row.onChainId !== placeholder.onChainId
      ))
    )) continue;
    if (verifyContextGraphNameCandidate(row.id, nameHash) === row.id) aliases.set(nameHash, row.id);
  }
  return aliases;
}

/** Do not rehydrate a placeholder superseded by the same durable numeric slot. */
export function partitionSupersededContextGraphNamePlaceholders<T extends PersistedNameBinding>(
  rows: readonly T[],
): { readonly active: T[]; readonly superseded: T[] } {
  const cleartextByHash = persistedContextGraphIdAliases(rows);
  const active: T[] = [];
  const superseded: T[] = [];
  for (const row of rows) {
    const nameHash = normalizeContextGraphNameHash(row.id);
    const placeholder = nameHash !== null
      && normalizeContextGraphNameHash(row.onChainHash) === nameHash;
    if (placeholder && cleartextByHash.has(nameHash!)) superseded.push(row);
    else active.push(row);
  }
  return { active, superseded };
}
