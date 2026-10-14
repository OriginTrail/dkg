/**
 * Ownership made explicit, before the families are decoded (`decode.ts`).
 *
 * A graph the mapper writes now names the owner of every value two keys can
 * share: a family value kept verbatim by its marker
 * (`okf:keptVerbatim.<familyKey>`), `generated.at` by `okf:generatedAt`, a
 * producer value on `schema:dateModified` by `okf:producerDateModified`. The
 * legacy `timestamp` is left unmarked there, as the v0.1 mapper wrote it, and
 * named (`okf:legacyTimestamp`) only where a producer value holds its term or
 * where it is a list or mapping, kept whole. A
 * graph written before values were marked (a v0.1 import, or one written
 * before a marker existed) names fewer.
 *
 * `normalizeOwnership` adds the marker of every owner a graph leaves unnamed,
 * the legacy `timestamp`'s included, inferred from what each owner can write.
 * The family readers then read declared ownership alone, in one
 * representation, and this is the one place that infers it. It never adds a
 * marker where the graph has one, and each marker it adds is the only one on
 * its predicate a reader picks from (producer markers are read as a set), so
 * where it goes changes no reading. The markers it adds are new quads, for
 * decoding only: never stored or exported, since the decoder returns only
 * the graph's own quads that no family read.
 */

import { OKF_GENERATED_AT, OKF_LEGACY_TIMESTAMP, OKF_PRODUCER_DATE_MODIFIED, RDF_JSON, SCHEMA_DATE_MODIFIED } from '../constants.js';
import { isStringLiteral, isTypedDate, literalDatatype, termValue, type ExportContext } from '../decode-terms.js';
import { keptVerbatimPredicate } from '../extensions.js';
import { genericPredicate } from '../terms.js';
import { isMapping, last } from '../utils.js';
import type { Quad } from '../types.js';
import { decodeMapping, keptVerbatim } from './decode-fields.js';
import { parseList } from './parse.js';
import { FAMILY_SPECS, GENERATED, type FamilySpec, type MappingFamilySpec } from './specs.js';

/** A concept's quads and its entry nodes' quads, with every owner named. */
export interface OwnedQuads {
  readonly conceptQuads: readonly Quad[];
  readonly nodeQuads: (node: string) => readonly Quad[];
}

/** A value an owner is inferred for, and that owner's marker predicate. */
type Owner = readonly [value: Quad, marker: string];

export function normalizeOwnership(
  conceptQuads: readonly Quad[],
  nodeQuads: (node: string) => readonly Quad[],
  ctx: ExportContext,
): OwnedQuads {
  const keptOwners: Owner[] = [];
  for (const spec of FAMILY_SPECS) {
    const value = keptOnConcept(spec, conceptQuads, ctx);
    if (value) keptOwners.push([value, keptVerbatimPredicate(spec.key)]);
  }
  // Dates after kept values: whether `generated` was kept verbatim decides one of their rules.
  const kept = withMarkers(conceptQuads, keptOwners);
  const nested = nestedFamiliesByNode(conceptQuads);
  return {
    conceptQuads: withMarkers(kept, dateOwners(kept, ctx)),
    nodeQuads: (node) => {
      const quads = nodeQuads(node);
      const owners: Owner[] = [];
      for (const spec of nested.get(node) ?? []) {
        const value = keptOnNode(spec, quads);
        if (value) owners.push([value, keptVerbatimPredicate(spec.key)]);
      }
      return withMarkers(quads, owners);
    },
  };
}

/** `quads`, and for each owner a marker holding its value's term. */
function withMarkers(quads: readonly Quad[], owners: readonly Owner[]): readonly Quad[] {
  if (owners.length === 0) return quads;
  return [...quads, ...owners.map(([value, predicate]) => ({ subject: value.subject, predicate, object: value.object }))];
}

function hasMarker(quads: readonly Quad[], predicate: string): boolean {
  return quads.some((q) => q.predicate === predicate);
}

/**
 * A family value kept verbatim on the concept, unmarked: the one non-empty
 * `rdf:JSON` array on the family key's generic predicate that the family
 * keeps verbatim, which no producer key yields (its list is one triple per
 * item, and an empty one is `[]`). An unmarked single value stays a producer
 * value.
 */
function keptOnConcept(spec: FamilySpec, quads: readonly Quad[], ctx: ExportContext): Quad | undefined {
  if (spec.shape === 'scalar' || hasMarker(quads, keptVerbatimPredicate(spec.key))) return undefined;
  const predicate = genericPredicate(spec.key);
  const lists = quads.filter((q) => q.predicate === predicate && isNonEmptyList(q.object, ctx) && keepsVerbatim(spec, termValue(q.object, ctx)));
  return lists.length === 1 ? lists[0] : undefined;
}

/** Whether the family keeps `value` verbatim: it is no value of the family's own shape. */
function keepsVerbatim(spec: FamilySpec, value: unknown): boolean {
  if (spec.shape === 'mapping') return !isMapping(value);
  if (spec.shape === 'list') return parseList(spec, value).shape === 'invalid';
  return false;
}

/** The entry nodes of the concept's list families that nest a family (`sources[].usage_window`), and those families. */
function nestedFamiliesByNode(conceptQuads: readonly Quad[]): Map<string, readonly MappingFamilySpec[]> {
  const out = new Map<string, readonly MappingFamilySpec[]>();
  for (const spec of FAMILY_SPECS) {
    if (spec.shape !== 'list' || !spec.nested) continue;
    for (const q of conceptQuads) if (q.predicate === spec.link) out.set(q.object, spec.nested);
  }
  return out;
}

/**
 * A nested family's value kept verbatim on an entry node, unmarked: the
 * node's value on the family key's generic predicate, since a node carries no
 * producer keys. Of several, which only a merged graph holds, the canonical
 * last, as for any single value.
 */
function keptOnNode(spec: MappingFamilySpec, quads: readonly Quad[]): Quad | undefined {
  if (hasMarker(quads, keptVerbatimPredicate(spec.key))) return undefined;
  const predicate = genericPredicate(spec.key);
  return last(quads.filter((q) => q.predicate === predicate));
}

/**
 * The owners of the values on `schema:dateModified` no marker names (on the
 * concept only: a source node's `last_modified` is a field of its own), by
 * what each can write:
 *
 *   - a non-empty `rdf:JSON` array is a `generated.at` kept verbatim, unless
 *     an `okf:generatedAt` names one or `generated` is a value kept verbatim,
 *     which has no `at`: a producer key's list is one triple per item, and
 *     the timestamp writes a time;
 *   - the legacy `timestamp` is never there beside a `generated.at` that gives
 *     a time (it supersedes it, §13.1), nor beside an `okf:legacyTimestamp`;
 *     otherwise it is one of the terms its date encoder writes, the canonical
 *     last typed date, else the canonical last plain literal;
 *   - every other value is a producer value.
 */
function dateOwners(quads: readonly Quad[], ctx: ExportContext): Owner[] {
  const on = (predicate: string) => quads.filter((q) => q.predicate === predicate);
  const at = on(OKF_GENERATED_AT);
  const named = new Set([...at, ...on(OKF_LEGACY_TIMESTAMP), ...on(OKF_PRODUCER_DATE_MODIFIED)].map((q) => q.object));
  const unmarked = on(SCHEMA_DATE_MODIFIED).filter((q) => !named.has(q.object));
  if (unmarked.length === 0) return [];
  const owners = new Map<Quad, string>();
  const generatedKept = decodeMapping(GENERATED, quads, ctx) === null && keptVerbatim(GENERATED, quads, ctx) !== null;
  const keptAt = at.length > 0 || generatedKept ? undefined : last(unmarked.filter((q) => isNonEmptyList(q.object, ctx)));
  if (keptAt) owners.set(keptAt, OKF_GENERATED_AT);
  const superseded = at.some((q) => literalDatatype(q.object) !== RDF_JSON);
  if (!superseded && !hasMarker(quads, OKF_LEGACY_TIMESTAMP)) {
    const stamp = last(unmarked.filter((q) => isTypedDate(q.object))) ?? last(unmarked.filter((q) => isStringLiteral(q.object)));
    if (stamp) owners.set(stamp, OKF_LEGACY_TIMESTAMP);
  }
  for (const q of unmarked) if (!owners.has(q)) owners.set(q, OKF_PRODUCER_DATE_MODIFIED);
  return [...owners];
}

function isNonEmptyList(term: string, ctx: ExportContext): boolean {
  if (literalDatatype(term) !== RDF_JSON) return false;
  const value = termValue(term, ctx);
  return Array.isArray(value) && value.length > 0;
}
