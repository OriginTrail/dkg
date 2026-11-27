import {
  decodeNTriplesIriEscapesPreservingLegacy,
  decodeRdfLiteralBody,
  parseRdfLiteralLexicalTerm,
  XSD_STRING_DATATYPE,
} from '@origintrail-official/dkg-rdf-utils';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NUMERIC_TYPES = new Set([
  'integer', 'int', 'long', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger',
  'nonPositiveInteger', 'negativeInteger', 'unsignedLong', 'unsignedInt',
  'unsignedShort', 'unsignedByte', 'decimal', 'float', 'double',
]);

/**
 * Conservative collision buckets for Blazegraph's native staging count guard.
 * Equal buckets are potentially equal stored terms, not a canonical RDF value.
 * Distinct wire triples in one bucket select SPARQL before upload. Numeric
 * precision loss may conservatively select fallback; it never rewrites data.
 * Other XSD value types (dates, durations, binary, etc.) share a datatype bucket
 * because their backend-specific cardinality is not modeled here. A single
 * such value per subject/predicate remains eligible for native upload.
 * This storage policy is deliberately independent of the V10 Merkle contract.
 */
export function blazegraphStagingObjectBucket(term: string): string {
  const literal = parseRdfLiteralLexicalTerm(term);
  if (!literal) return JSON.stringify(['term', decodeNTriplesIriEscapesPreservingLegacy(term)]);
  const value = decodeRdfLiteralBody(literal.body, {
    invalidEscape: 'preserve', combineSurrogatePairs: true,
  });
  if (literal.suffix.kind === 'language') {
    return JSON.stringify(['language', literal.suffix.language.toLowerCase(), value]);
  }
  const datatype = literal.suffix.kind === 'datatype'
    ? decodeNTriplesIriEscapesPreservingLegacy(literal.suffix.datatype) : XSD_STRING_DATATYPE;
  if (datatype === XSD_STRING_DATATYPE) return JSON.stringify(['string', value]);
  if (datatype.startsWith(XSD)) {
    const type = datatype.slice(XSD.length);
    if (NUMERIC_TYPES.has(type)) {
      const lexical = value.trim();
      const number = lexical === 'INF' ? Infinity : lexical === '-INF' ? -Infinity : Number(lexical);
      return JSON.stringify(['number', String(type === 'float' ? Math.fround(number) : number)]);
    }
    if (type === 'boolean') {
      const normalized = value.trim();
      return JSON.stringify(['boolean', normalized === '1' || normalized === 'true' ? true
        : normalized === '0' || normalized === 'false' ? false : normalized]);
    }
    return JSON.stringify(['xsd-value', datatype]);
  }
  return JSON.stringify(['typed', datatype, value]);
}
