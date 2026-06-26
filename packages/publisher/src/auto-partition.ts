import type { Quad } from '@origintrail-official/dkg-storage';
import {
  isSkolemizedUri,
  rootEntityFromSkolemized,
  isBlankNode,
  skolemizedBlankNodeIri,
} from './skolemize.js';

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
  const skolemized = skolemizeFlatQuads(quads);
  const rootQuadsMap = new Map<string, Quad[]>();
  for (const quad of skolemized) {
    const root = rootForNonBlankSubject(quad.subject);
    if (!root) continue;
    const existing = rootQuadsMap.get(root);
    if (existing) existing.push(quad);
    else rootQuadsMap.set(root, [quad]);
  }
  return rootQuadsMap;
}

/**
 * Losslessly skolemizes blank-node subjects/objects using the root inferred from
 * the blank node itself, not from the currently visited edge. If a blank node is
 * shared by multiple roots, every object reference points at the deterministic
 * canonical generated IRI instead of manufacturing empty per-root generated nodes.
 */
export function skolemizeFlatQuads(quads: readonly Quad[]): Quad[] {
  const blankToRoot = inferBlankNodeRoots(quads);
  return quads.map((quad) => {
    const subjectRoot = rootForQuadSubject(quad.subject, blankToRoot);
    const objectRoot = isBlankNode(quad.object)
      ? blankToRoot.get(quad.object) ?? subjectRoot
      : undefined;
    return {
      subject: subjectRoot ? skolemizeTermForRoot(quad.subject, subjectRoot) : quad.subject,
      predicate: quad.predicate,
      object: objectRoot ? skolemizeTermForRoot(quad.object, objectRoot) : quad.object,
      graph: quad.graph,
    };
  });
}

function inferBlankNodeRoots(quads: readonly Quad[]): Map<string, string> {
  const blankRootCandidates = new Map<string, Set<string>>();
  for (const quad of quads) {
    const root = rootForNonBlankSubject(quad.subject);
    if (root && isBlankNode(quad.object)) {
      addRootCandidate(blankRootCandidates, quad.object, root);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const quad of quads) {
      if (!isBlankNode(quad.subject) || !isBlankNode(quad.object)) continue;
      const roots = blankRootCandidates.get(quad.subject);
      if (!roots) continue;
      for (const root of roots) {
        if (addRootCandidate(blankRootCandidates, quad.object, root)) {
          changed = true;
        }
      }
    }
  }

  const blankToRoot = new Map<string, string>();
  for (const [blankNode, roots] of blankRootCandidates) {
    const canonicalRoot = [...roots].sort()[0];
    if (canonicalRoot) blankToRoot.set(blankNode, canonicalRoot);
  }
  return blankToRoot;
}

function addRootCandidate(
  candidates: Map<string, Set<string>>,
  blankNode: string,
  root: string,
): boolean {
  const roots = candidates.get(blankNode);
  if (roots) {
    const size = roots.size;
    roots.add(root);
    return roots.size !== size;
  }
  candidates.set(blankNode, new Set([root]));
  return true;
}

function rootForQuadSubject(
  subject: string,
  blankToRoot: ReadonlyMap<string, string>,
): string | undefined {
  if (isBlankNode(subject)) return blankToRoot.get(subject);
  return rootForNonBlankSubject(subject);
}

function rootForNonBlankSubject(subject: string): string | undefined {
  if (isBlankNode(subject)) return undefined;
  if (isSkolemizedUri(subject)) return rootEntityFromSkolemized(subject) ?? undefined;
  return subject;
}

function skolemizeTermForRoot(term: string, root: string): string {
  return isBlankNode(term) ? skolemizedBlankNodeIri(root, term) : term;
}

/**
 * @deprecated Misnomer — this skolemizes and indexes by entity; it does not
 * partition into Knowledge Assets (OT-RFC-44 §4). Use {@link skolemizeByEntity}.
 * Kept as an alias for one release so external consumers (test fixtures,
 * scripts) can migrate; will be removed once no callers reference it.
 */
export const autoPartition = skolemizeByEntity;
