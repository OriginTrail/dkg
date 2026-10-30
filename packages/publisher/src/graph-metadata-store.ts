// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { parseConfirmedGraphKnowledgeAssetMetadataEnvelope, parseGraphKnowledgeAssetMetadataEnvelope,
  type ConfirmedGraphKnowledgeAssetMetadataRead, type GraphKnowledgeAssetMetadataRead } from './graph-metadata-envelope.js';

async function readGraphKnowledgeAssetMetadataRows(
  store: TripleStore,
  contextGraphId: string,
  ual: string,
  metaGraphUri?: string,
): Promise<ReadonlyArray<Pick<Quad, 'predicate' | 'object'>>> {
  const metaGraph = metaGraphUri ?? `did:dkg:context-graph:${contextGraphId}/_meta`;
  assertSafeIri(metaGraph);
  assertSafeIri(ual);
  const result = await store.query(
    `SELECT ?predicate ?object WHERE {
      GRAPH <${metaGraph}> { <${ual}> ?predicate ?object }
    }`,
  );
  if (result.type !== 'bindings') {
    throw new Error('Graph-scoped metadata SELECT expected a bindings result');
  }
  if (result.bindings.some((row) =>
    row['predicate'] === undefined || row['object'] === undefined)) {
    throw new Error('Graph-scoped metadata SELECT returned an incomplete binding');
  }
  return result.bindings.map((row) => ({
    predicate: row['predicate']!,
    object: row['object']!,
  }));
}

/**
 * Read the immutable subset needed to recognize an exact, already-confirmed
 * graph-scoped Verifiable Memory assertion after its mutable workspace head has been lost.
 * Structural drift is reported separately from absence; store failures throw.
 */
export async function readConfirmedGraphKnowledgeAssetMetadataEnvelope(
  store: TripleStore,
  input: { contextGraphId: string; ual: string; metaGraphUri?: string },
): Promise<ConfirmedGraphKnowledgeAssetMetadataRead> {
  const rows = await readGraphKnowledgeAssetMetadataRows(store, input.contextGraphId, input.ual, input.metaGraphUri);
  return parseConfirmedGraphKnowledgeAssetMetadataEnvelope(rows, input);
}

/** Read tentative and confirmed records through the same structural validator. */
export async function readGraphKnowledgeAssetMetadataEnvelope(store: TripleStore,
  input: { contextGraphId: string; ual: string; metaGraphUri?: string }): Promise<GraphKnowledgeAssetMetadataRead> {
  return parseGraphKnowledgeAssetMetadataEnvelope(await readGraphKnowledgeAssetMetadataRows(store, input.contextGraphId, input.ual, input.metaGraphUri), input);
}
