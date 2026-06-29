/**
 * Bundle-aware OKF import (the two passes from ADR 0005 / SPEC §3–§5).
 *
 * Pass 1 — index the bundle: classify concept vs. reserved files, parse each
 * concept's frontmatter, derive a deterministic subject IRI per concept ID, and
 * read `okf_version` from the root `index.md` if present.
 *
 * Pass 2 — extract + link: map each concept (frontmatter + body) to quads and
 * resolve its Markdown links against the Pass-1 map into untyped directed edges.
 *
 * Pure and deterministic: same `BundleFile[]` ⇒ identical quads and IRIs. No
 * filesystem, no network — `loadBundleDir` (loader.ts) is the only I/O surface.
 */

import { parseDocument, OkfDocumentError } from './document.js';
import { mapConcept } from './mapping.js';
import {
  isConceptFile,
  isReservedFile,
  pathToConceptId,
  conceptIdToIri,
} from './paths.js';
import { DEFAULT_IRI_BASE, SCHEMA_MENTIONS } from './constants.js';
import type {
  BundleFile,
  BundleImport,
  ConceptMapping,
  OkfDocument,
  OkfMappingOptions,
  OkfWarning,
  Quad,
} from './types.js';

function byPath(a: BundleFile, b: BundleFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function importBundle(files: BundleFile[], opts: OkfMappingOptions = {}): BundleImport {
  const iriBase = opts.iriBase ?? DEFAULT_IRI_BASE;
  const warnings: OkfWarning[] = [];

  // Deterministic ordering, independent of how the caller enumerated the tree.
  const ordered = [...files].sort(byPath);

  const reservedSkipped = ordered.filter((f) => isReservedFile(f.path)).map((f) => f.path);

  // --- Pass 1: index ---
  const docs: OkfDocument[] = [];
  const iriByConceptId: Record<string, string> = {};
  const typeByConceptId: Record<string, string | undefined> = {};
  for (const f of ordered) {
    if (!isConceptFile(f.path)) continue;
    let doc: OkfDocument;
    try {
      doc = parseDocument(f.path, f.content);
    } catch (err) {
      // Unparseable frontmatter is a §9 conformance issue; for import we skip the
      // concept with a warning rather than aborting the whole bundle.
      warnings.push({
        conceptId: pathToConceptId(f.path),
        code: 'parse',
        message: err instanceof OkfDocumentError ? err.message : String(err),
      });
      continue;
    }
    docs.push(doc);
    iriByConceptId[doc.conceptId] = conceptIdToIri(doc.conceptId, iriBase);
    typeByConceptId[doc.conceptId] =
      doc.frontmatter.type != null ? String(doc.frontmatter.type) : undefined;
    const type = doc.frontmatter.type;
    if (type === undefined || type === null || String(type).trim() === '') {
      warnings.push({
        conceptId: doc.conceptId,
        code: 'missing-optional',
        message: 'concept has no non-empty `type` (mapped as a generic concept; SPEC §9)',
      });
    }
  }

  // `okf_version` may be declared only in the bundle-root `index.md` (SPEC §11).
  let okfVersion: string | null = null;
  const rootIndex = ordered.find((f) => f.path === 'index.md');
  if (rootIndex) {
    try {
      const parsed = parseDocument('index.md', rootIndex.content);
      const v = parsed.frontmatter.okf_version;
      if (v !== undefined && v !== null) okfVersion = String(v);
    } catch {
      // Reserved files need no frontmatter; ignore.
    }
  }

  // --- Pass 2: extract + link ---
  const exists = (id: string): boolean =>
    Object.prototype.hasOwnProperty.call(iriByConceptId, id);
  // Opt-in: retype cross-concept edges by their endpoints' OKF `type` pair
  // (deterministic; default keeps every edge as schema:mentions).
  const typeRelations = opts.typeRelations ?? [];
  const relationPredicate = (fromType?: string, toType?: string): string | undefined => {
    if (typeRelations.length === 0 || fromType == null || toType == null) return undefined;
    return typeRelations.find((r) => r.from === fromType && r.to === toType)?.predicate;
  };

  const concepts: ConceptMapping[] = [];
  const quads: Quad[] = [];
  for (const doc of docs) {
    const mapping = mapConcept(doc, iriByConceptId[doc.conceptId], exists, opts);
    if (typeRelations.length > 0) {
      const fromType = typeByConceptId[doc.conceptId];
      for (const q of mapping.quads) {
        if (q.predicate !== SCHEMA_MENTIONS || !q.object.startsWith(iriBase)) continue;
        const targetId = q.object.slice(iriBase.length);
        const pred = relationPredicate(fromType, typeByConceptId[targetId]);
        if (pred) q.predicate = pred;
      }
    }
    concepts.push(mapping);
    quads.push(...mapping.quads);
    for (const bl of mapping.brokenLinks) {
      warnings.push({
        conceptId: doc.conceptId,
        code: 'broken-link',
        message: `unresolved cross-link "${bl.raw}" (not in bundle — not an error, SPEC §5.3/§9)`,
      });
    }
    if (!opts.includeCodeSpanLinks) {
      for (const cs of mapping.codeSpanLinks) {
        warnings.push({
          conceptId: doc.conceptId,
          code: 'code-span-link',
          message: `link "${cs.raw}" sits inside an inline code span — treated as literal text per CommonMark, not an edge`,
        });
      }
    }
  }

  return { okfVersion, iriByConceptId, concepts, reservedSkipped, quads, warnings };
}
