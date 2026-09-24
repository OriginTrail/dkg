import { isAbsoluteRfc3987IriV1 } from './absolute-rfc3987-iri.js';
import { isRdfBlankNodeLabel } from './blank-node-label.js';

export { isAbsoluteRfc3987IriV1 };

/** N-Triples ECHAR short forms, keyed by the raw character. */
const RDF_LITERAL_SHORT_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
});

const RDF_LITERAL_ESCAPE_PATTERN = /["\\\u0000-\u001F\u007F]/g;

const NTRIPLES_ECHAR_VALUES: Readonly<Record<string, string>> = Object.freeze({
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  "'": "'",
  '\\': '\\',
});

export interface DecodeNTriplesUcharEscapesOptions {
  /** Preserve malformed or non-UCHAR backslash sequences instead of rejecting. */
  invalidEscape?: 'reject' | 'preserve';
  /**
   * `combine` accepts only scalar values and combines adjacent UTF-16 escape
   * pairs; `allow` preserves legacy isolated surrogate code units; `reject`
   * rejects every surrogate escape.
   */
  surrogatePolicy?: 'combine' | 'allow' | 'reject';
}

/**
 * Decode N-Triples UCHAR escapes (`\\uXXXX` and `\\UXXXXXXXX`) with an
 * explicit malformed-escape and surrogate policy. This is shared by RDF
 * parsers and consensus canonicalization so their Unicode state machines
 * cannot drift independently.
 */
export function decodeNTriplesUcharEscapes(
  value: string,
  options: DecodeNTriplesUcharEscapesOptions & { invalidEscape: 'preserve' },
): string;
export function decodeNTriplesUcharEscapes(
  value: string,
  options?: DecodeNTriplesUcharEscapesOptions,
): string | null;
export function decodeNTriplesUcharEscapes(
  value: string,
  options: DecodeNTriplesUcharEscapesOptions = {},
): string | null {
  if (!value.includes('\\')) return value;
  const preserveInvalid = options.invalidEscape === 'preserve';
  const surrogatePolicy = options.surrogatePolicy ?? 'reject';
  let decoded = '';

  for (let index = 0; index < value.length;) {
    if (value[index] !== '\\') {
      decoded += value[index];
      index += 1;
      continue;
    }
    const token = scanNTriplesEscape(value, index, surrogatePolicy, false);
    if (token.kind !== 'uchar') {
      if (!preserveInvalid) return null;
      decoded += value.slice(index, token.nextIndex);
      index = token.nextIndex;
      continue;
    }
    decoded += token.decoded;
    index = token.nextIndex;
  }
  return decoded;
}

/** Decode strict IRI-position UCHAR escapes, including Blazegraph short surrogate pairs. */
export function decodeNTriplesIriEscapesStrict(value: string): string | null {
  return decodeNTriplesUcharEscapes(value, { surrogatePolicy: 'combine' });
}

/** Preserve the deployed V10 datatype-IRI replacement behavior exactly. */
export function decodeNTriplesIriEscapesPreservingLegacy(value: string): string {
  return decodeNTriplesUcharEscapes(value, {
    invalidEscape: 'preserve',
    surrogatePolicy: 'allow',
  });
}

/**
 * Escape a plain-text string for use as an RDF/N-Triples literal body.
 * Returns only the escaped body; callers add the surrounding quotes.
 */
export function escapeRdfLiteral(value: string): string {
  return value.replace(RDF_LITERAL_ESCAPE_PATTERN, (character) => {
    const shortEscape = RDF_LITERAL_SHORT_ESCAPES[character];
    if (shortEscape !== undefined) return shortEscape;
    return `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

export type RdfLiteralTerm =
  | { kind: 'plain'; value: string }
  | { kind: 'language'; value: string; language: string }
  | { kind: 'typed'; value: string; datatype: string };

export const XSD_STRING_DATATYPE = 'http://www.w3.org/2001/XMLSchema#string';

export type RdfLiteralLexicalTerm =
  | { body: string; suffix: { kind: 'plain' } }
  | { body: string; suffix: { kind: 'language'; language: string } }
  | {
    body: string;
    suffix: { kind: 'datatype'; datatype: string; syntax: 'bracketed' | 'bare' };
  };

// This deliberately recognizes the broad literal boundary already accepted by
// the consensus canonicalizer, including its legacy bare-datatype form. Callers
// remain responsible for applying the narrower grammar their boundary requires.
const RDF_LITERAL_LEXICAL_PATTERN =
  /^"((?:[^"\\]|\\.)*)"(?:@([A-Za-z0-9-]+)|\^\^(?:<([^>]+)>|([^<].*)))?$/;
const RDF_LITERAL_BODY_PATTERN =
  /^(?:[^"\\\u0000-\u0008\u000A-\u001F\u007F]|\\(?:[tbnrf"'\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*$/;
const RDF_LANGUAGE_TAG_PATTERN = /^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/;

/**
 * Split the broad RDF literal lexical form shared by storage parsing and hash
 * canonicalization. This does not validate or decode the literal body.
 */
export function parseRdfLiteralLexicalTerm(term: string): RdfLiteralLexicalTerm | null {
  const match = RDF_LITERAL_LEXICAL_PATTERN.exec(term);
  if (!match) return null;
  if (match[2] !== undefined) {
    return { body: match[1], suffix: { kind: 'language', language: match[2] } };
  }
  if (match[3] !== undefined) {
    return {
      body: match[1],
      suffix: { kind: 'datatype', datatype: match[3], syntax: 'bracketed' },
    };
  }
  if (match[4] !== undefined) {
    return {
      body: match[1],
      suffix: { kind: 'datatype', datatype: match[4], syntax: 'bare' },
    };
  }
  return { body: match[1], suffix: { kind: 'plain' } };
}

/**
 * Serialize the canonical N-Triples-style literal used by DKG APIs.
 * `xsd:string` is intentionally canonicalized to the plain-literal form.
 */
export function formatCanonicalRdfLiteralTerm(term: RdfLiteralTerm): string {
  const escaped = escapeRdfLiteral(term.value);
  if (term.kind === 'language') return `"${escaped}"@${term.language}`;
  if (term.kind === 'typed' && term.datatype !== XSD_STRING_DATATYPE) {
    return `"${escaped}"^^<${term.datatype}>`;
  }
  return `"${escaped}"`;
}

/** The fields of an RDF/JS term (N3, Oxigraph) that its string form needs. */
export interface RdfJsTermLike {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}

/**
 * Render an RDF/JS term in the string form DKG quads use: a canonical literal
 * (see {@link formatCanonicalRdfLiteralTerm}), `_:label` for a blank node, and
 * the bare value otherwise (an IRI, or `''` for the default graph).
 */
export function formatCanonicalRdfTerm(term: RdfJsTermLike): string {
  if (term.termType === 'Literal') {
    if (term.language) {
      return formatCanonicalRdfLiteralTerm({ kind: 'language', value: term.value, language: term.language });
    }
    if (term.datatype) {
      return formatCanonicalRdfLiteralTerm({ kind: 'typed', value: term.value, datatype: term.datatype.value });
    }
    return formatCanonicalRdfLiteralTerm({ kind: 'plain', value: term.value });
  }
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  return term.value;
}

export interface DecodeRdfLiteralBodyOptions {
  /** Preserve malformed/unknown escapes instead of rejecting the body. */
  invalidEscape?: 'reject' | 'preserve';
  /** Permit UTF-16 surrogate code points for compatibility with legacy hash canonicalization. */
  allowSurrogateCodePoints?: boolean;
}

/**
 * Decode standard N-Triples literal escapes in one parity-safe pass.
 * Returns `null` for malformed escapes unless preservation is explicitly requested.
 */
export function decodeRdfLiteralBody(
  value: string,
  options: DecodeRdfLiteralBodyOptions & { invalidEscape: 'preserve' },
): string;
export function decodeRdfLiteralBody(
  value: string,
  options?: DecodeRdfLiteralBodyOptions,
): string | null;
export function decodeRdfLiteralBody(
  value: string,
  options: DecodeRdfLiteralBodyOptions = {},
): string | null {
  if (!value.includes('\\')) return value;

  const preserveInvalid = options.invalidEscape === 'preserve';
  let result = '';
  const surrogatePolicy = options.allowSurrogateCodePoints === true ? 'allow' : 'reject';
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character !== '\\') {
      result += character;
      index += 1;
      continue;
    }
    const token = scanNTriplesEscape(value, index, surrogatePolicy);
    if (token.kind === 'echar' || token.kind === 'uchar') {
      result += token.decoded;
      index = token.nextIndex;
      continue;
    }
    if (!preserveInvalid) return null;
    result += value.slice(index, token.nextIndex);
    index = token.nextIndex;
  }
  return result;
}

type NTriplesSurrogatePolicy = NonNullable<DecodeNTriplesUcharEscapesOptions['surrogatePolicy']>;

type NTriplesEscapeToken =
  | { readonly kind: 'echar' | 'uchar'; readonly decoded: string; readonly nextIndex: number }
  | { readonly kind: 'invalid'; readonly nextIndex: number };

/** One cursor owner for ECHAR/UCHAR width, hex, scalar, and surrogate handling. */
function scanNTriplesEscape(
  value: string,
  start: number,
  surrogatePolicy: NTriplesSurrogatePolicy,
  decodeEchar = true,
): NTriplesEscapeToken {
  const marker = value[start + 1];
  const echar = marker === undefined ? undefined : NTRIPLES_ECHAR_VALUES[marker];
  if (echar !== undefined) {
    // UCHAR-only legacy scans did not consume the second character of an ECHAR.
    // Advancing one byte preserves their overlapping-match behavior: in `\\u0041`
    // the first slash remains literal and the second begins the valid UCHAR.
    if (!decodeEchar) return { kind: 'invalid', nextIndex: start + 1 };
    return { kind: 'echar', decoded: echar, nextIndex: start + 2 };
  }
  const digits = marker === 'u' ? 4 : marker === 'U' ? 8 : 0;
  if (digits === 0) return { kind: 'invalid', nextIndex: start + 1 };

  const end = start + 2 + digits;
  const hex = value.slice(start + 2, end);
  if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) {
    // Consume only the slash. This exactly preserves the legacy regex scan:
    // a later valid escape overlapping a malformed prefix is still decoded.
    return { kind: 'invalid', nextIndex: start + 1 };
  }
  let codePoint = Number.parseInt(hex, 16);
  if (codePoint > 0x10ffff) return { kind: 'invalid', nextIndex: end };

  if (codePoint >= 0xd800 && codePoint <= 0xdbff && surrogatePolicy === 'combine') {
    // Long-form UCHAR represents a code point and can never encode a surrogate
    // half. Only Blazegraph's two adjacent short escapes are compatible here.
    if (marker !== 'u') return { kind: 'invalid', nextIndex: end };
    const lowStart = end;
    const lowHex = value.slice(lowStart + 2, lowStart + 6);
    if (
      value.slice(lowStart, lowStart + 2) !== '\\u'
      || lowHex.length !== 4
      || !/^[dD][c-fC-F][0-9A-Fa-f]{2}$/.test(lowHex)
    ) {
      return { kind: 'invalid', nextIndex: end };
    }
    const low = Number.parseInt(lowHex, 16);
    codePoint = 0x10000 + ((codePoint - 0xd800) * 0x400) + (low - 0xdc00);
    return { kind: 'uchar', decoded: String.fromCodePoint(codePoint), nextIndex: lowStart + 6 };
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff && surrogatePolicy !== 'allow') {
    return { kind: 'invalid', nextIndex: end };
  }
  return { kind: 'uchar', decoded: String.fromCodePoint(codePoint), nextIndex: end };
}

/**
 * The rules a literal must meet beyond the lexical split: which body
 * characters may appear raw, and whether the legacy bare-datatype suffix
 * (`"v"^^http://…`) is allowed.
 */
interface RdfLiteralGrammar {
  readonly body: RegExp;
  readonly bareDatatype: boolean;
}

/** The form {@link formatCanonicalRdfLiteralTerm} emits. */
const CANONICAL_RDF_LITERAL_GRAMMAR: RdfLiteralGrammar = {
  body: RDF_LITERAL_BODY_PATTERN,
  bareDatatype: false,
};

/**
 * What N-Quads STRING_LITERAL_QUOTE and SPARQL STRING_LITERAL2 accept
 * verbatim: only quotes, backslashes and line breaks must be escaped. DKG
 * clients still send the legacy bare-datatype suffix, which the stores bracket
 * on write.
 */
const WRITABLE_RDF_LITERAL_GRAMMAR: RdfLiteralGrammar = {
  body: /^(?:[^"\\\n\r]|\\(?:[tbnrf"'\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*$/,
  bareDatatype: true,
};

function parseRdfLiteralTermWith(
  term: string,
  grammar: RdfLiteralGrammar,
): RdfLiteralTerm | null {
  const lexical = parseRdfLiteralLexicalTerm(term);
  if (!lexical || !grammar.body.test(lexical.body)) return null;
  const value = decodeRdfLiteralBody(lexical.body);
  if (value === null) return null;
  if (lexical.suffix.kind === 'language') {
    if (!RDF_LANGUAGE_TAG_PATTERN.test(lexical.suffix.language)) return null;
    return { kind: 'language', value, language: lexical.suffix.language };
  }
  if (lexical.suffix.kind === 'datatype') {
    if (lexical.suffix.syntax !== 'bracketed' && !grammar.bareDatatype) return null;
    return { kind: 'typed', value, datatype: lexical.suffix.datatype };
  }
  return { kind: 'plain', value };
}

/** Parse the N-Triples-style literal term emitted by {@link formatCanonicalRdfLiteralTerm}. */
export function parseRdfLiteralTerm(term: string): RdfLiteralTerm | null {
  return parseRdfLiteralTermWith(term, CANONICAL_RDF_LITERAL_GRAMMAR);
}

/** A term of a quad written through a DKG write route, by kind. */
export type WritableRdfTerm =
  | { kind: 'iri'; value: string }
  | { kind: 'blank-node'; value: string }
  | { kind: 'literal'; value: RdfLiteralTerm };

/**
 * Parse one term of a quad written through a DKG write route, exactly as
 * sent: nothing is trimmed. It accepts
 * - an absolute RFC 3987 IRI, bare (`urn:x`) or in angle brackets (`<urn:x>`);
 *   `value` is the IRI without brackets;
 * - a blank node (`_:b0`) under the SPARQL 1.1 and N-Quads BLANK_NODE_LABEL
 *   grammar; `value` is the label without `_:`;
 * - a quoted literal that N-Quads and SPARQL store verbatim: plain,
 *   language-tagged, or typed with an absolute RFC 3987 datatype IRI, in angle
 *   brackets or in the legacy bare form. Raw control characters other than
 *   line breaks are allowed, as both grammars allow them.
 *
 * Anything else returns null, including a malformed or surrogate escape, a
 * relative datatype such as `<integer>`, and a malformed IRI such as
 * `https://example.org/%zz`, which the store would reject or rewrite.
 */
export function parseWritableRdfTerm(term: string): WritableRdfTerm | null {
  if (term.startsWith('"')) {
    const literal = parseRdfLiteralTermWith(term, WRITABLE_RDF_LITERAL_GRAMMAR);
    if (literal === null) return null;
    if (literal.kind === 'typed' && !isAbsoluteRfc3987IriV1(literal.datatype)) return null;
    return { kind: 'literal', value: literal };
  }
  if (term.startsWith('_:')) {
    const label = term.slice(2);
    return isRdfBlankNodeLabel(label) ? { kind: 'blank-node', value: label } : null;
  }
  const iri = term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term;
  return isAbsoluteRfc3987IriV1(iri) ? { kind: 'iri', value: iri } : null;
}

/** Return whether a string already represents an RDF term accepted by DKG publishers. */
export function isRdfTerm(value: string): boolean {
  return (
    /^(?:https?:\/\/|urn:|did:)/i.test(value) ||
    value.startsWith('_:') ||
    value.startsWith('"')
  );
}

/** Preserve RDF terms and quote/escape every other value as a plain literal. */
export function normalizeRdfObject(value: unknown): string {
  const raw = String(value ?? '');
  return isRdfTerm(raw) ? raw : `"${escapeRdfLiteral(raw)}"`;
}

export { isRdfBlankNodeLabel } from './blank-node-label.js';
