// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';

/** Only receiver-authored controls from the anchored local sidecar survive replay. */
export const GRAPH_KNOWLEDGE_ASSET_LOCAL_CONTROL_PREDICATES: readonly string[] = Object.freeze([
  'http://dkg.io/ontology/accessPolicy', 'http://dkg.io/ontology/allowedPeer',
  'http://dkg.io/ontology/publisherPeerId',
]);

/** Peer attribution is discarded; only the local control subset can be overlaid again. */
export const GRAPH_KNOWLEDGE_ASSET_REPLAY_CONTROL_PREDICATES: readonly string[] = Object.freeze([
  ...GRAPH_KNOWLEDGE_ASSET_LOCAL_CONTROL_PREDICATES, 'http://www.w3.org/ns/prov#wasAttributedTo',
]);
const replayControls = new Set(GRAPH_KNOWLEDGE_ASSET_REPLAY_CONTROL_PREDICATES);

export function stripGraphKnowledgeAssetPeerControls<T extends Pick<Quad, 'predicate'>>(rows: readonly T[]): T[] {
  return rows.filter(row => !replayControls.has(row.predicate));
}

/** The bounded held-content read compares exactly what a replay replaces or drops. */
export function projectGraphKnowledgeAssetReplayControls<T extends Pick<Quad, 'predicate'>>(rows: readonly T[]): T[] {
  return rows.filter(row => replayControls.has(row.predicate));
}
