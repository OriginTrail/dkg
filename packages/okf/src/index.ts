/**
 * `@origintrail-official/dkg-okf` — deterministic Google Open Knowledge Format
 * (OKF v0.2) → DKG Knowledge Asset mapper.
 *
 * Turns a portable OKF bundle (Markdown + YAML frontmatter + untyped cross-links)
 * into owned, verifiable RDF Knowledge Assets, reconstructing the bundle's
 * cross-concept link graph and carrying the v0.2 provenance / trust / lifecycle
 * / attestation families as queryable RDF. Pure, no LLM, no network: same bundle
 * ⇒ identical triples and IRIs. The `dkg okf` CLI command is a thin wrapper over
 * this.
 *
 * See `CONTEXT.md` for the language/relationships/flagged-ambiguities and
 * `docs/adr/0005-okf-rdf-mapping.md` for the locked OKF→RDF mapping.
 */

export type {
  Quad,
  OkfDocument,
  OkfLink,
  OkfCitation,
  OkfMappingOptions,
  TypeRelation,
  TrustTier,
  OkfStatus,
  VerificationEvent,
  ConceptTrust,
  ConceptMapping,
  OkfWarning,
  BundleImport,
  ExportInput,
  BundleFile,
  ConformanceReport,
} from './types.js';

export * from './constants.js';

export {
  RESERVED_FILENAMES,
  isValidSegment,
  basename,
  isReservedFile,
  isConceptFile,
  pathToConceptId,
  conceptIdToIri,
  conceptIdToKaName,
  resolveLinkTarget,
} from './paths.js';

export { parseDocument, OkfDocumentError } from './document.js';
export { frontmatterQuads, mapFrontmatter, parseBody, mapConcept, summarizeTrust } from './mapping.js';
export type { FrontmatterContext, FrontmatterMapping } from './mapping.js';
export { familyQuads, familyDiagnostics, sourceIds, V02_FAMILY_KEYS } from './families.js';
export type { FamilyResult } from './families.js';
export {
  dateTimeLexical,
  isXsdDateTime,
  isXsdDate,
  hasExplicitOffset,
  actorKind,
  normalizeVerified,
  deriveTrustTier,
  conceptStatus,
  isKnownStatus,
  isStale,
} from './trust.js';
export { valueToTerms, dateTerm, actorTerm, pathFieldTerm, typeToIri, isAttestedComputationType } from './terms.js';
export { okfExtensionPredicate, okfExtensionKey, okfExtensionPrefix } from './extensions.js';
export type { PathContext, PathFieldTerm } from './terms.js';
export { importBundle } from './bundle.js';
export { exportBundle } from './export.js';
export { validateBundle } from './validation.js';
export { quadsToNQuads } from './nquads.js';
export { loadBundleDir, loadBundleDirWithReport } from './loader.js';
export { isSafeIri, literalTerm, typedLiteralTerm, dedupeQuads } from './utils.js';
