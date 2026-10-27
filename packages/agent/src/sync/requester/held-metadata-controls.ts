// SPDX-License-Identifier: Apache-2.0
import { readLocallyTrustedKnowledgeAssetControls } from '@origintrail-official/dkg-publisher';
import type { Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';

/** Peer ACLs and attribution are discarded by normal authenticated materialization. */
export const HELD_REPLAY_CONTROL_PREDICATES = [
  'http://dkg.io/ontology/accessPolicy', 'http://dkg.io/ontology/allowedPeer',
  'http://dkg.io/ontology/publisherPeerId', 'http://www.w3.org/ns/prov#wasAttributedTo',
] as const;
const controls = new Set<string>(HELD_REPLAY_CONTROL_PREDICATES);

/** Skip DATA only if a replay would retain the same trusted local controls. */
export async function heldMetadataControlsMatchReplay(
  store: TripleStore, metaGraph: string, ual: string,
  rows: readonly Pick<Quad, 'predicate' | 'object'>[], options: QueryOptions,
): Promise<boolean> {
  const metadata = rows.map(row => ({ ...row, subject: ual, graph: metaGraph }));
  const trusted = await readLocallyTrustedKnowledgeAssetControls(store, metaGraph, ual, metadata, options);
  const canonical = (values: readonly Pick<Quad, 'predicate' | 'object'>[]) =>
    [...new Set(values.filter(row => controls.has(row.predicate))
      .map(row => JSON.stringify([row.predicate, row.object])))].sort();
  const stored = canonical(metadata), expected = canonical(trusted);
  // Receiver-owned timestamps/provenance are intentionally outside this comparison.
  return stored.length === expected.length && stored.every((value, index) => value === expected[index]);
}
