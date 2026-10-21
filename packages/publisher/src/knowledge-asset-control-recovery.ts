// SPDX-License-Identifier: Apache-2.0
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { readLocallyTrustedKnowledgeAssetControls, writeLocallyTrustedKnowledgeAssetControlEntry,
  LOCAL_TRUSTED_KA_CONTROL_PREDICATES, LOCAL_TRUSTED_KA_SIDECAR_PREDICATES,
  type LocallyTrustedKnowledgeAssetControlAnchor } from './metadata.js';
import { toHex } from './metadata.js';

/** Caller holds the KA materialization lock. Select once, preserving exact-anchor local ownership. */
export async function reconcileConfirmedKnowledgeAssetControls(store: TripleStore, input: {
  metaGraph: string; ual: string; anchor: LocallyTrustedKnowledgeAssetControlAnchor;
  metadataQuads: readonly Quad[]; restoreMissing: boolean;
}): Promise<Quad[]> {
  const { metaGraph, ual, anchor, metadataQuads, restoreMissing } = input;
  if (metadataQuads.some(q => q.subject !== ual || q.graph !== metaGraph)) {
    throw new Error('Confirmed control reconciliation requires one asset in one metadata graph');
  }
  const selected = await readLocallyTrustedKnowledgeAssetControls(store, metaGraph, ual, metadataQuads, {}, 'exact');
  if (selected.length > 0 || !restoreMissing) return selected;
  const fallback = metadataQuads.filter(q => LOCAL_TRUSTED_KA_SIDECAR_PREDICATES.has(q.predicate));
  await writeLocallyTrustedKnowledgeAssetControlEntry(store, ual, BigInt(anchor.assertionVersion), toHex(anchor.merkleRoot).toLowerCase(), fallback);
  return fallback.filter(q => LOCAL_TRUSTED_KA_CONTROL_PREDICATES.has(q.predicate));
}

/** Apply already-selected controls without another lookup or inheritance decision. */
export function overlaySelectedKnowledgeAssetControls(metadata: readonly Quad[], selected: readonly Quad[]): Quad[] {
  if (selected.length === 0) return [...metadata];
  return [...metadata.filter(q => !LOCAL_TRUSTED_KA_CONTROL_PREDICATES.has(q.predicate)), ...selected];
}
