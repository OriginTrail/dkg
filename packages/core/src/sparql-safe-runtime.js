// @ts-check

const IRI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`\x00-\x20]+$/;

/**
 * Returns true when the string is a syntactically safe IRI with a scheme
 * prefix (e.g. `did:dkg:...`, `http://...`, `urn:...`).
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isSafeIri(value) {
  if (!value) return false;
  return IRI_SCHEME_RE.test(value);
}

/**
 * Escapes a raw string for use inside a SPARQL `"..."` literal.
 * Handles all characters that the SPARQL grammar requires escaping
 * in short string literals (production rule [157] STRING_LITERAL2).
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeSparqlLiteral(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
