/**
 * `generated`, the v0.1 `timestamp`, and the predicate they share (SPEC §5.2,
 * §13.1), owned here in both directions. Both give a concept's last-modified
 * time, on `schema:dateModified`: `generated.at` supersedes `timestamp` when it
 * gives a time, and the leftover `timestamp` is then a producer key
 * (`schema:timestamp`). A producer key named `dateModified` lands on
 * `schema:dateModified` too, so each value there names its owner with a
 * marker holding the same term: `generated.at` its own predicate
 * (`okf:generatedAt`), a producer value `okf:producerDateModified`. The legacy
 * `timestamp` is written unmarked, as the v0.1 mapper wrote it, and is named
 * (`okf:legacyTimestamp`) only where a producer value holds the same term.
 * The `generated` family's fields are the shared definitions in `specs.ts`;
 * what is decided here is which key owns which value: the mapper's quads for
 * each, the summary's last-modified time, whether `timestamp` is a producer
 * key (which export relies on), and how export gives each stored value back
 * to its key.
 */

import {
  OKF_GENERATED_AT,
  OKF_LEGACY_TIMESTAMP,
  OKF_PRODUCER_DATE_MODIFIED,
  RDF_JSON,
  SCHEMA_DATE_MODIFIED,
  XSD_DATE,
  XSD_DATE_TIME,
} from '../constants.js';
import { isStringLiteral, literalDatatype, orderKeys, termValue, type ExportContext } from '../decode-terms.js';
import { dateTerm, genericPredicate, genericQuads, valueToTerms } from '../terms.js';
import { dateTimeLexical } from '../timestamps.js';
import { dict, isBlank, isMapping } from '../utils.js';
import type { Quad } from '../types.js';
import { decodeMapping, keptVerbatim, type Read } from './decode-fields.js';
import { prepareFamily, type PreparedQuad } from './encode.js';
import { GENERATED } from './specs.js';

/**
 * `generated.at` when it gives a last-modified time, which then supersedes the
 * v0.1 `timestamp` (§13.1); a blank one is missing (§11) and does not.
 */
export function generatedAtOf(frontmatter: Record<string, unknown>): string | null {
  const at = isMapping(frontmatter.generated) ? frontmatter.generated.at : undefined;
  return isBlank(at) ? null : dateTimeLexical(at);
}

/** Whether the importer reads `timestamp` as a producer key: when a `generated.at` supersedes it. */
export function timestampIsProducerKey(frontmatter: Record<string, unknown>): boolean {
  return generatedAtOf(frontmatter) !== null;
}

/**
 * The quads of `generated` on the concept: the family's own (`at` on
 * `okf:generatedAt`), each `at` value copied to `schema:dateModified`, the
 * last-modified time to query.
 */
export function generatedQuads(iri: string, conceptId: string, value: unknown): PreparedQuad[] {
  return prepareFamily(iri, conceptId, GENERATED, value).flatMap((q) =>
    'kind' in q || q.predicate !== OKF_GENERATED_AT ? [q] : [q, { subject: q.subject, predicate: SCHEMA_DATE_MODIFIED, object: q.object }],
  );
}

/**
 * A producer key's quads (`schema:<camelKey>`, SPEC §4.1). One that lands on
 * `schema:dateModified` (`dateModified`, `date_modified`) names each value as
 * a producer's (`okf:producerDateModified`), since `generated.at` and the
 * legacy `timestamp` write that predicate too.
 */
export function producerQuads(iri: string, key: string, value: unknown): Quad[] {
  const quads = genericQuads(iri, key, value);
  if (genericPredicate(key) !== SCHEMA_DATE_MODIFIED) return quads;
  return quads.flatMap((q) => [q, { subject: iri, predicate: OKF_PRODUCER_DATE_MODIFIED, object: q.object }]);
}

/** The terms producer keys write to `schema:dateModified`: every key that camelCases to it is one (no base field or family does). */
function producerDateTerms(frontmatter: Record<string, unknown>): Set<string> {
  const terms = new Set<string>();
  for (const [key, value] of Object.entries(frontmatter)) {
    if (genericPredicate(key) === SCHEMA_DATE_MODIFIED) for (const term of valueToTerms(value)) terms.add(term);
  }
  return terms;
}

/**
 * The quads of the `timestamp` key on the concept `iri`: the legacy
 * last-modified time on `schema:dateModified`, or, when `generated.at`
 * supersedes it, a producer key, preserved as `schema:timestamp`. The legacy
 * time is unmarked, as the v0.1 mapper wrote it, unless a producer value
 * holds the same term: its marker would claim the one triple, so the
 * timestamp is named too.
 */
export function timestampQuads(iri: string, frontmatter: Record<string, unknown>, value: unknown): Quad[] {
  if (timestampIsProducerKey(frontmatter)) return genericQuads(iri, 'timestamp', value);
  const term = dateTerm(value);
  if (!term) return [];
  const quads: Quad[] = [{ subject: iri, predicate: SCHEMA_DATE_MODIFIED, object: term }];
  if (producerDateTerms(frontmatter).has(term)) quads.push({ subject: iri, predicate: OKF_LEGACY_TIMESTAMP, object: term });
  return quads;
}

/** The last-modified time a concept reports: `generated.at`, else the legacy `timestamp`. */
export function lastModifiedOf(frontmatter: Record<string, unknown>): string | null {
  return generatedAtOf(frontmatter) ?? dateTimeLexical(frontmatter.timestamp);
}

/**
 * Export: `generated` and the legacy `timestamp` from a concept's quads, and
 * the quads each was read from. Ownership is read, not inferred: `generated`
 * is its fields (`at` on `okf:generatedAt`), the timestamp an
 * `okf:legacyTimestamp` value, and each is read with its copy on
 * `schema:dateModified`, unless a producer value holds the same term
 * (`okf:producerDateModified`): that copy is left to the exporter, which
 * writes it back under the producer's key. Values no marker names are read
 * for compatibility (`readUnmarked`).
 */
export function decodeGenerated(conceptQuads: readonly Quad[], ctx: ExportContext): Array<[string, Read]> {
  const on = (predicate: string) => conceptQuads.filter((q) => q.predicate === predicate);
  const at = on(OKF_GENERATED_AT);
  const marked = on(OKF_LEGACY_TIMESTAMP);
  const producer = new Set(on(OKF_PRODUCER_DATE_MODIFIED).map((q) => q.object));
  const named = new Set([...producer, ...at.map((q) => q.object), ...marked.map((q) => q.object)]);
  const copies = on(SCHEMA_DATE_MODIFIED);
  const copiesOf = (term: string) => (producer.has(term) ? [] : copies.filter((q) => q.object === term));
  const unmarked = readUnmarked(copies.filter((q) => !named.has(q.object)), at, ctx);
  const out: Array<[string, Read]> = [];

  const mapping = decodeMapping(GENERATED, conceptQuads, ctx);
  const kept = mapping ? null : keptVerbatim(GENERATED, conceptQuads, ctx, 'concept');
  const keptAt = kept ? undefined : unmarked.at;
  if (kept) out.push([GENERATED.key, kept]);
  else if (mapping || keptAt) {
    const value = Object.assign(dict(), mapping?.value);
    if (keptAt) value.at = termValue(keptAt.object, ctx, 'date');
    const quads = [...(mapping?.quads ?? []), ...(keptAt ? [keptAt] : []), ...at.flatMap((q) => copiesOf(q.object))];
    out.push([GENERATED.key, { value: orderKeys(value, GENERATED.fields.map((f) => f.key)), quads }]);
  }

  const timestamp = last(marked) ?? unmarked.timestamp;
  if (timestamp) out.push(['timestamp', { value: termValue(timestamp.object, ctx, 'date'), quads: [...marked, ...copiesOf(timestamp.object)] }]);
  return out;
}

/**
 * Compatibility: the values on `schema:dateModified` no marker names. A graph
 * the mapper writes now leaves only the legacy `timestamp` unmarked; one
 * written before values were marked (by the v0.1 mapper, or before
 * `okf:generatedAt`) leaves `generated.at` and producer values unmarked too,
 * so their owners are inferred from what each can write:
 *
 *   - a non-empty `rdf:JSON` array is a `generated.at` kept verbatim, when no
 *     `okf:generatedAt` names one: a producer key's list is one triple per
 *     item, and the timestamp writes a time;
 *   - the legacy `timestamp` is never there beside a `generated.at` that gives
 *     a time (it supersedes it, §13.1); otherwise it is one of the terms its
 *     date encoder writes, the canonical last typed date, else the canonical
 *     last plain literal;
 *   - every other value is a producer value, left to the exporter.
 */
function readUnmarked(unmarked: readonly Quad[], at: readonly Quad[], ctx: ExportContext): { at?: Quad; timestamp?: Quad } {
  const timestamp = () => last(unmarked.filter((q) => isTypedDate(q.object))) ?? last(unmarked.filter((q) => isStringLiteral(q.object)));
  if (at.length > 0) return at.some((q) => literalDatatype(q.object) !== RDF_JSON) ? {} : { timestamp: timestamp() };
  return { at: last(unmarked.filter((q) => isNonEmptyList(q.object, ctx))), timestamp: timestamp() };
}

/** The last quad in canonical order, the one a single-valued field reads back. */
function last(quads: readonly Quad[]): Quad | undefined {
  return quads[quads.length - 1];
}

function isNonEmptyList(term: string, ctx: ExportContext): boolean {
  if (literalDatatype(term) !== RDF_JSON) return false;
  const value = termValue(term, ctx);
  return Array.isArray(value) && value.length > 0;
}

/** Whether a term is a typed xsd:dateTime / xsd:date literal, as the date encoder types a valid date. */
function isTypedDate(term: string): boolean {
  const datatype = literalDatatype(term);
  return datatype === XSD_DATE_TIME || datatype === XSD_DATE;
}
