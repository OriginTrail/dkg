// SPDX-License-Identifier: Apache-2.0
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { selectOrAdmitLocallyTrustedKnowledgeAssetControls,
  type LocallyTrustedKnowledgeAssetControlAnchor } from './metadata.js';

/** Caller holds the KA materialization lock. Select once, preserving exact-anchor local ownership. */
export async function reconcileConfirmedKnowledgeAssetControls(store: TripleStore, input: {
  metaGraph: string; ual: string; anchor: LocallyTrustedKnowledgeAssetControlAnchor;
  metadataQuads: readonly Quad[]; restoreMissing: boolean;
}): Promise<Quad[]> {
  const { metaGraph, ual, anchor, metadataQuads, restoreMissing } = input;
  if (metadataQuads.some(q => q.subject !== ual || q.graph !== metaGraph)) {
    throw new Error('Confirmed control reconciliation requires one asset in one metadata graph');
  }
  return selectOrAdmitLocallyTrustedKnowledgeAssetControls(store, {
    metaGraph, ual, anchor, metadataQuads, restoreMissing,
  });
}
