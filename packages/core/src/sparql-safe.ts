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
 *
 * Handles `bigint` natively via `.toString()` to avoid precision loss
 * for values beyond `Number.MAX_SAFE_INTEGER`.
 */
// SPARQL STRING_LITERAL2: forbid raw CR/LF, only allow valid SPARQL escapes.
// BCP47 lang tags: primary subtag alpha-only, subsequent subtags alphanumeric (e.g. de-CH-1996).
// Datatype IRIs use the same safe-IRI character set as SAFE_RDF_IRI_TERM.
const SAFE_IRI_CHARS = '[^<>"{}|\\\\^`\\x00-\\x20>]';
const SAFE_RDF_LITERAL = new RegExp(
  `^"(?:[^"\\\\\\r\\n]|\\\\[tbnrf"'\\\\]|\\\\u[0-9a-fA-F]{4}|\\\\U[0-9a-fA-F]{8})*"` +
  `(?:@[A-Za-z]+(?:-[A-Za-z0-9]+)*|\\^\\^<${SAFE_IRI_CHARS}+>)?$`,
);
const SAFE_RDF_IRI_TERM = /^<[^<>"{}|\\^`\x00-\x20]+>$/;

/**
 * Validates a complete SPARQL RDF term — either a quoted literal
 * (with optional language tag or datatype) or an IRI in angle brackets.
 * Throws on anything that could break SPARQL syntax.
 *
 *     assertSafeRdfTerm('"hello"')           // ok
 *     assertSafeRdfTerm('"42"^^<xsd:int>')   // ok
 *     assertSafeRdfTerm('<http://ex.org/>')   // ok
 *     assertSafeRdfTerm('" } DROP ALL #')     // throws
 */
export function assertSafeRdfTerm(value: string): void {
  if (SAFE_RDF_LITERAL.test(value)) return;
  if (SAFE_RDF_IRI_TERM.test(value)) return;
  throw new Error(`Unsafe RDF term for CAS condition: ${value.slice(0, 80)}`);
}

export function sparqlInt(
  value: number | bigint,
  opts?: { min?: number; max?: number },
): string {
  if (typeof value === 'bigint') {
    if (opts?.min !== undefined && value < BigInt(opts.min)) {
      throw new Error(`SPARQL integer ${value} below minimum ${opts.min}`);
    }
    if (opts?.max !== undefined && value > BigInt(opts.max)) {
      throw new Error(`SPARQL integer ${value} above maximum ${opts.max}`);
    }
    return value.toString();
  }
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`Invalid SPARQL integer: ${value}`);
  }
  if (opts?.min !== undefined && value < opts.min) {
    throw new Error(`SPARQL integer ${value} below minimum ${opts.min}`);
  }
  if (opts?.max !== undefined && value > opts.max) {
    throw new Error(`SPARQL integer ${value} above maximum ${opts.max}`);
  }
  return String(value);
}
