import type { Quad } from '@origintrail-official/dkg-storage';
import { skolemize, isSkolemizedUri, rootEntityFromSkolemized, isBlankNode } from './skolemize.js';

// The graph-scoped (rootless) KA canonicalization lives in its own module —
// it is a protocol-level boundary, not a variant of the legacy root-entity
// partitioning below. Re-exported here for callers that predate the split.
export {
  KNOWLEDGE_ASSET_SKOLEM_PREFIX,
  KNOWLEDGE_ASSET_PRIVATE_SKOLEM_PREFIX,
  assertNoUserAuthoredKnowledgeAssetSkolemTerms,
  skolemizeKnowledgeAsset,
  skolemizeKnowledgeAssetParts,
  type SkolemizeKnowledgeAssetOptions,
  type SkolemizedKnowledgeAssetParts,
} from './ka-skolemization.js';

/**
 * Skolemizes blank nodes under their parent entity and INDEXES the result by
 * entity. It does NOT partition into Knowledge Assets — the name `autoPartition`
 * was a misnomer that led readers (and patches) to treat the entity index as a
 * list of KAs (OT-RFC-44 §4 / OT-RFC-43 §10.4). Under Design B one file = one KA
 * whose member entities are exactly the keys of this map.
 *
 * 1. Identifies root entities (non-blank, non-skolemized subjects)
 * 2. Skolemizes blank nodes under their parent entity (`<entity>/.well-known/genid/N`)
 * 3. Groups triples by entity: skolemized children belong to the entity whose
 *    URI is their prefix
 *
 * The skolemization is load-bearing for consensus (canonical subject hashes for
 * the flat Merkle, validation, the SWM gather, and the RS prover); the grouping
 * is just an index. Returns a Map of entity → Quad[].
 */
export function skolemizeByEntity(quads: Quad[]): Map<string, Quad[]> {
  // Phase 1: Find root entities (non-blank, non-skolemized unique subjects)
  const rootEntities = new Set<string>();
  for (const q of quads) {
    if (!isBlankNode(q.subject) && !isSkolemizedUri(q.subject)) {
      rootEntities.add(q.subject);
    }
  }

  // Phase 2: Skolemize blank nodes under their parent root entity.
  // For each blank node, we need to determine which root entity it belongs to.
  // Heuristic: a blank node belongs to the root entity that references it as an object.
  const blankToRoot = new Map<string, string>();
  for (const q of quads) {
    if (rootEntities.has(q.subject) && isBlankNode(q.object)) {
      blankToRoot.set(q.object, q.subject);
    }
  }

  // Propagate: blank nodes referenced by other blank nodes
  let changed = true;
  while (changed) {
    changed = false;
    for (const q of quads) {
      if (
        isBlankNode(q.subject) &&
        blankToRoot.has(q.subject) &&
        isBlankNode(q.object) &&
        !blankToRoot.has(q.object)
      ) {
        blankToRoot.set(q.object, blankToRoot.get(q.subject)!);
        changed = true;
      }
    }
  }

  // Index in input order once, instead of filtering all quads for every root.
  // Root insertion order and the existing blank-node ownership rules are part
  // of the canonicalization contract.
  const rootQuadsMap = new Map<string, Quad[]>();
  for (const root of rootEntities) rootQuadsMap.set(root, []);
  for (const q of quads) {
    const root = rootEntities.has(q.subject)
      ? q.subject
      : isBlankNode(q.subject) ? blankToRoot.get(q.subject) : undefined;
    if (root !== undefined) rootQuadsMap.get(root)!.push(q);
  }
  for (const [root, rootQuads] of rootQuadsMap) {
    rootQuadsMap.set(root, skolemize(root, rootQuads));
  }

  // Also handle already-skolemized quads (no blank nodes)
  for (const q of quads) {
    if (isSkolemizedUri(q.subject)) {
      const root = rootEntityFromSkolemized(q.subject);
      if (root && rootQuadsMap.has(root)) {
        rootQuadsMap.get(root)!.push(q);
      }
    }
  }

  return rootQuadsMap;
}

/**
 * @deprecated Misnomer — this skolemizes and indexes by entity; it does not
 * partition into Knowledge Assets (OT-RFC-44 §4). Use {@link skolemizeByEntity}.
 * Kept as an alias for one release so external consumers (test fixtures,
 * scripts) can migrate; will be removed once no callers reference it.
 */
export const autoPartition = skolemizeByEntity;
