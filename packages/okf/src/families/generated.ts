/**
 * `generated` and the v0.1 `timestamp`: one compatibility rule (SPEC §5.2,
 * §13.1), owned here in both directions. Both give a concept's last-modified
 * time, on `schema:dateModified`: `generated.at` supersedes `timestamp` when it
 * gives a time, and the leftover `timestamp` is then a producer key
 * (`schema:timestamp`). The `generated` family's fields are the shared
 * definitions in `specs.ts`; what is decided here is which key owns which
 * value: the mapper's `timestamp` triples, the summary's last-modified time,
 * whether `timestamp` is a producer key (which export relies on), and how
 * export gives each stored value back to its key.
 */

import { RDF_JSON, SCHEMA_DATE_MODIFIED, XSD_DATE, XSD_DATE_TIME } from '../constants.js';
import { literalDatatype, orderKeys, termValue, type ExportContext } from '../decode-terms.js';
import { dateTerm, genericPredicate, genericQuads } from '../terms.js';
import { dateTimeLexical } from '../timestamps.js';
import { isBlank, isMapping } from '../utils.js';
import type { Quad } from '../types.js';
import { decodeFields, keptVerbatim, type Read } from './decode-fields.js';
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
 * The quads of the `timestamp` key on the concept `iri`: the legacy
 * last-modified time on `schema:dateModified`, or, when `generated.at`
 * supersedes it, a producer key, preserved as `schema:timestamp`.
 */
export function timestampQuads(iri: string, frontmatter: Record<string, unknown>, value: unknown): Quad[] {
  if (timestampIsProducerKey(frontmatter)) return genericQuads(iri, 'timestamp', value);
  const term = dateTerm(value);
  return term ? [{ subject: iri, predicate: SCHEMA_DATE_MODIFIED, object: term }] : [];
}

/** The last-modified time a concept reports: `generated.at`, else the legacy `timestamp`. */
export function lastModifiedOf(frontmatter: Record<string, unknown>): string | null {
  return generatedAtOf(frontmatter) ?? dateTimeLexical(frontmatter.timestamp);
}

/**
 * Export: `generated` and the legacy `timestamp` from a concept's quads, and
 * the quads each was read from. `schema:dateModified` can hold three kinds of
 * value: `generated.at`, the legacy `timestamp` (written there when no
 * `generated.at` gives a time), and a producer key named `dateModified`. The
 * codec claims at most one value for `generated.at` and one for `timestamp`;
 * every other value stays a producer value, which the exporter writes back.
 *
 *   - A `generated` value kept verbatim (its ownership marker) was no mapping,
 *     so it has no `at`: a date there is the legacy `timestamp` (which types
 *     its date), and anything else a producer value.
 *   - Otherwise `generated` is there with its actor (`by`, or an extension),
 *     or with an `at` kept verbatim (an `rdf:JSON` value: a mapping or list
 *     where one time belongs); a time beside such an `at` is the legacy
 *     `timestamp`'s.
 *   - A lone time is `generated.at` when `generated` is there, or when the
 *     concept keeps a producer `timestamp` (`schema:timestamp`), which only a
 *     `generated.at` makes; else it is the legacy `timestamp` (a v0.1
 *     last-modified time).
 */
export function decodeGenerated(conceptQuads: readonly Quad[], ctx: ExportContext): Array<[string, Read]> {
  const decoded = decodeFields(GENERATED, conceptQuads, ctx);
  const own = decoded.quads.filter((q) => q.predicate !== SCHEMA_DATE_MODIFIED);
  const dates = decoded.quads.filter((q) => q.predicate === SCHEMA_DATE_MODIFIED);
  const json = dates.filter((q) => literalDatatype(q.object) === RDF_JSON);
  const times = dates.filter((q) => literalDatatype(q.object) !== RDF_JSON);
  const present = 'by' in decoded.fields || Object.keys(decoded.extensions).length > 0;
  const out: Array<[string, Read]> = [];
  const timestamp = (q: Quad | undefined) => {
    if (q) out.push(['timestamp', { value: termValue(q.object, ctx, 'date'), quads: [q] }]);
  };

  const verbatim = present ? null : keptVerbatim(GENERATED, conceptQuads, ctx, 'concept');
  if (verbatim) {
    out.push([GENERATED.key, verbatim]);
    timestamp(last(times.filter((q) => isTypedDate(q.object))));
    return out;
  }

  // A producer key never yields a non-empty `rdf:JSON` array (its list is one
  // triple per item), so such an array is `generated.at`'s; a JSON mapping
  // could be either, and then reads canonically.
  const keptAt = last(json.filter((q) => isNonEmptyList(termValue(q.object, ctx)))) ?? last(json);
  const producerTimestamp = conceptQuads.some((q) => q.predicate === genericPredicate('timestamp'));
  const at = keptAt ?? (present || producerTimestamp ? last(times) : undefined);
  if (present || at) {
    const read = at ? [...own, at] : own;
    out.push([GENERATED.key, { value: orderKeys(decodeFields(GENERATED, read, ctx).value, GENERATED.fields.map((f) => f.key)), quads: read }]);
  }
  timestamp(at === undefined || keptAt ? last(times) : undefined);
  return out;
}

/** The last quad in canonical order, the one a single-valued field reads back. */
function last(quads: readonly Quad[]): Quad | undefined {
  return quads[quads.length - 1];
}

function isNonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Whether a term is a typed xsd:dateTime / xsd:date literal, as the legacy `timestamp` maps a date. */
function isTypedDate(term: string): boolean {
  const datatype = literalDatatype(term);
  return datatype === XSD_DATE_TIME || datatype === XSD_DATE;
}

