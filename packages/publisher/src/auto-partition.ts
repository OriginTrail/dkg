import type { Quad } from '@origintrail-official/dkg-storage';
import { skolemize, isSkolemizedUri, rootEntityFromSkolemized, isBlankNode } from './skolemize.js';

/**
 * Auto-partitions quads into Knowledge Assets.
 *
 * 1. Identifies root entities (non-blank, non-skolemized subjects)
 * 2. Skolemizes blank nodes under their parent root entity
 * 3. Groups triples: each rootEntity defines a KA, skolemized children belong
 *    to the KA whose rootEntity is their URI prefix
 *
 * Returns a Map of rootEntity → Quad[].
 */
export function autoPartition(quads: Quad[]): Map<string, Quad[]> {
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

  // Skolemize per root entity
  const skolemized: Quad[] = [];
  const perRoot = new Map<string, Quad[]>();
  for (const root of rootEntities) {
    perRoot.set(root, []);
  }

  // Collect which quads belong to which root, skolemizing as we go
  const rootQuadsMap = new Map<string, Quad[]>();
  for (const root of rootEntities) {
    const rootQuads = quads.filter(
      (q) =>
        q.subject === root ||
        (isBlankNode(q.subject) && blankToRoot.get(q.subject) === root),
    );
    const sk = skolemize(root, rootQuads);
    rootQuadsMap.set(root, sk);
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
