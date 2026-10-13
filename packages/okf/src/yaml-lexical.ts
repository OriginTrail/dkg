/**
 * The text an unquoted YAML timestamp was written as.
 *
 * js-yaml turns an unquoted timestamp into a `Date`, which loses what the
 * producer wrote: `2026-06-15` and `2026-06-15T00:00:00Z` become the same
 * instant, an offset-less `2026-12-31T00:00:00` silently becomes UTC, and an
 * impossible `2026-02-30` rolls over to March. The OKF document schema
 * (`document.ts`) keeps an impossible value as the string it was, and attaches
 * the original text to every valid one here, so a timestamp is read the same
 * way whether or not it was quoted. No dependencies, so any module can read it.
 */

const LEXICAL = Symbol('okf.yamlTimestampLexical');

/** Attach `lexical` to `date`; JSON (a value kept verbatim as `rdf:JSON`) writes the original text too. */
export function withYamlLexical(date: Date, lexical: string): Date {
  Object.defineProperty(date, LEXICAL, { value: lexical });
  Object.defineProperty(date, 'toJSON', { value: () => lexical });
  return date;
}

/** The YAML text `value` was parsed from, when it is a timestamp the OKF schema parsed. */
export function yamlLexicalOf(value: unknown): string | undefined {
  return value instanceof Date ? (value as Date & { [LEXICAL]?: string })[LEXICAL] : undefined;
}
