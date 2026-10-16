/**
 * Ownership made explicit, before the families are decoded (`decode.ts`).
 *
 * A graph the mapper writes now names the owner of every value two keys can
 * share: a family value kept verbatim by its marker
 * (`okf:keptVerbatim.<familyKey>`), `generated.at` by `okf:generatedAt`, a
 * producer value on `schema:dateModified` by `okf:producerDateModified`. The
 * legacy `timestamp` is left unmarked there, as the v0.1 mapper wrote it, and
 * named (`okf:legacyTimestamp`) only where a producer value holds its term or
 * where it is a list or mapping, kept whole.
 *
 * So the values a graph may leave unnamed are on `schema:dateModified`: the
 * legacy `timestamp` of a graph written now, and in a graph the v0.1 mapper
 * wrote, which marked nothing, its timestamp and its producer values alike.
 * `normalizeOwnership` adds the marker of each of their owners, inferred from
 * what each can write, and the family readers then read declared ownership
 * alone. Every other value is read by its marker only: the v0.1 mapper kept
 * no family value verbatim and wrote no list entry, and no other format is
 * read. It never adds a marker where the graph has one, and each marker it
 * adds is the only one on its predicate a reader picks from (producer markers
 * are read as a set), so where it goes changes no reading. The markers it adds
 * are new quads, for decoding only: never stored or exported, since the
 * decoder returns only the graph's own quads that no family read.
 */

import { OKF_GENERATED_AT, OKF_LEGACY_TIMESTAMP, OKF_PRODUCER_DATE_MODIFIED, RDF_JSON, SCHEMA_DATE_MODIFIED } from '../constants.js';
import { isStringLiteral, isTypedDate, literalDatatype } from '../decode-terms.js';
import { last } from '../utils.js';
import type { Quad } from '../types.js';

/** A concept's quads, with the owner of every value on `schema:dateModified` named. */
export function normalizeOwnership(conceptQuads: readonly Quad[]): readonly Quad[] {
  const owners = dateOwners(conceptQuads);
  if (owners.length === 0) return conceptQuads;
  return [...conceptQuads, ...owners.map(([value, predicate]) => ({ subject: value.subject, predicate, object: value.object }))];
}

/**
 * The owners of the values on `schema:dateModified` no marker names (on the
 * concept only: a source node's `last_modified` is a field of its own):
 *
 *   - the legacy `timestamp` is one of the terms a date encoder writes: the
 *     canonical last typed date (the v0.1 mapper typed every timestamp
 *     `xsd:dateTime`), else the canonical last plain literal (the text of an
 *     invalid one, as the mapper writes it now). It is never there beside an
 *     `okf:legacyTimestamp`, nor beside a `generated.at` that gives a time,
 *     which supersedes it (§13.1), as in a graph merging a v0.1 import with
 *     one written now;
 *   - every other value is a producer value.
 */
function dateOwners(quads: readonly Quad[]): Array<readonly [value: Quad, marker: string]> {
  const on = (predicate: string) => quads.filter((q) => q.predicate === predicate);
  const at = on(OKF_GENERATED_AT);
  const marked = on(OKF_LEGACY_TIMESTAMP);
  const named = new Set([...at, ...marked, ...on(OKF_PRODUCER_DATE_MODIFIED)].map((q) => q.object));
  const unmarked = on(SCHEMA_DATE_MODIFIED).filter((q) => !named.has(q.object));
  if (unmarked.length === 0) return [];
  const superseded = at.some((q) => literalDatatype(q.object) !== RDF_JSON);
  const stamp = superseded || marked.length > 0
    ? undefined
    : (last(unmarked.filter((q) => isTypedDate(q.object))) ?? last(unmarked.filter((q) => isStringLiteral(q.object))));
  return unmarked.map((q) => [q, q === stamp ? OKF_LEGACY_TIMESTAMP : OKF_PRODUCER_DATE_MODIFIED] as const);
}
