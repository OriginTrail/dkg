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

export interface RdfLiteralTermInput {
  value: string;
  language?: string;
  datatype?: string;
}

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

/** Serialize an RDF literal binding as the N-Triples-style term used by DKG APIs. */
export function formatRdfLiteralTerm({
  value,
  language,
  datatype,
}: RdfLiteralTermInput): string {
  const escaped = escapeRdfLiteral(value);
  if (language) return `"${escaped}"@${language}`;
  if (datatype && datatype !== XSD_STRING) return `"${escaped}"^^<${datatype}>`;
  return `"${escaped}"`;
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
