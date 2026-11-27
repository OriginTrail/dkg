import type { Quad } from '@origintrail-official/dkg-storage';

/**
 * Rootless KAs currently have one RDF dataset scope: the default graph inside
 * their exact physical per-KA graph. A non-empty quad graph term is therefore
 * user-authored RDF named-graph identity, not storage placement metadata.
 *
 * Canonicalization deliberately operates on the RDF triple set and would erase
 * that graph term. Reject it before hashing or materialization so two identical
 * SPOs in different named graphs cannot collapse into a seal that no longer
 * represents the submitted dataset. Physical DKG graph terms are normalized to
 * the default graph by assertionWrite before this boundary.
 */
export function assertNoKnowledgeAssetPayloadNamedGraphs(
  ...partitions: ReadonlyArray<ReadonlyArray<Quad>>
): void {
  const namedGraphs = [...new Set(
    partitions
      .flatMap((quads) => quads)
      .map((quad) => quad.graph)
      .filter((graph): graph is string => typeof graph === 'string' && graph.length > 0),
  )];

  if (namedGraphs.length === 0) return;

  throw Object.assign(
    new Error(
      'Knowledge Asset contains RDF named-graph quads, but SWM share and VM publish do not yet preserve original graph identity. '
      + 'Rewrite the payload into the default graph before sharing, or keep the KA in WM until graph-preserving SWM/VM semantics are implemented.',
    ),
    { code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED', namedGraphs },
  );
}
