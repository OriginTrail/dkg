import {
  formatCanonicalRdfLiteralTerm,
  isAbsoluteRfc3987IriV1,
  parseRdfLiteralTerm,
} from '@origintrail-official/dkg-rdf-utils';
import type { Quad } from '@origintrail-official/dkg-storage';

/** Both callers project a single independently scoped graph to graphless triples. */
function tripleKey({ graph, subject, predicate, object }: Quad): string | undefined {
  if (graph !== '' || !isAbsoluteRfc3987IriV1(subject) || !isAbsoluteRfc3987IriV1(predicate)) return;
  if (!object.startsWith('"')) {
    if (!isAbsoluteRfc3987IriV1(object)) return;
    return JSON.stringify([subject, predicate, object]);
  }
  const term = parseRdfLiteralTerm(object);
  if (!term || (term.kind === 'typed' && !isAbsoluteRfc3987IriV1(term.datatype))) return;
  const canonical = term.kind === 'language' ? { ...term, language: term.language.toLowerCase() } : term;
  return JSON.stringify([subject, predicate, formatCanonicalRdfLiteralTerm(canonical)]);
}

export function samePublicRdfTriples(expected: readonly Quad[], observed: readonly Quad[]): boolean {
  if (expected.length !== observed.length) return false;
  const counts = new Map<string, number>();
  for (const quad of expected) {
    const key = tripleKey(quad);
    if (key === undefined) return false;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const quad of observed) {
    const key = tripleKey(quad);
    if (key === undefined) return false;
    const count = counts.get(key);
    if (count === undefined) return false;
    if (count === 1) counts.delete(key);
    else counts.set(key, count - 1);
  }
  return counts.size === 0;
}
