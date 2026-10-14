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
 * The `generated` family's fields are the shared definitions in `specs.ts`,
 * and which of the two keys gives the time (the §13.1 precedence) is the
 * shared key policy's (`frontmatter-keys.ts`); this codec writes each key's
 * values by that rule and gives each stored value back to its key on export.
 */

import { OKF_GENERATED_AT, OKF_LEGACY_TIMESTAMP, OKF_PRODUCER_DATE_MODIFIED, SCHEMA_DATE_MODIFIED } from '../constants.js';
import { termValue, type ExportContext } from '../decode-terms.js';
import { timestampIsProducerKey } from '../frontmatter-keys.js';
import { dateTerm, genericPredicate, genericQuads, valueToTerms } from '../terms.js';
import { last } from '../utils.js';
import type { Quad } from '../types.js';
import { decodeMapping, keptVerbatim, type Read } from './decode-fields.js';
import { prepareFamily, type PreparedQuad } from './encode.js';
import { GENERATED } from './specs.js';

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

/**
 * Export: `generated` and the legacy `timestamp` from a concept's quads, and
 * the quads each was read from, every owner named (`ownership.ts`):
 * `generated` is its fields (`at` on `okf:generatedAt`) or a value kept
 * verbatim, the timestamp an `okf:legacyTimestamp` value, and each is read
 * with its copy on `schema:dateModified`, unless a producer value holds the
 * same term (`okf:producerDateModified`): that copy is left to the exporter,
 * which writes it back under the producer's key.
 */
export function decodeGenerated(conceptQuads: readonly Quad[], ctx: ExportContext): Array<[string, Read]> {
  const on = (predicate: string) => conceptQuads.filter((q) => q.predicate === predicate);
  const producer = new Set(on(OKF_PRODUCER_DATE_MODIFIED).map((q) => q.object));
  const copies = on(SCHEMA_DATE_MODIFIED);
  const copiesOf = (term: string) => (producer.has(term) ? [] : copies.filter((q) => q.object === term));
  const out: Array<[string, Read]> = [];

  const mapping = decodeMapping(GENERATED, conceptQuads, ctx);
  const generated = mapping
    ? { value: mapping.value, quads: [...mapping.quads, ...on(OKF_GENERATED_AT).flatMap((q) => copiesOf(q.object))] }
    : keptVerbatim(GENERATED, conceptQuads, ctx);
  if (generated) out.push([GENERATED.key, generated]);

  const marked = on(OKF_LEGACY_TIMESTAMP);
  const timestamp = last(marked);
  if (timestamp) out.push(['timestamp', { value: termValue(timestamp.object, ctx, 'date'), quads: [...marked, ...copiesOf(timestamp.object)] }]);
  return out;
}
