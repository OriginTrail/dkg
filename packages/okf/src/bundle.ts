/**
 * Bundle-aware OKF import (the two passes from ADR 0005 / SPEC §3–§6).
 *
 * Pass 1 — index the bundle: classify concept vs. reserved files, parse each
 * concept's frontmatter, derive a deterministic subject IRI per concept ID, and
 * read `okf_version` from the root `index.md` if present.
 *
 * Pass 2 — prepare: encode each concept's values and parse its body, without
 * reading the index. A concept with a value no RDF term can hold is skipped
 * here and leaves the index.
 *
 * Pass 3 — resolve: read each prepared concept's path-valued fields and
 * Markdown links against the final index, into typed and untyped edges.
 *
 * Pure and deterministic: same `BundleFile[]` ⇒ identical quads and IRIs. No
 * filesystem, no network — `loadBundleDir` (loader.ts) is the only I/O surface.
 */

import { parseDocument, OkfDocumentError } from './document.js';
import { prepareConcept, resolveConcept, type PreparedConcept } from './mapping.js';
import { OkfValueError } from './terms.js';
import {
  isConceptFile,
  isReservedFile,
  isValidSegment,
  pathToConceptId,
  conceptIdToIri,
} from './paths.js';
import { DEFAULT_IRI_BASE, SCHEMA_MENTIONS, OKF_KNOWN_VERSIONS, OKF_TARGET_VERSION } from './constants.js';
import { dict, isBlank, safeString } from './utils.js';
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
  // Dictionaries: a concept ID is a file path, and `__proto__.md` or
  // `constructor.md` are valid concept files (§2), so a plain object would
  // drop the first (prototype setter) and misread inherited names.
  const iriByConceptId = dict<string>();
  const typeByConceptId = dict<string | undefined>();
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

  // --- Pass 2: prepare ---
  // Every concept is prepared once, before any reference is read. A concept
  // whose value no RDF term can hold (`OkfValueError`) is skipped with a
  // warning and leaves the index, so the index every survivor then resolves
  // against (once) names only imported concepts: a reference to a skipped
  // concept is a broken link, never an edge. Any other exception is a defect
  // and propagates.
  type Prepared = { doc: OkfDocument; prepared: PreparedConcept } | { doc: OkfDocument; failure: OkfWarning };
  const prepared = docs.map((doc): Prepared => {
    try {
      return { doc, prepared: prepareConcept(doc, iriByConceptId[doc.conceptId], opts) };
    } catch (err) {
      if (!(err instanceof OkfValueError)) throw err;
      return { doc, failure: { conceptId: doc.conceptId, code: 'unmappable-value', message: `could not be mapped (${err.message}); skipped` } };
    }
  });
  for (const p of prepared) {
    if ('failure' in p) {
      delete iriByConceptId[p.doc.conceptId];
      delete typeByConceptId[p.doc.conceptId];
    }
  }

  // --- Pass 3: resolve ---
  const exists = (id: string): boolean => id in iriByConceptId;
  // Opt-in: retype cross-concept edges by their endpoints' OKF `type` pair
  // (deterministic; default keeps every edge as schema:mentions).
  const typeRelations = opts.typeRelations ?? [];
  const relationPredicate = (fromType?: string, toType?: string): string | undefined => {
    if (typeRelations.length === 0 || fromType == null || toType == null) return undefined;
    return typeRelations.find((r) => r.from === fromType && r.to === toType)?.predicate;
  };

  const concepts: ConceptMapping[] = [];
  const quads: Quad[] = [];
  for (const p of prepared) {
    if ('failure' in p) {
      warnings.push(p.failure);
      continue;
    }
    const { doc } = p;
    const mapping = resolveConcept(p.prepared, exists);
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
    // Every concept-level diagnostic comes from the mapper (prepare + resolve).
    warnings.push(...mapping.warnings);
  }

  return { okfVersion, iriByConceptId, concepts, reservedSkipped, quads, warnings };
}
