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
 * Self-contained: a subject is a catalog subject iff it carries
 * `rdf:type dkg:PrivateContextGraph` in the set (the unambiguous system marker
 * the injection always emits); a quad is catalog iff its subject is a catalog
 * subject AND its predicate is a catalog predicate AND, for `rdf:type`, its
 * object is an allowed catalog class ({@link CATALOG_CLASSES}). No external UAL
 * needed, and fail-safe — a user `rdf:type` on a data entity, an arbitrary
 * `rdf:type` on the catalog subject itself, or a non-catalog predicate on the
 * catalog subject all stay on the encrypted path. Order-preserving and total.
 */
export function partitionCatalogQuads<Q extends CatalogQuadLike>(quads: readonly Q[]): CatalogPartition<Q> {
  const catalogSubjects = new Set<string>();
  for (const q of quads) {
    if (q.predicate === DKG_ONTOLOGY.RDF_TYPE && q.object === DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH) {
      catalogSubjects.add(q.subject);
    }
  }
  const catalogQuads: Q[] = [];
  const otherQuads: Q[] = [];
  for (const q of quads) {
    const isCatalog =
      catalogSubjects.has(q.subject) &&
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
