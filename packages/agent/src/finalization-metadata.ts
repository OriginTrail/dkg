// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { materializedVersionQuad, mergeSameVersionGraphKnowledgeAssetMetadataV1,
  type MaterializedVersion } from '@origintrail-official/dkg-publisher';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

/** Caller holds the materialization lock and establishes the exact assertion anchor. */
export async function prepareGraphScopedFinalizationMetadata(input: {
  readonly store: TripleStore;
  readonly metadata: readonly Quad[];
  readonly materializedVersion: MaterializedVersion;
  readonly sameAssertion: boolean;
}): Promise<Quad[]> {
  const { store, metadata, materializedVersion, sameAssertion } = input;
  const identity = metadata[0];
  if (identity === undefined) throw new Error('Verified finalization metadata is empty');
  const ordering = materializedVersionQuad(identity.graph, identity.subject, materializedVersion);
  const ordered = (quads: readonly Quad[]): Quad[] => {
    const index = quads.findIndex(quad => quad.predicate === ordering.predicate), result = [...quads];
    if (index < 0) result.push(ordering); else result[index] = ordering;
    return result;
  };
  const incoming = ordered(metadata);
  if (!sameAssertion) return incoming;
  const subject = assertSafeIri(identity.subject), graph = assertSafeIri(identity.graph);
  const current = await store.query(
    `CONSTRUCT { <${subject}> ?p ?o } WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } }`,
    { source: 'agent.finalization.sameAssertionMetadata' },
  );
  if (current.type !== 'quads') throw new Error('Same-assertion metadata read unavailable');
  const merged = mergeSameVersionGraphKnowledgeAssetMetadataV1(incoming,
    current.quads.map(quad => ({ ...quad, graph: identity.graph })));
  // Retaining an older receipt must not lower the caller's fenced ordering stamp.
  return ordered(merged);
}
