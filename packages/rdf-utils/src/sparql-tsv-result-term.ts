import { isAbsoluteRfc3987IriV1 } from './absolute-rfc3987-iri.js';
import {
  decodeNTriplesIriEscapesStrict,
  decodeRdfLiteralBody,
  type RdfLiteralTerm,
} from './index.js';
import {
  isRdfBlankNodeTerm,
  isRdfLanguageTag,
  parseRdfLiteralLexicalTermWith,
} from './rdf-term-lexical.js';

/** One RDF term encoded in a SPARQL 1.1 TSV result cell. */
export type SparqlTsvResultTerm =
  | { kind: 'iri'; value: string }
  | { kind: 'blank-node'; value: string }
  | { kind: 'literal'; value: RdfLiteralTerm };

/**
 * A canonical plain literal is already the final output and cannot diverge
 * from a parallel semantic term. Every other variant carries only the RDF
 * term that the shared storage normalizer validates and formats.
 */
export type NormalizedSparqlTsvResultTerm =
  | { readonly kind: 'canonical-plain-literal'; readonly value: string }
  | { readonly kind: 'term'; readonly value: SparqlTsvResultTerm };

const XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema#';
const SPARQL_TSV_INTEGER = /^[+-]?[0-9]+$/;
const SPARQL_TSV_DECIMAL = /^[+-]?(?:[0-9]*\.[0-9]+)$/;
const SPARQL_TSV_DOUBLE = /^[+-]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)[eE][+-]?[0-9]+|[0-9]+[eE][+-]?[0-9]+)$/;
const SPARQL_TSV_RAW_CONTROL_RANGE =
  `${String.fromCodePoint(0)}-${String.fromCodePoint(31)}${String.fromCodePoint(127)}`;
const SPARQL_TSV_FAST_PLAIN_LITERAL = new RegExp(
  `^"[^"\\\\${SPARQL_TSV_RAW_CONTROL_RANGE}]*"$`,
);

/**
 * Decode one SPARQL TSV cell. Dominant unescaped Oxigraph forms stay cheap,
 * while escaped and suffixed forms use the complete grammar below.
 */
export function normalizeSparqlTsvResultTerm(
  encoded: string,
): NormalizedSparqlTsvResultTerm | null {
  if (SPARQL_TSV_FAST_PLAIN_LITERAL.test(encoded)) {
    return { kind: 'canonical-plain-literal', value: encoded };
  }
  if (
    encoded.charCodeAt(0) === 60
    && encoded.charCodeAt(encoded.length - 1) === 62
    && !encoded.includes('\\')
  ) {
    // The storage result normalizer applies the endpoint's stricter safe-IRI
    // policy exactly once. The public parser below still performs RFC 3987
    // validation when this transport-neutral fast path is not in use.
    return { kind: 'term', value: { kind: 'iri', value: encoded.slice(1, -1) } };
  }
  const term = parseSparqlTsvResultTerm(encoded);
  return term === null ? null : { kind: 'term', value: term };
}

/** Parse the complete RDF-term grammar used by SPARQL 1.1 TSV cells. */
export function parseSparqlTsvResultTerm(term: string): SparqlTsvResultTerm | null {
  if (SPARQL_TSV_FAST_PLAIN_LITERAL.test(term)) {
    return { kind: 'literal', value: { kind: 'plain', value: term.slice(1, -1) } };
  }
  if (term === 'true' || term === 'false') {
    return {
      kind: 'literal',
      value: { kind: 'typed', value: term, datatype: `${XSD_NAMESPACE}boolean` },
    };
  }
  const numericDatatype = SPARQL_TSV_INTEGER.test(term)
    ? 'integer'
    : SPARQL_TSV_DECIMAL.test(term)
      ? 'decimal'
      : SPARQL_TSV_DOUBLE.test(term)
        ? 'double'
        : undefined;
  if (numericDatatype) {
    return {
      kind: 'literal',
      value: { kind: 'typed', value: term, datatype: `${XSD_NAMESPACE}${numericDatatype}` },
    };
  }
  if (term.startsWith('<') && term.endsWith('>')) {
    const encoded = term.slice(1, -1);
    const decoded = encoded.includes('\\')
      ? decodeNTriplesIriEscapesStrict(encoded)
      : encoded;
    return decoded !== null && isAbsoluteRfc3987IriV1(decoded)
      ? { kind: 'iri', value: decoded }
      : null;
  }
  if (term.startsWith('_:')) {
    return isRdfBlankNodeTerm(term)
      ? { kind: 'blank-node', value: term.slice(2) }
      : null;
  }
  const literal = parseSparqlTsvShortLiteral(term);
  return literal === null ? null : { kind: 'literal', value: literal };
}

function parseSparqlTsvShortLiteral(term: string): RdfLiteralTerm | null {
  const lexical = parseRdfLiteralLexicalTermWith(term, true);
  if (!lexical || lexical.body.includes('\n') || lexical.body.includes('\r')) return null;
  const value = decodeRdfLiteralBody(lexical.body, { combineSurrogatePairs: true });
  if (value === null) return null;
  if (lexical.suffix.kind === 'plain') return { kind: 'plain', value };
  if (lexical.suffix.kind === 'language') {
    return isRdfLanguageTag(lexical.suffix.language)
      ? { kind: 'language', value, language: lexical.suffix.language }
      : null;
  }
  if (lexical.suffix.syntax !== 'bracketed') return null;
  const datatype = decodeNTriplesIriEscapesStrict(lexical.suffix.datatype);
  return datatype !== null && isAbsoluteRfc3987IriV1(datatype)
    ? { kind: 'typed', value, datatype }
    : null;
}
