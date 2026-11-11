import { Parser } from 'n3';
import { canonicalizeExactStoreDateTime, sparqlIri } from '@origintrail-official/dkg-core';
type Triple = { subject: string; predicate: string; object: string };
export function exactStoredTripleKey(q: Triple): string {
  const [parsed] = new Parser({ format: 'N-Triples' }).parse(
    `${sparqlIri(q.subject)} ${sparqlIri(q.predicate)} ${q.object.startsWith('"') ? q.object : sparqlIri(q.object)} .`);
  const term = parsed.object;
  // Journals retain typed timestamp spellings, while stores can trim zeroes or
  // spell the same timezone differently. Compare exact values on BOTH sides so
  // old journals recover without rewriting them or reissuing guest effects.
  // The hash canonicalizer truncates submilliseconds and is unsafe here.
  const value = term.termType === 'Literal' && term.datatype.value === 'http://www.w3.org/2001/XMLSchema#dateTime'
    ? canonicalizeExactStoreDateTime(term.value) ?? term.value
    : term.value;
  return JSON.stringify([parsed.subject.value, parsed.predicate.value, term.termType, value,
    term.termType === 'Literal' ? term.language.toLowerCase() : '', term.termType === 'Literal' ? term.datatype.value : '']);
}
