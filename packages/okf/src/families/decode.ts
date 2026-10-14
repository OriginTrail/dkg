/**
 * RDF → OKF v0.2 families for export, the inverse of `encode.ts`, driven by
 * the same definitions in `specs.ts`. For each family it reads the field
 * predicates and `okf:<familyKey>.<key>` extensions on the family's subject
 * (and, for a list family, on each linked entry node, in node-index order),
 * and returns the frontmatter value with fields in definition order followed
 * by extensions, or a value of the wrong shape the encoder kept verbatim on
 * the family key's generic predicate (`decode-fields.ts`). `generated` and the
 * legacy `timestamp` are read back by their codec (`generated.ts`). It reports
 * every concept quad it read, so the exporter reads only the rest, as base
 * fields and producer keys, and needs no knowledge of the families. Derived
 * triples (`okf:trustTier`, `prov:wasDerivedFrom`) are never read back; the
 * next import re-derives them.
 */

import { byNodeIndex, orderKeys, termValue, type ExportContext } from '../decode-terms.js';
import { dict } from '../utils.js';
import type { Quad } from '../types.js';
import { decodeFields, decodeMapping, formOf, keptVerbatim, type Read } from './decode-fields.js';
import { decodeGenerated } from './generated.js';
import { FAMILY_SPECS, GENERATED, type ListFamilySpec, type ScalarFamilySpec } from './specs.js';

/** What the families of one concept read back as. */
export interface DecodedFamilies {
  /** Frontmatter key → value: every family on the concept, and the legacy `timestamp` (§13.1). */
  readonly frontmatter: Record<string, unknown>;
  /** The concept quads these were read from; the exporter reads the rest as base fields and producer keys. */
  readonly consumed: ReadonlySet<Quad>;
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
    // `generated` shares its last-modified time with the legacy `timestamp`:
    // its codec reads both keys back.
    if (spec === GENERATED) {
      for (const [key, read] of decodeGenerated(conceptQuads, ctx)) put(key, read);
      continue;
    }
    switch (spec.shape) {
      case 'scalar': {
        const found = decodeScalar(spec, conceptQuads, ctx);
        if (found) put(spec.key, found);
        break;
      }
      case 'mapping': {
        const found = decodeMapping(spec, conceptQuads, ctx) ?? keptVerbatim(spec, conceptQuads, ctx, 'concept');
        if (found) put(spec.key, found);
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
