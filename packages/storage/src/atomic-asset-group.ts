// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, assertQuadLiteralsMutf8Safe, JAVA_WRITE_UTF_MAX_BYTES } from '@origintrail-official/dkg-core';
import { assertReplacementPayload, assertSubjectReplacementPayload } from './atomic-graph-replace.js';
import { renderBoundedAtomicAssetUpdate } from './atomic-update-rendering.js';
import type { Quad } from './triple-store.js';
import { ATOMIC_ASSET_GROUP_MAX_ASSETS } from './atomic-asset-limits.js';
export { ATOMIC_ASSET_GROUP_MAX_ASSETS, ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES } from './atomic-asset-limits.js';

/** One atomic visibility boundary, independently bounded from a transport chunk. */
export interface AtomicAssetReplacement {
  graphUri: string;
  graphQuads: Quad[];
  metaGraphUri: string;
  metadataSubject: string;
  metadataQuads: Quad[];
}

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
/** Enforce backend literal limits independently from optional IRI reporting. */
export function preflightAtomicAssetGroupLiterals(assets: readonly AtomicAssetReplacement[]): void {
  for (const a of assets) {
    assertQuadLiteralsMutf8Safe([...a.graphQuads, ...a.metadataQuads], {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES, label: 'replaceAssetGroup',
    });
  }
}
export function buildAtomicAssetGroupUpdate(assets: readonly AtomicAssetReplacement[]) {
  validateAtomicAssetGroup(assets);
  preflightAtomicAssetGroupLiterals(assets);
  const plan = renderBoundedAtomicAssetUpdate(assets);
  if (!plan) throw new RangeError('Atomic asset group byte allowance exceeded');
  return plan;
}
