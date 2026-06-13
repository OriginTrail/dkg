// SPDX-License-Identifier: Apache-2.0
//
// OT-RFC-49 §4/§5.9 — combined-model catalog partition, in core so BOTH the
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
 */
export const CATALOG_PREDICATES: ReadonlySet<string> = new Set<string>([
  DKG_ONTOLOGY.RDF_TYPE,            // → dcat:Dataset / dkg:PrivateContextGraph
  DKG_ONTOLOGY.DCT_IDENTIFIER,
  DKG_ONTOLOGY.DCT_ACCESS_RIGHTS,
  DKG_ONTOLOGY.DCT_PUBLISHER,
  DKG_ONTOLOGY.DCAT_ACCESS_SERVICE,
  DKG_ONTOLOGY.DCT_CONFORMS_TO,
  DKG_ONTOLOGY.DKG_BLINDED_ANCHOR,
  DKG_ONTOLOGY.DKG_COMMITTED_ROOT, // separate-KA variant; harmless to recognize
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
 * subject AND its predicate is a catalog predicate. No external UAL needed, and
 * fail-safe — a user `rdf:type` on a data entity, or a non-catalog predicate on
 * the catalog subject, stays on the encrypted path. Order-preserving and total.
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
    if (catalogSubjects.has(q.subject) && CATALOG_PREDICATES.has(q.predicate)) {
      catalogQuads.push(q);
    } else {
      otherQuads.push(q);
    }
  }
  return { catalogQuads, otherQuads };
}
