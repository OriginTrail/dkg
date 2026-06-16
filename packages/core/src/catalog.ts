// SPDX-License-Identifier: Apache-2.0
//
// combined-model catalog partition, in core so BOTH the
// agent (injection side) and the publisher (encryption side) can use it.
//
// At publish time a private CG's reloaded quads contain the public DCAT
// catalog entry (subject = the CG UAL, dual-typed dcat:Dataset +
// dkg:PrivateContextGraph) alongside the private data. The catalog rides in the
// CG's own merkle root (verifiability) but must NOT be encrypted: it is routed
// plaintext to the public sink, while only the data is fed to the curated
// encryptor. This partition is the seam that separates them.

import { DKG_ONTOLOGY } from './genesis.js';
import type { CatalogTriple } from './crypto/v10-merkle.js';

/** Structural quad — avoids a core→storage dependency. */
export interface CatalogQuadLike {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

/**
 * Every predicate a catalog entry may carry (floor + recommended + opt-in
 * tiers). A quad is treated as catalog only if its predicate is in this set AND
 * its subject is a catalog subject — fail-safe toward privacy.
 *
 * NB: `rdf:type` is listed here, but membership is NOT sufficient for a
 * `rdf:type` quad — its OBJECT must additionally be an allowed catalog class
 * (see {@link CATALOG_CLASSES}). Otherwise an arbitrary `rdf:type` on the
 * catalog subject would leak into the public `_catalog` (bug B2).
 */
export const CATALOG_PREDICATES: ReadonlySet<string> = new Set<string>([
  DKG_ONTOLOGY.RDF_TYPE,            // object-gated: only CATALOG_CLASSES go public
  DKG_ONTOLOGY.DCT_IDENTIFIER,
  DKG_ONTOLOGY.DCT_ACCESS_RIGHTS,
  DKG_ONTOLOGY.DCT_PUBLISHER,
  DKG_ONTOLOGY.DCAT_ACCESS_SERVICE,
  DKG_ONTOLOGY.DCT_CONFORMS_TO,
  DKG_ONTOLOGY.DKG_BLINDED_ANCHOR,
  DKG_ONTOLOGY.DKG_COMMITTED_ROOT, // separate-KA variant; harmless to recognize
]);

/**
 * The ONLY `rdf:type` objects allowed into the public catalog partition. Any
 * other `rdf:type` on the catalog subject is a data/user type assertion and
 * stays on the private (encrypted) path — fail-safe toward privacy.
 *
 * `dcat:Dataset` + `dkg:PrivateContextGraph` are the dual-typed floor every
 * catalog entry emits (the only types `buildPublicProjection` actually
 * produces); the remaining DCAT *classes* this ontology defines are included
 * for forward-compatibility (DCAT models them as separate-subject resources, so
 * they never appear as a type on the CG subject in practice, but recognizing
 * them is harmless).
 */
export const CATALOG_CLASSES: ReadonlySet<string> = new Set<string>([
  DKG_ONTOLOGY.DCAT_DATASET,            // floor (interop)
  DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, // floor (dkg-native, system marker)
  DKG_ONTOLOGY.DCAT_DISTRIBUTION,
  DKG_ONTOLOGY.DCAT_DATA_SERVICE,
  DKG_ONTOLOGY.DCAT_CATALOG,
]);

export interface CatalogPartition<Q> {
  /** Public, plaintext, core-servable — excluded from ciphertext, kept in the merkle root. */
  catalogQuads: Q[];
  /** Everything else — the existing path (encrypted for a curated CG). */
  otherQuads: Q[];
}

/**
 * Partition publish quads into the public catalog entry and everything else.
 *
 * Identity-based, NOT type-marker-based (round-3 SECURITY). The catalog subject
 * is supplied by the caller as `catalogSubject` — the canonical context-graph
 * DID (`contextGraphDataUri(contextGraphId)` === `did:dkg:context-graph:<id>`),
 * the ONLY subject the catalog injection writes to. A quad is catalog iff its
 * subject IS that exact DID AND its predicate is a catalog predicate AND, for
 * `rdf:type`, its object is an allowed catalog class ({@link CATALOG_CLASSES}).
 *
 * Why the subject is threaded in rather than discovered from a marker quad: the
 * previous implementation treated ANY subject bearing `rdf:type
 * dkg:PrivateContextGraph` as a catalog subject. That marker is user-forgeable
 * and `validatePublishRequest` does not reserve it, so a user could author an
 * ordinary entity with `rdf:type dkg:PrivateContextGraph` + `dct:*` quads and
 * have them (a) routed PLAINTEXT into the public `_catalog` (a leak) and (b)
 * stripped from the encrypted payload. Binding the catalog subject to the
 * CG-identity the publisher already knows closes that — a forged marker on a
 * data entity now has a non-matching subject and stays on the encrypted path.
 *
 * Fail-safe and defense-in-depth: even on the genuine CG DID, a non-catalog
 * predicate, or an arbitrary `rdf:type` whose object is not a catalog class,
 * stays on the encrypted path. Order-preserving and total.
 *
 * @param quads          publish quads to partition.
 * @param catalogSubject the canonical CG DID; pass
 *   `contextGraphDataUri(contextGraphId)`. When empty/undefined, nothing is
 *   treated as catalog (every quad goes to `otherQuads` — fail-safe).
 */
export function partitionCatalogQuads<Q extends CatalogQuadLike>(
  quads: readonly Q[],
  catalogSubject: string,
): CatalogPartition<Q> {
  const catalogQuads: Q[] = [];
  const otherQuads: Q[] = [];
  for (const q of quads) {
    const isCatalog =
      // Identity gate: ONLY the canonical CG DID is a catalog subject — never a
      // forgeable type marker on a user-authored entity (round-3 SECURITY).
      catalogSubject.length > 0 &&
      q.subject === catalogSubject &&
      CATALOG_PREDICATES.has(q.predicate) &&
      // Object gate: an `rdf:type` is catalog only if it types the subject as an
      // allowed catalog class; any other type assertion is private data (B2).
      (q.predicate !== DKG_ONTOLOGY.RDF_TYPE || CATALOG_CLASSES.has(q.object));
    if (isCatalog) {
      catalogQuads.push(q);
    } else {
      otherQuads.push(q);
    }
  }
  return { catalogQuads, otherQuads };
}

/**
 * OT-RFC-49 / WS-D — POST-PUBLISH catalog stamps that MUST be excluded from the
 * committed/proven catalog leaf-set.
 *
 * `partitionCatalogQuads` recognizes these predicates (so the partition is total
 * and a stamp that somehow rides the publish payload is still routed to the
 * public `_catalog` rather than leaking onto the encrypted path), but they are
 * written into `<cg>/_catalog` only AFTER the on-chain publish confirms — e.g.
 * the agent's public projection back-references the on-chain VM merkleRoot via
 * `dkg:committedRoot` (a leaf cannot hash the root of the very set it belongs
 * to). Were they included in the producer's `computeCatalogRoot` input, the
 * publisher's committed root would diverge from the prover's rebuilt root the
 * instant the projection stamp lands, and curated proving would fail SILENTLY
 * every period.
 *
 * THE PARITY CONTRACT: the producer (publisher) and the prover's
 * `catalog-extractor` BOTH derive their leaf-set via {@link catalogCommittedLeaves}
 * (which strips this set), so the two sets are byte-identical by construction.
 *
 * Empirically observed delta (combined model): the only post-publish stamp the
 * projection path writes into `<cg>/_catalog` is `dkg:committedRoot`. In a
 * harness without the public-projection wired the delta is empty and the filter
 * is a no-op — but the shared-definition discipline still pins the two sides
 * together for any deployment that DOES project.
 */
export const CATALOG_COMMITTED_PREDICATES_TO_SKIP: ReadonlySet<string> =
  new Set<string>([
    DKG_ONTOLOGY.DKG_COMMITTED_ROOT, // post-publish on-chain-root back-reference
  ]);

/**
 * The catalog leaf-set the publisher COMMITS to and the prover PROVES, with the
 * post-publish stamps ({@link CATALOG_COMMITTED_PREDICATES_TO_SKIP}) removed.
 *
 * This is the SINGLE definition of the committed catalog set. BOTH off-chain
 * sites — the producer (`dkg-publisher` → `computeCatalogRoot`) and the prover's
 * `catalog-extractor` (rebuild over the locally-served `_catalog`) — MUST route
 * through it so the committed root and the proven root cannot drift.
 *
 * Returns `{subject,predicate,object}[]`; `computeCatalogRoot` / `V10MerkleTree`
 * sorts + dedupes internally, so order is irrelevant.
 */
export function catalogCommittedLeaves<Q extends CatalogQuadLike>(
  catalogQuads: readonly Q[],
): CatalogTriple[] {
  const leaves: CatalogTriple[] = [];
  for (const q of catalogQuads) {
    if (CATALOG_COMMITTED_PREDICATES_TO_SKIP.has(q.predicate)) continue;
    leaves.push({ subject: q.subject, predicate: q.predicate, object: q.object });
  }
  return leaves;
}
