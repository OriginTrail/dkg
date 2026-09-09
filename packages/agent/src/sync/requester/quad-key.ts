import type { Quad } from '@origintrail-official/dkg-storage';

/** Unambiguous value key for exact RDF quad set membership. */
export function canonicalQuadKey(quad: Quad): string {
  return JSON.stringify([quad.graph, quad.subject, quad.predicate, quad.object]);
}
