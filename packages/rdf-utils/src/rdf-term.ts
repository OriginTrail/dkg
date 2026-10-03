import { escapeRdfLiteral } from './rdf-literal-escape.js';

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

export type RdfLiteralTerm =
  | { kind: 'plain'; value: string }
  | { kind: 'language'; value: string; language: string }
  | { kind: 'typed'; value: string; datatype: string };

/** Transport-neutral RDF term shared by result and writable-term boundaries. */
export type RdfTerm =
  | { kind: 'iri'; value: string }
  | { kind: 'blank-node'; value: string }
  | { kind: 'literal'; value: RdfLiteralTerm };

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

/** Decode N-Triples UCHAR escapes with an explicit malformed/surrogate policy. */
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

const XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema#';
export const XSD_STRING_DATATYPE = `${XSD_NAMESPACE}string`;

/** Serialize the canonical N-Triples-style literal used by DKG APIs. */
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

/** Render an RDF/JS term in the canonical string form used by DKG quads. */
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
  /** Permit UTF-16 surrogate code points for legacy hash compatibility. */
  allowSurrogateCodePoints?: boolean;
  /** Combine two adjacent short escapes that form one UTF-16 surrogate pair. */
  combineSurrogatePairs?: boolean;
}

/** Decode standard N-Triples literal escapes in one parity-safe pass. */
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
  const surrogatePolicy = options.allowSurrogateCodePoints === true
    ? 'allow'
    : options.combineSurrogatePairs === true ? 'combine' : 'reject';
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
    if (!decodeEchar) return { kind: 'invalid', nextIndex: start + 1 };
    return { kind: 'echar', decoded: echar, nextIndex: start + 2 };
  }
  const digits = marker === 'u' ? 4 : marker === 'U' ? 8 : 0;
  if (digits === 0) return { kind: 'invalid', nextIndex: start + 1 };

  const end = start + 2 + digits;
  const hex = value.slice(start + 2, end);
  if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) {
    return { kind: 'invalid', nextIndex: start + 1 };
  }
  let codePoint = Number.parseInt(hex, 16);
  if (codePoint > 0x10ffff) return { kind: 'invalid', nextIndex: end };

  if (codePoint >= 0xd800 && codePoint <= 0xdbff && surrogatePolicy === 'combine') {
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
