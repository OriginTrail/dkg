/**
 * SPARQL injection prevention utilities.
 *
 * Two complementary strategies:
 *
 * - **IRIs**: validate-and-reject. An IRI is either syntactically safe or
 *   it isn't — silently percent-encoding characters would change its meaning.
 *   Use `assertSafeIri` / `isSafeIri` / `sparqlIri`.
 *
 * - **String literals**: escape. The raw value is preserved but special
 *   characters are backslash-escaped per the SPARQL grammar.
 *   Use `escapeSparqlLiteral` / `sparqlString`.
 *
 * - **Integers**: validate type and optional bounds.
 *   Use `sparqlInt`.
 */

const UNSAFE_IRI_CHARS = /[<>"{}|\\^`\x00-\x20]/;

const IRI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`\x00-\x20]+$/;

/**
 * Throws if `value` contains characters that would break a SPARQL IRI (`<...>`).
 * Returns the value unchanged when safe, for ergonomic inline use:
 *
 *     `<${assertSafeIri(uri)}>`
 */
export function assertSafeIri(value: string): string {
  if (!value || UNSAFE_IRI_CHARS.test(value)) {
    throw new Error(`Unsafe or empty IRI value: ${value}`);
  }
  return value;
}

/**
 * Returns true when the string is a syntactically safe IRI with a scheme
 * prefix (e.g. `did:dkg:...`, `http://...`, `urn:...`).
 */
export function isSafeIri(value: string): boolean {
  if (!value) return false;
  return IRI_SCHEME_RE.test(value);
}

/**
 * Returns `<value>` after validating the IRI is safe for SPARQL interpolation.
 * Throws on unsafe input.
 */
export function sparqlIri(value: string): string {
  assertSafeIri(value);
  return `<${value}>`;
}

/**
 * Escapes a raw string for use inside a SPARQL `"..."` literal.
 * Handles all characters that the SPARQL grammar requires escaping
 * in short string literals (production rule [157] STRING_LITERAL2).
 */
export function escapeSparqlLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Returns `"escaped"` ready for SPARQL interpolation.
 */
export function sparqlString(value: string): string {
  return `"${escapeSparqlLiteral(value)}"`;
}

/**
 * Validates and returns a safe integer string for SPARQL LIMIT / OFFSET
 * and similar numeric contexts. Rejects NaN, Infinity, and non-integer values.
 */
export function sparqlInt(
  value: number | bigint,
  opts?: { min?: number; max?: number },
): string {
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid SPARQL integer: ${value}`);
  }
  if (opts?.min !== undefined && n < opts.min) {
    throw new Error(`SPARQL integer ${n} below minimum ${opts.min}`);
  }
  if (opts?.max !== undefined && n > opts.max) {
    throw new Error(`SPARQL integer ${n} above maximum ${opts.max}`);
  }
  return String(n);
}
