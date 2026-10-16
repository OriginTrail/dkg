/**
 * RDF → OKF v0.2 families for export, the inverse of `encode.ts`, driven by
 * the same definitions in `specs.ts`. For each family it reads the field
 * predicates and `okf:<familyKey>.<key>` extensions on the family's subject
 * (and, for a list family, on each linked entry node, in node-index order),
 * and returns the frontmatter value with fields in definition order followed
 * by extensions, or a value of the wrong shape the encoder kept verbatim on
 * the family key's generic predicate (`decode-fields.ts`). `generated` and the
 * legacy `timestamp` are read back by their codec (`generated.ts`). Ownership
 * is made explicit first (`ownership.ts`), so every reader reads the markers a
 * graph written now carries, a graph the v0.1 mapper wrote included. It returns the
 * concept quads no family read, told apart by their triple values, so the
 * exporter reads only those, as base fields and producer keys, and needs no
 * knowledge of the families. Derived
 * triples (`okf:trustTier`, `prov:wasDerivedFrom`) are never read back; the
 * next import re-derives them.
 */

import { byNodeIndex, orderKeys, termValue, type ExportContext } from '../decode-terms.js';
import { dict, tripleKey } from '../utils.js';
import type { Quad } from '../types.js';
import { decodeFields, decodeMapping, formOf, keptVerbatim, type Read } from './decode-fields.js';
import { decodeGenerated } from './generated.js';
import { normalizeOwnership } from './ownership.js';
import { FAMILY_SPECS, GENERATED, type ListFamilySpec, type ScalarFamilySpec } from './specs.js';

/** What the families of one concept read back as. */
export interface DecodedFamilies {
  /** Frontmatter key → value: every family on the concept, and the legacy `timestamp` (§13.1). */
  readonly frontmatter: Record<string, unknown>;
  /**
   * The concept quads no family read, in their order: the exporter reads them
   * as base fields and producer keys. A triple a family read is told apart by
   * its value (subject, predicate and object), never by the object holding it,
   * so no step between the graph and the readers has to keep its objects.
   */
  readonly remaining: readonly Quad[];
}

function decodeEntry(
  spec: ListFamilySpec,
  quads: readonly Quad[],
  ctx: ExportContext,
): Record<string, unknown> {
  const { fields, extensions } = decodeFields(spec, quads, ctx);
  const nested = dict();
  for (const n of spec.nested ?? []) {
    const value = decodeMapping(n, quads, ctx) ?? keptVerbatim(n, quads, ctx);
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
  graphConceptQuads: readonly Quad[],
  nodeQuads: (node: string) => readonly Quad[],
  ctx: ExportContext,
): DecodedFamilies {
  // Every owner named first, so a graph the v0.1 mapper wrote reads as one
  // written now, and each reader below reads declared ownership.
  const conceptQuads = normalizeOwnership(graphConceptQuads);
  const frontmatter = dict();
  const read = new Set<string>();
  const put = (key: string, decoded: Read): void => {
    frontmatter[key] = decoded.value;
    for (const q of decoded.quads) read.add(tripleKey(q));
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
        const found = decodeMapping(spec, conceptQuads, ctx) ?? keptVerbatim(spec, conceptQuads, ctx);
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
        const kept = keptVerbatim(spec, conceptQuads, ctx);
        if (kept) put(spec.key, kept);
        break;
      }
    }
  }
  return { frontmatter, remaining: graphConceptQuads.filter((q) => !read.has(tripleKey(q))) };
}
