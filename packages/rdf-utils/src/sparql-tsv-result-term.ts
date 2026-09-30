import { isAbsoluteRfc3987IriV1 } from './absolute-rfc3987-iri.js';
import {
  decodeNTriplesIriEscapesStrict,
  decodeRdfLiteralBody,
  formatCanonicalRdfLiteralTerm,
  type RdfLiteralTerm,
  type RdfTerm,
} from './rdf-term.js';
import {
  isRdfBlankNodeTerm,
  isRdfLanguageTag,
  parseRdfLiteralLexicalTermWith,
} from './rdf-term-lexical.js';
import { readRawSparqlVariableNameEnd } from './sparql-lexical-primitives.js';

/** One semantic RDF term encoded in a SPARQL 1.1 TSV result cell. */
export type SparqlTsvResultTerm = RdfTerm;

/** Canonical store output plus the IRI metadata storage still must safety-check. */
export type CanonicalSparqlTsvResultTerm =
  | { readonly kind: 'iri'; readonly value: string }
  | { readonly kind: 'non-iri'; readonly value: string; readonly datatype?: string };

const XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema#';
const SPARQL_TSV_INTEGER = /^[+-]?[0-9]+$/;
const SPARQL_TSV_DECIMAL = /^[+-]?(?:[0-9]*\.[0-9]+)$/;
const SPARQL_TSV_DOUBLE = /^[+-]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)[eE][+-]?[0-9]+|[0-9]+[eE][+-]?[0-9]+)$/;
const SPARQL_TSV_RAW_CONTROL_RANGE =
  `${String.fromCodePoint(0)}-${String.fromCodePoint(31)}${String.fromCodePoint(127)}`;
const SPARQL_TSV_FAST_PLAIN_LITERAL = new RegExp(
  `^"[^"\\\\${SPARQL_TSV_RAW_CONTROL_RANGE}]*"$`,
);
const MAX_CACHED_IRI_COLUMNS = 128;
const MAX_CACHED_IRI_LENGTH = 1024;
const MAX_CONSECUTIVE_IRI_MISSES = 16;
const PAUSED_IRI_COMPARISON_ROWS = 128;

/** Parse one SPARQL TSV header cell under the complete `?VARNAME` grammar. */
export function parseSparqlTsvHeaderVariable(cell: string): string | null {
  if (cell[0] !== '?') return null;
  const end = readRawSparqlVariableNameEnd(cell, 1);
  return end === cell.length ? cell.slice(1) : null;
}

/**
 * Decode and canonicalize one TSV cell behind a single grammar boundary.
 * The value field is always the final public store spelling; datatype is only
 * validation metadata and never an alternative output representation.
 */
export function canonicalizeSparqlTsvResultTerm(
  term: string,
): CanonicalSparqlTsvResultTerm | null {
  return canonicalizeSparqlTsvResultTermWith(term, isAbsoluteRfc3987IriV1);
}

/** Request-local, bounded validation cache for multi-row TSV decoding. */
export class SparqlTsvResultTermCanonicalizer {
  private readonly iriValidators: Array<(value: string) => boolean>;

  constructor(variableCount: number, multipleRows: boolean) {
    const cachedColumns = multipleRows ? Math.min(variableCount, MAX_CACHED_IRI_COLUMNS) : 0;
    this.iriValidators = Array.from({ length: cachedColumns }, createCachedIriValidator);
  }

  canonicalize(term: string, column: number): CanonicalSparqlTsvResultTerm | null {
    return canonicalizeSparqlTsvResultTermWith(
      term,
      this.iriValidators[column] ?? isAbsoluteRfc3987IriV1,
    );
  }
}

function canonicalizeSparqlTsvResultTermWith(
  term: string,
  validateIri: (value: string) => boolean,
): CanonicalSparqlTsvResultTerm | null {
  if (SPARQL_TSV_FAST_PLAIN_LITERAL.test(term)) {
    return { kind: 'non-iri', value: term };
  }
  if (
    term.charCodeAt(0) === 60
    && term.charCodeAt(term.length - 1) === 62
    && !term.includes('\\')
  ) {
    const iri = term.slice(1, -1);
    return validateIri(iri) ? { kind: 'iri', value: iri } : null;
  }
  const parsed = parseSparqlTsvResultTerm(term);
  if (parsed === null) return null;
  if (parsed.kind === 'iri') return { kind: 'iri', value: parsed.value };
  if (parsed.kind === 'blank-node') {
    return { kind: 'non-iri', value: `_:${parsed.value}` };
  }
  return {
    kind: 'non-iri',
    value: formatCanonicalRdfLiteralTerm(parsed.value),
    ...(parsed.value.kind === 'typed' ? { datatype: parsed.value.datatype } : {}),
  };
}

function createCachedIriValidator(): (value: string) => boolean {
  let lastValidIri: string | undefined;
  let consecutiveMisses = 0;
  let pausedRows = 0;
  return value => {
    if (pausedRows > 0) {
      pausedRows -= 1;
      return isAbsoluteRfc3987IriV1(value);
    }
    if (value === lastValidIri) {
      consecutiveMisses = 0;
      return true;
    }
    const valid = isAbsoluteRfc3987IriV1(value);
    if (valid && value.length <= MAX_CACHED_IRI_LENGTH) lastValidIri = value;
    consecutiveMisses += 1;
    if (consecutiveMisses >= MAX_CONSECUTIVE_IRI_MISSES) {
      pausedRows = PAUSED_IRI_COMPARISON_ROWS;
      consecutiveMisses = 0;
      lastValidIri = undefined;
    }
    return valid;
  };
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
