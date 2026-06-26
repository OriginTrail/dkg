import type { Quad } from '@origintrail-official/dkg-storage';

export const SKOLEMIZED_BLANK_NODE_SEGMENT = '/.well-known/genid/';

/**
 * Replaces blank node identifiers with deterministic URIs scoped under rootEntity.
 * Pattern: {rootEntity}/.well-known/genid/{label}
 *
 * Only replaces blank nodes (_:label) in subjects and objects.
 * Predicates are always URIs and never blank nodes.
 */
export function skolemize(rootEntity: string, quads: Quad[]): Quad[] {
  const blankNodes = new Set<string>();
  for (const q of quads) {
    if (isBlankNode(q.subject)) blankNodes.add(q.subject);
    if (isBlankNode(q.object)) blankNodes.add(q.object);
  }

  if (blankNodes.size === 0) return quads;

  const mapping = new Map<string, string>();
  for (const bn of blankNodes) {
    mapping.set(bn, skolemizedBlankNodeIri(rootEntity, bn));
  }

  return quads.map((q) => ({
    subject: mapping.get(q.subject) ?? q.subject,
    predicate: q.predicate,
    object: mapping.get(q.object) ?? q.object,
    graph: q.graph,
  }));
}

export function skolemizedBlankNodeIri(rootEntity: string, blankNode: string): string {
  const label = blankNode.startsWith('_:') ? blankNode.slice(2) : blankNode;
  return `${rootEntity}${SKOLEMIZED_BLANK_NODE_SEGMENT}${label}`;
}

export function isBlankNode(term: string): boolean {
  return term.startsWith('_:');
}

export function isSkolemizedUri(uri: string): boolean {
  return uri.includes(SKOLEMIZED_BLANK_NODE_SEGMENT);
}

/**
 * Extracts the rootEntity from a skolemized URI.
 * e.g., "did:dkg:agent:QmBot/.well-known/genid/o1" → "did:dkg:agent:QmBot"
 */
export function rootEntityFromSkolemized(uri: string): string | null {
  const idx = uri.indexOf(SKOLEMIZED_BLANK_NODE_SEGMENT);
  if (idx === -1) return null;
  return uri.slice(0, idx);
}
