/**
 * Bundle-aware OKF import (the two passes from ADR 0005 / SPEC §3–§6).
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
import { OkfValueError } from './terms.js';
import {
  isConceptFile,
  isReservedFile,
  isValidSegment,
  pathToConceptId,
  conceptIdToIri,
} from './paths.js';
import { DEFAULT_IRI_BASE, SCHEMA_MENTIONS, OKF_KNOWN_VERSIONS, OKF_TARGET_VERSION } from './constants.js';
import { isBlank, safeString } from './utils.js';
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
  // Null-prototype dictionaries: a concept ID is a file path, and `__proto__.md`
  // or `constructor.md` are valid concept files (§2), so a plain object would
  // drop the first (prototype setter) and misread inherited names.
  const iriByConceptId: Record<string, string> = Object.create(null) as Record<string, string>;
  const typeByConceptId: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
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
    // A concept whose path has a non-OKF segment would mint a malformed subject IRI
    // (e.g. `bad name.md` → `urn:okf:bad name`, a space-bearing IRI that breaks
    // N-Quads / node writes). Skip it with a warning rather than emit bad RDF.
    if (!doc.conceptId.split('/').every(isValidSegment)) {
      warnings.push({
        conceptId: doc.conceptId,
        code: 'invalid-path',
        message: `invalid concept path segment(s) — must match [A-Za-z0-9_][A-Za-z0-9_.-]* (§2); skipped`,
      });
      continue;
    }
    docs.push(doc);
    iriByConceptId[doc.conceptId] = conceptIdToIri(doc.conceptId, iriBase);
    typeByConceptId[doc.conceptId] =
      doc.frontmatter.type != null ? safeString(doc.frontmatter.type) : undefined;
    if (isBlank(doc.frontmatter.type)) {
      warnings.push({
        conceptId: doc.conceptId,
        code: 'missing-type',
        message: 'concept has no non-empty `type` (a hard §11 conformance requirement; the bundle will not validate)',
      });
    }
  }

  // `okf_version` may be declared only in the bundle-root `index.md` (SPEC §12).
  let okfVersion: string | null = null;
  const rootIndex = ordered.find((f) => f.path === 'index.md');
  if (rootIndex) {
    try {
      const parsed = parseDocument('index.md', rootIndex.content);
      const v = parsed.frontmatter.okf_version;
      if (v !== undefined && v !== null) okfVersion = safeString(v);
    } catch {
      // Reserved files need no frontmatter; ignore.
    }
  }
  // A version this consumer does not know is consumed best-effort, never
  // refused (SPEC §12). v0.1 bundles consume under the §13.1 fallbacks.
  if (okfVersion !== null && !(OKF_KNOWN_VERSIONS as readonly string[]).includes(okfVersion)) {
    warnings.push({
      code: 'unsupported-version',
      message: `root index.md declares okf_version "${okfVersion}"; this consumer targets OKF ${OKF_TARGET_VERSION} and consumes the bundle best-effort (SPEC §12)`,
    });
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

  // A concept whose value no RDF term can hold (`OkfValueError`) is skipped
  // with a warning. It must not stay a link target either, or the survivors
  // would emit resolved links and lineage edges to a concept never imported:
  // so failures are found first, dropped from the index, and the survivors
  // mapped against the final index. Without failures that is a single pass.
  // Any other exception is a defect and propagates.
  type Outcome = { doc: OkfDocument; mapping: ConceptMapping } | { doc: OkfDocument; failure: OkfWarning };
  const mapOrSkip = (doc: OkfDocument): Outcome => {
    try {
      return { doc, mapping: mapConcept(doc, iriByConceptId[doc.conceptId], exists, opts) };
    } catch (err) {
      if (!(err instanceof OkfValueError)) throw err;
      return { doc, failure: { conceptId: doc.conceptId, code: 'unmappable-value', message: `could not be mapped (${err.message}); skipped` } };
    }
  };
  let outcomes = docs.map(mapOrSkip);
  if (outcomes.some((o) => 'failure' in o)) {
    for (const o of outcomes) {
      if ('failure' in o) {
        delete iriByConceptId[o.doc.conceptId];
        delete typeByConceptId[o.doc.conceptId];
      }
    }
    outcomes = outcomes.map((o) => ('failure' in o ? o : { doc: o.doc, mapping: mapConcept(o.doc, iriByConceptId[o.doc.conceptId], exists, opts) }));
  }

  const concepts: ConceptMapping[] = [];
  const quads: Quad[] = [];
  for (const outcome of outcomes) {
    if ('failure' in outcome) {
      warnings.push(outcome.failure);
      continue;
    }
    const { doc, mapping } = outcome;
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
    // Every concept-level diagnostic is built by mapConcept (one owner).
    warnings.push(...mapping.warnings);
  }

  return { okfVersion, iriByConceptId, concepts, reservedSkipped, quads, warnings };
}
