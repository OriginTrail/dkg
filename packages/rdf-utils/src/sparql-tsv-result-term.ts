import { isAbsoluteRfc3987IriV1 } from './absolute-rfc3987-iri.js';
import { isRdfBlankNodeLabel } from './blank-node-label.js';
import {
  decodeNTriplesIriEscapesStrict,
  decodeRdfLiteralBody,
  type RdfLiteralTerm,
  type RdfTerm,
} from './rdf-term.js';
import {
  isRdfLanguageTag,
  parseRdfLiteralLexicalTermWith,
} from './rdf-term-lexical.js';
import { readRawSparqlVariableNameEnd } from './sparql-lexical-primitives.js';

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
/** Parse one SPARQL TSV header cell under the complete `?VARNAME` grammar. */
export function parseSparqlTsvHeaderVariable(cell: string): string | null {
  if (cell[0] !== '?') return null;
  const end = readRawSparqlVariableNameEnd(cell, 1);
  return end === cell.length ? cell.slice(1) : null;
}

/** Parse TSV syntax to a semantic term; callers may supply their IRI policy. */
export function parseSparqlTsvResultTerm(
  term: string,
  validateIri: (value: string) => boolean = isAbsoluteRfc3987IriV1,
): SparqlTsvResultTerm | null {
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
    return decoded !== null && validateIri(decoded)
      ? { kind: 'iri', value: decoded }
      : null;
  }
  if (term.startsWith('_:')) {
    const label = term.slice(2);
    return isRdfBlankNodeLabel(label) ? { kind: 'blank-node', value: label } : null;
  }
  const literal = parseSparqlTsvShortLiteral(term, validateIri);
  return literal === null ? null : { kind: 'literal', value: literal };
}

function parseSparqlTsvShortLiteral(
  term: string,
  validateIri: (value: string) => boolean,
): RdfLiteralTerm | null {
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
  return datatype !== null && validateIri(datatype)
    ? { kind: 'typed', value, datatype }
    : null;
}
