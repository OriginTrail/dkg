/**
 * RDF → OKF v0.2 families for export, the inverse of `encode.ts`, driven by
 * the same definitions in `specs.ts`. For each family it reads the field
 * predicates and `okf:<familyKey>.<key>` extensions on the family's subject
 * (and, for a list family, on each linked entry node, in node-index order),
 * and returns the frontmatter value with fields in definition order followed
 * by extensions. It also reads back what the encoder keeps for a family that
 * is not there as such: a value of the wrong shape, kept verbatim on the
 * family key's generic predicate, and a legacy field (`generated.at` without
 * its actor reads back as `timestamp`, §13.1). It reports every concept quad
 * it read, so the exporter reads only the rest, as base fields and producer
 * keys, and needs no knowledge of the families. Derived triples
 * (`okf:trustTier`, `prov:wasDerivedFrom`) are never read back; the next
 * import re-derives them.
 */

import { SCHEMA_NS } from '../constants.js';
import { okfExtensionKey } from '../extensions.js';
import { genericPredicate } from '../terms.js';
import { dict } from '../utils.js';
import { accumulate, byNodeIndex, orderKeys, termValue, type ExportContext, type TermForm } from '../decode-terms.js';
import type { Quad } from '../types.js';
import {
  FAMILY_SPECS,
  type FamilySpec,
  type FieldSpec,
  type ListFamilySpec,
  type MappingFamilySpec,
  type ScalarFamilySpec,
} from './specs.js';

/** What the families of one concept read back as. */
export interface DecodedFamilies {
  /** Frontmatter key → value: every family on the concept, and a legacy key such as `timestamp` (§13.1). */
  readonly frontmatter: Record<string, unknown>;
  /** The concept quads these were read from; the exporter reads the rest as base fields and producer keys. */
  readonly consumed: ReadonlySet<Quad>;
}

/** A value read back, and the quads it was read from. */
interface Read {
  readonly value: unknown;
  readonly quads: readonly Quad[];
}

const FIELD_BY_PREDICATE = new Map<MappingFamilySpec | ListFamilySpec, ReadonlyMap<string, FieldSpec>>();

function fieldByPredicate(spec: MappingFamilySpec | ListFamilySpec): ReadonlyMap<string, FieldSpec> {
  let map = FIELD_BY_PREDICATE.get(spec);
  if (!map) {
    map = new Map(spec.fields.map((f) => [f.predicate, f]));
    FIELD_BY_PREDICATE.set(spec, map);
  }
  return map;
}

/** How a field's value is written back: a date field's import re-types its text, a path field's names a concept. */
function formOf(field: FieldSpec): TermForm {
  return field.kind === 'date' || field.kind === 'path' ? field.kind : 'value';
}

/** Set-valued fields come back sorted: strings by value, a kept-verbatim structure by its JSON. */
function listKey(item: unknown): string {
  return typeof item === 'string' ? item : JSON.stringify(item);
}

function byListKey(a: unknown, b: unknown): number {
  const x = listKey(a);
  const y = listKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A family's producer extensions on one subject (`okf:<familyKey>.<key>`), in quad order; adds the quads to `read`. */
function extensionsOf(quads: readonly Quad[], familyKey: string, ctx: ExportContext, read: Quad[]): Record<string, unknown> {
  const extras = dict();
  for (const q of quads) {
    const key = okfExtensionKey(familyKey, q.predicate);
    if (key === null) continue;
    accumulate(extras, key, termValue(q.object, ctx));
    read.push(q);
  }
  return extras;
}

/** The decoded fields and extensions of a mapping / entry on one subject, and the quads they were read from. */
function decodeFields(
  spec: MappingFamilySpec | ListFamilySpec,
  quads: readonly Quad[],
  ctx: ExportContext,
): { value: Record<string, unknown>; fields: Record<string, unknown>; extensions: Record<string, unknown>; quads: Quad[] } {
  const byPredicate = fieldByPredicate(spec);
  const fields = dict();
  const lists = dict<unknown[]>();
  const read: Quad[] = [];
  for (const q of quads) {
    const field = byPredicate.get(q.predicate);
    if (!field) continue;
    read.push(q);
    const decoded = termValue(q.object, ctx, formOf(field));
    if (field.kind === 'text-list') (lists[field.key] ??= []).push(decoded);
    else fields[field.key] = decoded; // single-valued: last wins
  }
  for (const [key, items] of Object.entries(lists)) fields[key] = [...items].sort(byListKey);
  const extensions = extensionsOf(quads, spec.key, ctx, read);
  return { value: Object.assign(dict(), fields, extensions), fields, extensions, quads: read };
}

/** Whether a mapping family is there: one of its `presentWith` fields (by default, any field) or an extension. */
function isPresent(spec: MappingFamilySpec, decoded: { fields: Record<string, unknown>; extensions: Record<string, unknown> }): boolean {
  const anchors = spec.presentWith ?? spec.fields.map((f) => f.key);
  return anchors.some((key) => key in decoded.fields) || Object.keys(decoded.extensions).length > 0;
}

/** A mapping family on one subject, fields in definition order, or `null` when it is not there. */
function decodeMapping(spec: MappingFamilySpec, quads: readonly Quad[], ctx: ExportContext): Read | null {
  const decoded = decodeFields(spec, quads, ctx);
  return isPresent(spec, decoded) ? { value: orderKeys(decoded.value, spec.fields.map((f) => f.key)), quads: decoded.quads } : null;
}

/**
 * A family's value kept verbatim (`encode.ts`): the triples on the family
 * key's generic predicate, read back the way a producer key's are, or `null`.
 * On an entry node they are all the family's, since a node carries no
 * producer keys. On the concept that predicate is also the one a producer key
 * of the same camelCase uses: where that key is the family's own
 * (`generated`), the two read back alike; where it differs (`usage_window` →
 * `usageWindow`), only a list, one `rdf:JSON` array, which no producer key
 * yields (a producer key's list is one triple per item), is the family's.
 */
function keptVerbatim(spec: FamilySpec, quads: readonly Quad[], ctx: ExportContext, on: 'node' | 'concept'): Read | null {
  const predicate = genericPredicate(spec.key);
  const ownKey = on === 'node' || predicate === SCHEMA_NS + spec.key;
  const kept = dict();
  const read: Quad[] = [];
  for (const q of quads) {
    if (q.predicate !== predicate) continue;
    const value = termValue(q.object, ctx);
    if (!ownKey && !Array.isArray(value)) continue;
    accumulate(kept, spec.key, value);
    read.push(q);
  }
  return read.length > 0 ? { value: kept[spec.key], quads: read } : null;
}

function decodeEntry(
  spec: ListFamilySpec,
  quads: readonly Quad[],
  ctx: ExportContext,
): Record<string, unknown> {
  const { fields, extensions } = decodeFields(spec, quads, ctx);
  const nested = dict();
  for (const n of spec.nested ?? []) {
    const value = decodeMapping(n, quads, ctx) ?? keptVerbatim(n, quads, ctx, 'node');
    if (value) nested[n.key] = value.value;
  }
  return orderKeys(Object.assign(dict(), fields, nested, extensions), [
    ...spec.fields.map((f) => f.key),
    ...(spec.nested ?? []).map((n) => n.key),
  ]);
}

function decodeScalar(spec: ScalarFamilySpec, quads: readonly Quad[], ctx: ExportContext): Read | null {
  const read: Quad[] = [];
  let value: unknown;
  for (const q of quads) {
    if (q.predicate !== spec.field.predicate) continue;
    read.push(q);
    value = termValue(q.object, ctx, formOf(spec.field)); // single-valued: last wins
  }
  return read.length > 0 ? { value, quads: read } : null;
}

/**
 * Every v0.2 family on a concept, as frontmatter (key → value), and the
 * concept quads it was read from. `conceptQuads` are the quads whose subject
 * is the concept; `nodeQuads` returns the quads of one entry node.
 */
export function decodeFamilies(
  conceptQuads: readonly Quad[],
  nodeQuads: (node: string) => readonly Quad[],
  ctx: ExportContext,
): DecodedFamilies {
  const frontmatter = dict();
  const consumed = new Set<Quad>();
  const put = (key: string, read: Read): void => {
    frontmatter[key] = read.value;
    for (const q of read.quads) consumed.add(q);
  };
  for (const spec of FAMILY_SPECS) {
    switch (spec.shape) {
      case 'scalar': {
        const found = decodeScalar(spec, conceptQuads, ctx);
        if (found) put(spec.key, found);
        break;
      }
      case 'mapping': {
        const decoded = decodeFields(spec, conceptQuads, ctx);
        if (isPresent(spec, decoded)) {
          put(spec.key, { value: orderKeys(decoded.value, spec.fields.map((f) => f.key)), quads: decoded.quads });
          break;
        }
        const kept = keptVerbatim(spec, conceptQuads, ctx, 'concept');
        if (kept) put(spec.key, kept);
        // Without the family, a legacy field reads back under its legacy key
        // (§13.1), unless the concept keeps a value of its own under that key:
        // only the family's field makes one (`generated.at` supersedes
        // `timestamp`, which is then a producer key), so the field reads back
        // inside the family and neither value overwrites the other.
        const legacy = spec.legacy;
        if (legacy && legacy.field in decoded.fields) {
          const keyTaken = conceptQuads.some((q) => q.predicate === genericPredicate(legacy.key));
          if (keyTaken && !(spec.key in frontmatter)) {
            put(spec.key, { value: orderKeys(decoded.value, spec.fields.map((f) => f.key)), quads: decoded.quads });
          } else {
            put(legacy.key, { value: decoded.fields[legacy.field], quads: decoded.quads });
          }
        }
        break;
      }
      case 'list': {
        const links = conceptQuads.filter((q) => q.predicate === spec.link);
        if (links.length > 0) {
          const nodes = links.map((q) => q.object).sort(byNodeIndex);
          put(spec.key, { value: nodes.map((node) => decodeEntry(spec, nodeQuads(node), ctx)), quads: links });
          break;
        }
        const kept = keptVerbatim(spec, conceptQuads, ctx, 'concept');
        if (kept) put(spec.key, kept);
        break;
      }
    }
  }
  return { frontmatter, consumed };
}
