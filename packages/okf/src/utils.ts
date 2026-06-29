/**
 * Small, dependency-free helpers shared by the mapper.
 *
 * `isSafeIri` is replicated verbatim from `dkg-core`'s `sparql-safe.ts` so the
 * pure mapper has zero runtime cross-package dependency and stays unit-testable
 * in isolation (the package intentionally does not import the node at runtime).
 * A test pins the behaviour against the same inputs the node validates.
 */

const IRI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`\x00-\x20]+$/;

/** True when the string is a syntactically safe IRI with a scheme prefix. */
export function isSafeIri(value: string): boolean {
  if (!value) return false;
  return IRI_SCHEME_RE.test(value);
}

/** N-Triples/quad-encoding of a plain string literal: `"escaped"`. */
export function literalTerm(value: string): string {
  return JSON.stringify(value);
}

/** N-Triples/quad-encoding of a typed literal: `"lexical"^^<datatype>`. */
export function typedLiteralTerm(lexical: string, datatypeIri: string): string {
  return `${JSON.stringify(lexical)}^^<${datatypeIri}>`;
}

/**
 * `BigQuery Dataset` → `BigQueryDataset`. Splits on any non-alphanumeric run and
 * upper-cases the first letter of each word, preserving existing inner case.
 */
export function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * `release date` → `releaseDate`, `custom_field` → `customField`. camelCase used
 * for producer-defined frontmatter keys (converges with the extractor's handling).
 */
export function camelCase(value: string): string {
  const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'property';
  return parts
    .map((p, i) =>
      i === 0
        ? p.charAt(0).toLowerCase() + p.slice(1)
        : p.charAt(0).toUpperCase() + p.slice(1),
    )
    .join('');
}

/** Stable blank-node label fragment from an arbitrary concept ID. */
export function sanitizeForBlank(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '_');
}
