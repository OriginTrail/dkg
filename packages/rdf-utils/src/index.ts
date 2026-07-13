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

export interface RdfLiteralBinding {
  value: string;
  language?: string;
  datatype?: string;
}

export interface SparqlJsonTerm {
  type: 'uri' | 'literal' | 'bnode' | 'typed-literal';
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LITERAL_TERM_PATTERN =
  /^"((?:[^"\\\u0000-\u0008\u000A-\u001F\u007F]|\\(?:[tbnrf"'\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*)"(?:@([A-Za-z]+(?:-[A-Za-z0-9]+)*)|\^\^<([^>]+)>)?$/;

/** Serialize an RDF literal binding as the N-Triples-style term used by DKG APIs. */
export function formatRdfLiteralTerm(term: RdfLiteralTerm): string {
  const escaped = escapeRdfLiteral(term.value);
  if (term.kind === 'language') return `"${escaped}"@${term.language}`;
  if (term.kind === 'typed' && term.datatype !== XSD_STRING) {
    return `"${escaped}"^^<${term.datatype}>`;
  }
  return `"${escaped}"`;
}

/** Serialize a SPARQL result binding without duplicating literal-kind policy in adapters. */
export function formatRdfLiteralBinding(binding: RdfLiteralBinding): string {
  if (binding.language) {
    return formatRdfLiteralTerm({
      kind: 'language',
      value: binding.value,
      language: binding.language,
    });
  }
  if (binding.datatype) {
    return formatRdfLiteralTerm({
      kind: 'typed',
      value: binding.value,
      datatype: binding.datatype,
    });
  }
  return formatRdfLiteralTerm({ kind: 'plain', value: binding.value });
}

/** Serialize one W3C SPARQL Results JSON term into the DKG API term format. */
export function formatSparqlJsonTerm(term: SparqlJsonTerm): string {
  if (term.type === 'bnode') return `_:${term.value}`;
  if (term.type === 'literal' || term.type === 'typed-literal') {
    return formatRdfLiteralBinding({
      value: term.value,
      language: term['xml:lang'],
      datatype: term.datatype,
    });
  }
  return term.value;
}

/**
 * Reverse {@link escapeRdfLiteral} and the standard N-Triples string escapes.
 * The single left-to-right pass preserves escape parity: `\\\\n` becomes a
 * literal backslash followed by `n`, rather than a newline.
 */
function decodeValidatedRdfLiteralBody(value: string): string {
  if (!value.includes('\\')) return value;

  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== '\\' || index + 1 >= value.length) {
      result += character;
      continue;
    }

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
        result += String.fromCodePoint(Number.parseInt(value.slice(index + 1, index + 5), 16));
        index += 4;
        break;
      case 'U':
        result += String.fromCodePoint(Number.parseInt(value.slice(index + 1, index + 9), 16));
        index += 8;
        break;
      default: result += escaped; break;
    }
  }
  return result;
}

/** Parse the N-Triples-style literal term emitted by {@link formatRdfLiteralTerm}. */
export function parseRdfLiteralTerm(term: string): RdfLiteralTerm | null {
  const match = term.match(RDF_LITERAL_TERM_PATTERN);
  if (!match) return null;

  let value: string;
  try {
    value = decodeValidatedRdfLiteralBody(match[1]);
  } catch {
    return null;
  }
  if (match[2]) return { kind: 'language', value, language: match[2] };
  if (match[3]) return { kind: 'typed', value, datatype: match[3] };
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
