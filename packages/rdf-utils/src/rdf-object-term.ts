import { isAbsoluteRfc3987IriV1 } from './absolute-rfc3987-iri.js';
import { escapeRdfLiteral } from './rdf-literal-escape.js';
import {
  isRdfBlankNodeTerm,
  isRdfLanguageTag,
  parseRdfLiteralLexicalTerm,
} from './rdf-term-lexical.js';
import {
  decodeNTriplesIriEscapesStrict,
  decodeRdfLiteralBody,
  formatCanonicalRdfLiteralTerm,
  type RdfLiteralTerm,
  type RdfTerm,
} from './rdf-term.js';

// This deliberately recognizes the broad literal boundary already accepted by
// the consensus canonicalizer, including its legacy bare-datatype form. Callers
// remain responsible for applying the narrower grammar their boundary requires.
const RDF_LITERAL_BODY_PATTERN = new RegExp(
  String.raw`^(?:[^"\\\u0000-\u0008\u000A-\u001F\u007F]|\\(?:[tbnrf"'\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*$`,
);

interface RdfLiteralGrammar {
  readonly body: RegExp;
  readonly bareDatatype: boolean;
}

const CANONICAL_RDF_LITERAL_GRAMMAR: RdfLiteralGrammar = {
  body: RDF_LITERAL_BODY_PATTERN,
  bareDatatype: false,
};

const WRITABLE_RDF_LITERAL_GRAMMAR: RdfLiteralGrammar = {
  body: /^(?:[^"\\\n\r]|\\(?:[tbnrf"'\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*$/,
  bareDatatype: true,
};

function parseRdfLiteralTermWith(
  term: string,
  grammar: RdfLiteralGrammar,
  options: ParseRdfLiteralTermOptions = {},
): RdfLiteralTerm | null {
  const lexical = parseRdfLiteralLexicalTerm(term);
  if (!lexical || !grammar.body.test(lexical.body)) return null;
  const value = decodeRdfLiteralBody(lexical.body, {
    combineSurrogatePairs: options.combineSurrogatePairs === true,
  });
  if (value === null) return null;
  if (lexical.suffix.kind === 'language') {
    if (!isRdfLanguageTag(lexical.suffix.language)) return null;
    return { kind: 'language', value, language: lexical.suffix.language };
  }
  if (lexical.suffix.kind === 'datatype') {
    if (lexical.suffix.syntax !== 'bracketed' && !grammar.bareDatatype) return null;
    return { kind: 'typed', value, datatype: lexical.suffix.datatype };
  }
  return { kind: 'plain', value };
}

export interface ParseRdfLiteralTermOptions {
  /** See DecodeRdfLiteralBodyOptions.combineSurrogatePairs. */
  combineSurrogatePairs?: boolean;
}

/** Parse the N-Triples-style literal emitted by formatCanonicalRdfLiteralTerm. */
export function parseRdfLiteralTerm(
  term: string,
  options: ParseRdfLiteralTermOptions = {},
): RdfLiteralTerm | null {
  return parseRdfLiteralTermWith(term, CANONICAL_RDF_LITERAL_GRAMMAR, options);
}

/** Rewrite an N-Quads object term into the canonical store-result form. */
export function canonicalizeRdfObjectTerm(object: string): string {
  if (!object.startsWith('"')) return object;
  const literal = parseRdfLiteralTerm(object, { combineSurrogatePairs: true });
  if (!literal) return object;
  if (literal.kind !== 'typed' || !literal.datatype.includes('\\')) {
    return formatCanonicalRdfLiteralTerm(literal);
  }
  const datatype = decodeNTriplesIriEscapesStrict(literal.datatype);
  if (datatype === null || !isAbsoluteRfc3987IriV1(datatype)) return object;
  return formatCanonicalRdfLiteralTerm({ ...literal, datatype });
}

/** A term of a quad written through a DKG write route, by kind. */
export type WritableRdfTerm = RdfTerm;

/** Parse one term of a quad written through a DKG write route. */
export function parseWritableRdfTerm(term: string): WritableRdfTerm | null {
  if (term.startsWith('"')) {
    const literal = parseRdfLiteralTermWith(term, WRITABLE_RDF_LITERAL_GRAMMAR);
    if (literal === null) return null;
    if (literal.kind === 'typed' && !isAbsoluteRfc3987IriV1(literal.datatype)) return null;
    return { kind: 'literal', value: literal };
  }
  if (term.startsWith('_:')) {
    return isRdfBlankNodeTerm(term) ? { kind: 'blank-node', value: term.slice(2) } : null;
  }
  const iri = term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term;
  return isAbsoluteRfc3987IriV1(iri) ? { kind: 'iri', value: iri } : null;
}

/** Return whether a string already represents an RDF term accepted by DKG publishers. */
export function isRdfTerm(value: string): boolean {
  return (
    /^(?:https?:\/\/|urn:|did:)/i.test(value)
    || value.startsWith('_:')
    || value.startsWith('"')
  );
}

/** Preserve RDF terms and quote/escape every other value as a plain literal. */
export function normalizeRdfObject(value: unknown): string {
  const raw = String(value ?? '');
  return isRdfTerm(raw) ? raw : `"${escapeRdfLiteral(raw)}"`;
}
