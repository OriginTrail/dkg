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

import { RDF_JSON, SCHEMA_DATE_MODIFIED } from '../constants.js';
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
 * the quads each was read from. `generated` needs its actor (§5.2): it is
 * there with a `by` or an extension. Its `at` shares `schema:dateModified`
 * with a legacy `timestamp` the importer writes when no `generated.at` gives a
 * time, and the two are told apart triple by triple:
 *
 *   - an `rdf:JSON` value is one `generated.at` kept verbatim (a mapping or
 *     list where one time belongs), which a `timestamp` could not carry: it is
 *     `generated`'s, and a time beside it is the `timestamp`'s;
 *   - otherwise a time is `generated.at` when `generated` is there, or when
 *     the concept keeps a producer `timestamp` (`schema:timestamp`), which only
 *     a `generated.at` makes; else it is the legacy `timestamp` (a v0.1
 *     last-modified time).
 *
 * A `generated` value of the wrong shape, kept verbatim, comes back as itself.
 */
export function decodeGenerated(conceptQuads: readonly Quad[], ctx: ExportContext): Array<[string, Read]> {
  const decoded = decodeFields(GENERATED, conceptQuads, ctx);
  const atQuads = decoded.quads.filter((q) => q.predicate === SCHEMA_DATE_MODIFIED);
  const kept = atQuads.filter((q) => literalDatatype(q.object) === RDF_JSON);
  const times = atQuads.filter((q) => literalDatatype(q.object) !== RDF_JSON);
  const present = 'by' in decoded.fields || Object.keys(decoded.extensions).length > 0;
  const producerTimestamp = conceptQuads.some((q) => q.predicate === genericPredicate('timestamp'));
  const generatedTimes = kept.length === 0 && (present || producerTimestamp);
  const timestampQuadsRead = generatedTimes ? [] : times;
  const generatedQuads = decoded.quads.filter((q) => !timestampQuadsRead.includes(q));
  const out: Array<[string, Read]> = [];
  if (generatedQuads.length > 0 && (present || kept.length > 0 || generatedTimes)) {
    const generated = decodeFields(GENERATED, generatedQuads, ctx);
    out.push([GENERATED.key, { value: orderKeys(generated.value, GENERATED.fields.map((f) => f.key)), quads: generatedQuads }]);
  } else {
    const verbatim = keptVerbatim(GENERATED, conceptQuads, ctx, 'concept');
    if (verbatim) out.push([GENERATED.key, verbatim]);
  }
  const last = timestampQuadsRead[timestampQuadsRead.length - 1];
  if (last) out.push(['timestamp', { value: termValue(last.object, ctx, 'date'), quads: timestampQuadsRead }]);
  return out;
}

