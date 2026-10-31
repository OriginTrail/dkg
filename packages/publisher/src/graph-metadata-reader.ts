// SPDX-License-Identifier: Apache-2.0
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { parseConfirmedGraphKnowledgeAssetMetadataEnvelope, parseGraphKnowledgeAssetMetadataEnvelope,
  type ConfirmedGraphKnowledgeAssetMetadataRead, type GraphKnowledgeAssetMetadataRead,
} from './graph-metadata-envelope.js';

async function readGraphKnowledgeAssetMetadataRows(
  store: TripleStore,
  contextGraphId: string,
  ual: string,
): Promise<ReadonlyArray<Pick<Quad, 'predicate' | 'object'>>> {
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  assertSafeGraphIriForSparql(metaGraph);
  assertSafeGraphIriForSparql(ual);
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
  input: { contextGraphId: string; ual: string },
): Promise<ConfirmedGraphKnowledgeAssetMetadataRead> {
  const rows = await readGraphKnowledgeAssetMetadataRows(store, input.contextGraphId, input.ual);
  return parseConfirmedGraphKnowledgeAssetMetadataEnvelope(rows, input);
}

/** Preserve valid tentative state for consumers which do not require confirmation. */
export async function readGraphKnowledgeAssetMetadataEnvelope(
  store: TripleStore,
  input: { contextGraphId: string; ual: string },
): Promise<GraphKnowledgeAssetMetadataRead> {
  const rows = await readGraphKnowledgeAssetMetadataRows(store, input.contextGraphId, input.ual);
  return parseGraphKnowledgeAssetMetadataEnvelope(rows, input);
}
function assertSafeGraphIriForSparql(graphIri: string): void {
  // GRAPH <...> must not allow delimiter/control chars that can alter query structure.
  if (/[<>"{}|^`\\\s]/.test(graphIri)) {
    throw new Error(`Unsafe graph IRI for SPARQL query: "${graphIri}"`);
  }
}
