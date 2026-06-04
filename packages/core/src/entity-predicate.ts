/**
 * OT-RFC-43 §10.1 / OT-RFC-44 §4 — entity-list predicate rename migration.
 *
 * The predicates that hold an assertion's / KA's member entities were
 * misnamed: they carry graph ENTITIES, not Merkle roots.
 *
 *   dkg:rootEntity          ->  dkg:entity
 *   dkg:assertionRootEntity ->  dkg:assertionEntity
 *
 * This file defines the shared helpers for the dual-write + dual-read
 * migration. During the migration window, newly updated emitters write BOTH
 * the new and legacy predicate, and consumers that must be mixed-fleet safe
 * should read EITHER name (SPARQL alternation / `isEntityPredicate`). Some
 * runtime readers still resolve only the legacy name, so `dkg:entity`-only
 * metadata is not safe until the remaining consumer sweep has landed. In a
 * later release, once every node dual-reads, emitters stop writing the legacy
 * predicate; the dual-read is kept one more release, then dropped.
 *
 * IMPORTANT — de-dup: because both predicates are written with the SAME object
 * during the dual-write window, any SPARQL query that uses the alternation
 * fragments below returns each binding TWICE. Such queries MUST de-duplicate
 * (`SELECT DISTINCT …`, or `COUNT(DISTINCT ?x)`), otherwise they double-count
 * (e.g. the random-sampling leaf reconstruction would emit each root's leaves
 * twice and the proof would fail). The fragments are intentionally explicit so
 * call sites are forced to think about this.
 */

const DKG = 'http://dkg.io/ontology/';

export const DKG_ENTITY = `${DKG}entity`;
export const DKG_ROOT_ENTITY_LEGACY = `${DKG}rootEntity`;
export const DKG_ASSERTION_ENTITY = `${DKG}assertionEntity`;
export const DKG_ASSERTION_ROOT_ENTITY_LEGACY = `${DKG}assertionRootEntity`;

/**
 * SPARQL property-path alternation matching EITHER the new `dkg:entity` or the
 * legacy `dkg:rootEntity` predicate. De-dup at the call site (see file header).
 */
export const ENTITY_PRED_ALT = `(<${DKG_ROOT_ENTITY_LEGACY}>|<${DKG_ENTITY}>)`;

/** Same as {@link ENTITY_PRED_ALT} for the seal's `dkg:assertionEntity`. */
export const ASSERTION_ENTITY_PRED_ALT = `(<${DKG_ASSERTION_ROOT_ENTITY_LEGACY}>|<${DKG_ASSERTION_ENTITY}>)`;

/** True if `p` is either the new or legacy KA/share entity-member predicate. */
export function isEntityPredicate(p: string): boolean {
  return p === DKG_ENTITY || p === DKG_ROOT_ENTITY_LEGACY;
}

/** True if `p` is either the new or legacy assertion-seal entity predicate. */
export function isAssertionEntityPredicate(p: string): boolean {
  return p === DKG_ASSERTION_ENTITY || p === DKG_ASSERTION_ROOT_ENTITY_LEGACY;
}
