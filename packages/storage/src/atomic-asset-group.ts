// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { assertReplacementPayload, assertSubjectReplacementPayload, buildAtomicGraphAndSubjectReplaceUpdate } from './atomic-graph-replace.js';
import type { Quad } from './triple-store.js';

/** One atomic visibility boundary, independently bounded from a transport chunk. */
export interface AtomicAssetReplacement {
  graphUri: string;
  graphQuads: Quad[];
  metaGraphUri: string;
  metadataSubject: string;
  metadataQuads: Quad[];
}
export const ATOMIC_ASSET_GROUP_MAX_ASSETS = 8;
export const ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES = 32 * 1024 * 1024;

/** Validate the entire group before any write; one backend transaction publishes all pairs. */
export function validateAtomicAssetGroup(assets: readonly AtomicAssetReplacement[]): void {
  if (!assets.length || assets.length > ATOMIC_ASSET_GROUP_MAX_ASSETS) throw new RangeError('Invalid atomic asset group size');
  const graphs = new Set(assets.map(a => a.graphUri));
  const subjects = new Set(assets.map(a => `${a.metaGraphUri}\0${a.metadataSubject}`));
  if (graphs.size !== assets.length || subjects.size !== assets.length
    || assets.some(a => graphs.has(a.metaGraphUri))) throw new Error('Overlapping atomic asset group destinations');
  for (const a of assets) {
    assertSafeIri(a.graphUri); assertSafeIri(a.metaGraphUri); assertSafeIri(a.metadataSubject);
    assertReplacementPayload(a.graphUri, a.graphQuads);
    assertSubjectReplacementPayload(a.metaGraphUri, a.metadataSubject, a.metadataQuads);
  }
}
export function buildAtomicAssetGroupUpdate(assets: readonly AtomicAssetReplacement[]) {
  validateAtomicAssetGroup(assets);
  const plans = assets.map(a => buildAtomicGraphAndSubjectReplaceUpdate(
    a.graphUri, a.graphQuads, a.metaGraphUri, a.metadataSubject, a.metadataQuads));
  const update = plans.map(p => p.update).join(';\n');
  if (Buffer.byteLength(update) > ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES) throw new RangeError('Atomic asset group byte allowance exceeded');
  return { update, cleanup: plans.map(p => p.cleanup).join(';\n'),
    graphs: [...new Set(assets.flatMap(a => [a.graphUri, a.metaGraphUri]))] };
}
