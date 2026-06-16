/**
 * OT-RFC-49 / WS-C — load the PUBLIC `_catalog` triples for a curated CG
 * from the local triple store, ready to feed to `computeCatalogRoot` /
 * `hashTripleV10` from `@origintrail-official/dkg-core`.
 *
 * Storage shape (mirrors what the publisher's `persistCatalogEntry` and
 * the agent's catalog projection / open-serve persist + read):
 *
 *   GRAPH <did:dkg:context-graph:<cgId>/_catalog> {
 *     <subject> <predicate> <object|"literal"> .
 *   }
 *
 * The named graph is `contextGraphCatalogUri(String(contextGraphId))` —
 * the SAME bounded, plaintext, core-servable graph the §7 facet
 * open-serve releases without auth. Unlike the ciphertext-chunk path
 * this contains NO private content: the curated random-sampling
 * commitment (`DKGKnowledgeAssets.catalogRoots`) is a V10 Merkle tree
 * over exactly these triples (each leaf `hashTripleV10(s,p,o)`, graph
 * excluded), so the prover proves the public catalog rather than any
 * ciphertext chunk.
 *
 * Failure mode:
 *  - {@link CatalogLeavesMissingError}: the catalog graph is empty
 *    locally. Caller SHOULD treat this exactly like the public path's
 *    `kc-not-synced` skip (the catalog hasn't synced to this core yet)
 *    — skip the period and retry on the next tick.
 */

import { contextGraphCatalogUri, catalogCommittedLeaves } from '@origintrail-official/dkg-core';
import type { CatalogTriple } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

export interface ExtractCatalogLeavesInput {
  store: TripleStore;
  /** Numeric on-chain context graph id; keys the `<cgId>/_catalog` named graph. */
  contextGraphId: bigint;
}

/**
 * Thrown when the public `_catalog` named graph for the CG holds zero
 * triples in the local store. Almost always a sync gap (the catalog
 * DCAT record hasn't reached this core yet); the prover treats it like
 * the public path's `KCDataMissingError` — a skip-this-period signal,
 * not a retry-with-same-data error.
 */
export class CatalogLeavesMissingError extends Error {
  readonly name = 'CatalogLeavesMissingError';
  constructor(
    readonly contextGraphId: bigint,
    readonly catalogGraph: string,
  ) {
    super(
      `CG ${contextGraphId} catalog graph <${catalogGraph}> returned zero ` +
      `triples locally; catalog not synced — skip this period and retry`,
    );
  }
}

/**
 * Resolve a curated CG's public `_catalog` triples from a local
 * `TripleStore`. Returns them as `{subject,predicate,object}[]` in
 * store-emit order — `computeCatalogRoot` / `V10MerkleTree` sorts +
 * dedupes internally, so callers do not need to pre-sort.
 *
 * OT-RFC-49 / WS-D — THE PARITY CONTRACT: the rebuilt set is filtered
 * through {@link catalogCommittedLeaves} (the SAME definition the
 * producer's `computeCatalogRoot(catalogCommittedLeaves(...))` input
 * uses in the publisher), so the proven leaf-set is byte-identical to
 * the committed one. The filter strips the post-publish stamps
 * (`dkg:committedRoot` — the on-chain VM merkleRoot the public
 * projection writes into `<cg>/_catalog` only AFTER publish), which a
 * leaf cannot hash because it belongs to the very set being committed.
 * Without this shared filter, a single projection stamp landing in the
 * `_catalog` graph would silently break curated proving every period.
 *
 * Throws {@link CatalogLeavesMissingError} when the catalog graph holds
 * no COMMITTED leaves (mirrors the public extractor's missing-data
 * skip) — i.e. empty, or only post-publish stamps with no real entry.
 */
export async function extractCatalogLeavesFromStore(
  input: ExtractCatalogLeavesInput,
): Promise<CatalogTriple[]> {
  const catalogGraph = contextGraphCatalogUri(String(input.contextGraphId));
  const result = await input.store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE {
       GRAPH <${catalogGraph}> {
         ?s ?p ?o .
       }
     }`,
  );

  const rawTriples =
    result.type === 'quads'
      ? result.quads.map((q) => ({
          subject: q.subject,
          predicate: q.predicate,
          object: q.object,
        }))
      : [];

  // Strip the post-publish stamps so the rebuilt set == the producer's
  // committed set (the on-chain `getCatalogRoot` preimage).
  const triples = catalogCommittedLeaves(rawTriples);

  if (triples.length === 0) {
    throw new CatalogLeavesMissingError(input.contextGraphId, catalogGraph);
  }

  return triples;
}
