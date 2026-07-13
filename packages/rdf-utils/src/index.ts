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
  options: DecodeRdfLiteralBodyOptions = {},
): string | null {
  if (!value.includes('\\')) return value;

  const preserveInvalid = options.invalidEscape === 'preserve';
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== '\\') {
      result += character;
      continue;
    }
    if (index + 1 >= value.length) return preserveInvalid ? `${result}\\` : null;

    const escaped = value[++index];
    switch (escaped) {
      case 'n': result += '\n'; break;
      case 'r': result += '\r'; break;
      case 't': result += '\t'; break;
      case 'b': result += '\b'; break;
      case 'f': result += '\f'; break;
      case '"': result += '"'; break;
      case "'": result += "'"; break;
      case '\\': result += '\\'; break;
      case 'u':
      case 'U': {
        const length = escaped === 'u' ? 4 : 8;
        const hex = value.slice(index + 1, index + 1 + length);
        if (hex.length !== length || !/^[0-9A-Fa-f]+$/.test(hex)) {
          if (!preserveInvalid) return null;
          result += `\\${escaped}`;
          break;
        }
        const decoded = decodeUnicodeCodePoint(hex, options.allowSurrogateCodePoints === true);
        if (decoded === null) {
          if (!preserveInvalid) return null;
          result += `\\${escaped}${hex}`;
        } else {
          result += decoded;
        }
        index += length;
        break;
      }
      default:
        if (!preserveInvalid) return null;
        result += `\\${escaped}`;
        break;
    }
  }
  return result;
}

function decodeUnicodeCodePoint(hex: string, allowSurrogates: boolean): string | null {
  const codePoint = Number.parseInt(hex, 16);
  if (codePoint > 0x10FFFF) return null;
  if (!allowSurrogates && codePoint >= 0xD800 && codePoint <= 0xDFFF) return null;
  return String.fromCodePoint(codePoint);
}

/** Parse the N-Triples-style literal term emitted by {@link formatCanonicalRdfLiteralTerm}. */
export function parseRdfLiteralTerm(term: string): RdfLiteralTerm | null {
  const lexical = parseRdfLiteralLexicalTerm(term);
  if (!lexical || !RDF_LITERAL_BODY_PATTERN.test(lexical.body)) return null;
  const value = decodeRdfLiteralBody(lexical.body);
  if (value === null) return null;
  if (lexical.suffix.kind === 'language') {
    if (!RDF_LANGUAGE_TAG_PATTERN.test(lexical.suffix.language)) return null;
    return { kind: 'language', value, language: lexical.suffix.language };
  }
  if (lexical.suffix.kind === 'datatype') {
    if (lexical.suffix.syntax !== 'bracketed') return null;
    return { kind: 'typed', value, datatype: lexical.suffix.datatype };
  }
  return { kind: 'plain', value };
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
