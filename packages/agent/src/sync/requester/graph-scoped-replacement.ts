// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { readCurrentAssertionVersion, mergeSameVersionGraphKnowledgeAssetMetadataV1, overlayLocallyTrustedKnowledgeAssetControls } from '@origintrail-official/dkg-publisher';
import type { AtomicAssetReplacement, Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';

export interface PreparedGraphScopedReplacement {
  readonly replacement: AtomicAssetReplacement;
  /** The store already holds exactly what `replacement` would write: committing it would change nothing. */
  readonly held: boolean;
}

/** Caller owns the per-asset lock and the stale/publication outcome policy. */
export async function prepareGraphScopedReplacementUnderLock(params: {
  store: TripleStore; asset: VerifiedGraphScopedAsset; options: QueryOptions;
  assertCurrent: () => void; requireCurrentMetadata: boolean;
  /** On a same-version replay, read the stored copy and say whether it already is the replacement. */
  detectHeldCopy?: boolean;
}): Promise<PreparedGraphScopedReplacement | undefined> {
  const { store, asset, options, assertCurrent, requireCurrentMetadata } = params;
  assertCurrent();
  const version = await readCurrentAssertionVersion(store, asset.metaGraph, asset.ual, options);
  assertCurrent();
  if (version !== undefined && version > asset.assertionVersion) return undefined;
  let metadata = asset.metadataQuads;
  let current: Quad[] | undefined;
  if (version === asset.assertionVersion) {
    current = await readCurrentMetadata(store, asset.metaGraph, asset.ual, options);
    if (!current && requireCurrentMetadata) throw new Error('Group metadata read unavailable');
    if (current) metadata = mergeSameVersionGraphKnowledgeAssetMetadataV1(metadata, current);
    assertCurrent();
  }
  metadata = await overlayLocallyTrustedKnowledgeAssetControls(store, asset.metaGraph, asset.ual, metadata, options);
  assertCurrent();
  const replacement = { graphUri: asset.assertionGraph, graphQuads: asset.dataQuads,
    metaGraphUri: asset.metaGraph, metadataSubject: asset.ual, metadataQuads: metadata };
  const held = params.detectHeldCopy === true && current !== undefined
    && await storeHoldsReplacement(store, replacement, current, options);
  assertCurrent();
  return { replacement, held };
}

async function readCurrentMetadata(store: TripleStore, metaGraph: string, ual: string, options: QueryOptions): Promise<Quad[] | undefined> {
  const result = await store.query(`SELECT ?predicate ?object WHERE {
    GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(ual)}> ?predicate ?object . }
  }`, options);
  if (result.type !== 'bindings' || result.bindings.some(row => !row.predicate || !row.object)) return undefined;
  return result.bindings.map(row => ({ graph: metaGraph, subject: ual, predicate: row.predicate!, object: row.object! }));
}

const termRow = (subject: string, predicate: string, object: string): string => `${subject}\0${predicate}\0${object}`;

/**
 * Whether committing `replacement` would leave the store as it is: the subject's
 * metadata rows are exactly the replacement's, and its assertion graph holds
 * exactly the replacement's rows. Terms are compared as the store returns them,
 * so a blank node or a differently written literal answers no, as does a read
 * the store refuses; the caller then writes, as it always did.
 */
async function storeHoldsReplacement(
  store: TripleStore, replacement: AtomicAssetReplacement, currentMetadata: readonly Quad[], options: QueryOptions,
): Promise<boolean> {
  const expectedMetadata = new Set(replacement.metadataQuads.map(quad => termRow(quad.subject, quad.predicate, quad.object)));
  const storedMetadata = new Set(currentMetadata.map(quad => termRow(quad.subject, quad.predicate, quad.object)));
  if (expectedMetadata.size !== storedMetadata.size || [...storedMetadata].some(entry => !expectedMetadata.has(entry))) {
    return false;
  }
  const expectedData = new Set(replacement.graphQuads.map(quad => termRow(quad.subject, quad.predicate, quad.object)));
  let stored: Awaited<ReturnType<TripleStore['query']>>;
  try {
    // One row more than expected tells an extra stored row from an exact copy.
    stored = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${assertSafeIri(replacement.graphUri)}> { ?s ?p ?o } } LIMIT ${expectedData.size + 1}`,
      { ...options, source: `${options.source ?? 'agent.durableSync.graphScopedMaterialization'}.heldCopy` },
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return false;
  }
  if (stored.type !== 'bindings' || stored.bindings.length !== expectedData.size) return false;
  return stored.bindings.every(({ s, p, o }) => s !== undefined && p !== undefined && o !== undefined
    && expectedData.has(termRow(s, p, o)));
}
