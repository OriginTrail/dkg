/**
 * Small helpers shared by the mapper.
 *
 * Literal terms are written in the DKG's canonical RDF literal form, by the
 * shared formatter in `dkg-rdf-utils` (a dependency-free leaf package), so the
 * quads the mapper emits are the ones the stores return, and export reads both
 * with the same parser. `isSafeIri` is replicated verbatim from `dkg-core`'s
 * `sparql-safe.ts`, so the package never imports the node at runtime and stays
 * unit-testable in isolation. A test pins it against the inputs the node
 * validates.
 */

import { formatCanonicalRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { yamlLexicalOf } from './yaml-lexical.js';

const IRI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`\x00-\x20]+$/;

/** True when the string is a syntactically safe IRI with a scheme prefix. */
export function isSafeIri(value: string): boolean {
  if (!value) return false;
  return IRI_SCHEME_RE.test(value);
}

/** N-Triples/quad-encoding of a plain string literal: `"escaped"`, in the canonical form. */
export function literalTerm(value: string): string {
  return formatCanonicalRdfLiteralTerm({ kind: 'plain', value });
}

/** N-Triples/quad-encoding of a typed literal: `"lexical"^^<datatype>`, in the canonical form. */
export function typedLiteralTerm(lexical: string, datatypeIri: string): string {
  return formatCanonicalRdfLiteralTerm({ kind: 'typed', value: lexical, datatype: datatypeIri });
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
  // An unquoted YAML timestamp reads as the text it was written as, not as
  // `Date#toString()`, whose output depends on the machine's time zone.
  const lexical = yamlLexicalOf(value);
  if (lexical !== undefined) return lexical;
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
 * An empty dictionary for arbitrary string keys. Producer-defined keys are
 * arbitrary, and a plain object gets them wrong: it inherits `constructor`,
 * `toString` and friends, and assigning `__proto__` runs a setter instead of
 * storing the key. A dictionary has no prototype, so every key is an ordinary
 * own property, read and written with plain `obj[key]`, `key in obj` and
 * `Object.assign` into it. Every accumulator of arbitrary keys is one.
 */
export function dict<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
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
