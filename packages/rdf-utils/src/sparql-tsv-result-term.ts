import { isAbsoluteRfc3987IriV1 } from './absolute-rfc3987-iri.js';
import {
  decodeNTriplesIriEscapesStrict,
  decodeRdfLiteralBody,
  type RdfLiteralTerm,
  type RdfTerm,
} from './rdf-term.js';
import {
  isRdfBlankNodeTerm,
  isRdfLanguageTag,
  parseRdfLiteralLexicalTermWith,
} from './rdf-term-lexical.js';

/** One semantic RDF term encoded in a SPARQL 1.1 TSV result cell. */
export type SparqlTsvResultTerm = RdfTerm;

const XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema#';
const SPARQL_TSV_INTEGER = /^[+-]?[0-9]+$/;
const SPARQL_TSV_DECIMAL = /^[+-]?(?:[0-9]*\.[0-9]+)$/;
const SPARQL_TSV_DOUBLE = /^[+-]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)[eE][+-]?[0-9]+|[0-9]+[eE][+-]?[0-9]+)$/;
const SPARQL_TSV_RAW_CONTROL_RANGE =
  `${String.fromCodePoint(0)}-${String.fromCodePoint(31)}${String.fromCodePoint(127)}`;
const SPARQL_TSV_FAST_PLAIN_LITERAL = new RegExp(
  `^"[^"\\\\${SPARQL_TSV_RAW_CONTROL_RANGE}]*"$`,
);

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
