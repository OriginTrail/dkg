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

/**
 * Drop repeated quads, keeping the first occurrence (and so the emission
 * order). An RDF store holds a set: two identical triples are one triple, so a
 * mapper that emits a repeat (two `sources` naming the same resource → two
 * identical `prov:wasDerivedFrom` edges; `tags: [a, a]`) overstates what the
 * store will hold, and a completeness check built on that count can never pass.
 */
export function dedupeQuads<T extends { subject: string; predicate: string; object: string; graph?: string }>(
  quads: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const q of quads) {
    const key = `${q.subject}\u0000${q.predicate}\u0000${q.object}\u0000${q.graph ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/** A YAML mapping (not a list, not a Date). */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * `String(value)` that never throws. A YAML mapping can carry its own
 * `toString` key (`{ toString: x }`), and `String()` of such an object throws
 * because the key is not callable; one malformed optional field must not abort
 * a whole bundle. Every value `String()` handles is returned exactly as
 * `String()` returns it; the rest get the generic `[object Object]` form.
 */
export function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * A single YAML value: a string, number, boolean or timestamp — not a mapping
 * or a list. Family fields that hold one value check this before coercing.
 */
export function isScalar(value: unknown): value is string | number | boolean | bigint | Date {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value instanceof Date
  );
}

/** Absent, or a value whose string form is empty after trimming (the spec's "missing"). */
export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || safeString(value).trim() === '';
}

/**
 * Own-property check. Producer-defined keys are arbitrary strings, so `key in
 * obj` is wrong for them: `constructor`, `toString` and friends are inherited
 * by every plain object and would read as already present.
 */
export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Define `key` as an own, enumerable data property. Plain assignment would
 * run the `__proto__` setter for that key instead of storing it (silently
 * dropping the value); this stores every key, `__proto__` included.
 */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** `Object.assign` for arbitrary keys: copies every own enumerable key of `source` with `setOwn`. */
export function assignOwn(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) setOwn(target, key, source[key]);
}

/**
 * Distinct triples, first occurrence kept, the named graph ignored. A
 * graph-wide read returns the same triple once per named graph that holds it
 * (two sub-graphs of one Context Graph, say); for export that is one triple,
 * and decoding the repeat would invent an extra source, verification or
 * parameter.
 */
export function distinctTriples<T extends { subject: string; predicate: string; object: string }>(quads: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const q of quads) {
    const key = `${q.subject}\u0000${q.predicate}\u0000${q.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}
