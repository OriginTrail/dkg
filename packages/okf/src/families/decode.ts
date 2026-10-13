/**
 * RDF → OKF v0.2 families for export, the inverse of `encode.ts`, driven by
 * the same definitions in `specs.ts`. For each family it reads the field
 * predicates and `okf:<familyKey>.<key>` extensions on the family's subject
 * (and, for a list family, on each linked entry node, in node-index order),
 * and returns the frontmatter value with fields in definition order followed
 * by extensions. Derived triples (`okf:trustTier`, `prov:wasDerivedFrom`) are
 * never read back; the next import re-derives them.
 */

import { okfExtensionKey } from '../extensions.js';
import { genericPredicate } from '../terms.js';
import { hasOwn } from '../utils.js';
import { accumulate, byNodeIndex, orderKeys, termValue, type ExportContext } from '../decode-terms.js';
import type { Quad } from '../types.js';
import {
  FAMILY_SPECS,
  type FieldSpec,
  type ListFamilySpec,
  type MappingFamilySpec,
  type ScalarFamilySpec,
} from './specs.js';

const FIELD_BY_PREDICATE = new Map<MappingFamilySpec | ListFamilySpec, ReadonlyMap<string, FieldSpec>>();

function fieldByPredicate(spec: MappingFamilySpec | ListFamilySpec): ReadonlyMap<string, FieldSpec> {
  let map = FIELD_BY_PREDICATE.get(spec);
  if (!map) {
    map = new Map(spec.fields.map((f) => [f.predicate, f]));
    FIELD_BY_PREDICATE.set(spec, map);
  }
  return map;
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

/** A family's producer extensions on one subject (`okf:<familyKey>.<key>`), in quad order. */
function extensionsOf(quads: readonly Quad[], familyKey: string, ctx: ExportContext): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const q of quads) {
    const key = okfExtensionKey(familyKey, q.predicate);
    if (key !== null) accumulate(extras, key, termValue(q.object, ctx));
  }
  return extras;
}

/** The decoded fields of a mapping / entry on one subject, and whether any field or extension was present. */
function decodeFields(
  spec: MappingFamilySpec | ListFamilySpec,
  quads: readonly Quad[],
  ctx: ExportContext,
): { value: Record<string, unknown>; fields: Record<string, unknown>; extensions: Record<string, unknown> } {
  const byPredicate = fieldByPredicate(spec);
  const fields: Record<string, unknown> = {};
  const lists: Record<string, unknown[]> = {};
  for (const q of quads) {
    const field = byPredicate.get(q.predicate);
    if (!field) continue;
    const decoded = termValue(q.object, ctx, field.kind === 'path');
    if (field.kind === 'text-list') (lists[field.key] ??= []).push(decoded);
    else fields[field.key] = decoded; // single-valued: last wins
  }
  for (const [key, items] of Object.entries(lists)) fields[key] = [...items].sort(byListKey);
  const extensions = extensionsOf(quads, spec.key, ctx);
  return { value: { ...fields, ...extensions }, fields, extensions };
}

/** A mapping family on one subject, or `null` when nothing of it is there. */
function decodeMapping(spec: MappingFamilySpec, quads: readonly Quad[], ctx: ExportContext): Record<string, unknown> | null {
  const { value, fields, extensions } = decodeFields(spec, quads, ctx);
  const anchors = spec.presentWith ?? spec.fields.map((f) => f.key);
  const present = anchors.some((key) => hasOwn(fields, key)) || Object.keys(extensions).length > 0;
  return present ? orderKeys(value, spec.fields.map((f) => f.key)) : null;
}

function decodeEntry(
  spec: ListFamilySpec,
  quads: readonly Quad[],
  ctx: ExportContext,
): Record<string, unknown> {
  const { fields, extensions } = decodeFields(spec, quads, ctx);
  const nested: Record<string, unknown> = {};
  for (const n of spec.nested ?? []) {
    const value = decodeMapping(n, quads, ctx);
    if (value) {
      nested[n.key] = value;
      continue;
    }
    // A nested value of the wrong shape (`usage_window: last-quarter`) was
    // kept verbatim under the generic predicate on the entry's node; entry
    // nodes carry no other `schema:` producer keys, so it reads back unambiguously.
    const fallback: Record<string, unknown> = {};
    for (const q of quads) if (q.predicate === genericPredicate(n.key)) accumulate(fallback, n.key, termValue(q.object, ctx));
    if (hasOwn(fallback, n.key)) nested[n.key] = fallback[n.key];
  }
  return orderKeys({ ...fields, ...nested, ...extensions }, [
    ...spec.fields.map((f) => f.key),
    ...(spec.nested ?? []).map((n) => n.key),
  ]);
}

function decodeScalar(spec: ScalarFamilySpec, quads: readonly Quad[], ctx: ExportContext): { value: unknown } | null {
  let found: { value: unknown } | null = null;
  for (const q of quads) {
    if (q.predicate === spec.field.predicate) found = { value: termValue(q.object, ctx, spec.field.kind === 'path') };
  }
  return found;
}

/**
 * Every v0.2 family present on a concept, as frontmatter (key → value).
 * `conceptQuads` are the quads whose subject is the concept; `nodeQuads`
 * returns the quads of one entry node.
 */
export function decodeFamilies(
  conceptQuads: readonly Quad[],
  nodeQuads: (node: string) => readonly Quad[],
  ctx: ExportContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of FAMILY_SPECS) {
    switch (spec.shape) {
      case 'scalar': {
        const found = decodeScalar(spec, conceptQuads, ctx);
        if (found) out[spec.key] = found.value;
        break;
      }
      case 'mapping': {
        const value = decodeMapping(spec, conceptQuads, ctx);
        if (value) out[spec.key] = value;
        break;
      }
      case 'list': {
        const nodes = conceptQuads.filter((q) => q.predicate === spec.link).map((q) => q.object).sort(byNodeIndex);
        if (nodes.length > 0) out[spec.key] = nodes.map((node) => decodeEntry(spec, nodeQuads(node), ctx));
        break;
      }
    }
  }
  return out;
}
