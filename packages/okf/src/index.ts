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
export { YamlTimestamp } from './yaml-lexical.js';
export { frontmatterQuads, mapFrontmatter, mapConcept, summarizeTrust } from './mapping.js';
export { parseBody } from './markdown-body.js';
export type { FrontmatterContext, FrontmatterMapping } from './mapping.js';
// The v0.2 family definitions and codec (`./families/`) are internal; these
// are the operations built on them.
export { familyQuads, familyDiagnostics, sourceIds, V02_FAMILY_KEYS } from './families/index.js';
export type { FamilyResult, ParsedEntry } from './families/index.js';
export { dateTimeLexical, isXsdDateTime, isXsdDate, hasExplicitOffset } from './timestamps.js';
export {
  actorKind,
  parseVerified,
  normalizeVerified,
  trustTierOf,
  deriveTrustTier,
  conceptStatus,
  isKnownStatus,
  isStale,
} from './trust.js';
export type { ParsedVerification } from './trust.js';
export { valueToTerms, dateTerm, actorTerm, pathFieldTerm, typeToIri, isAttestedComputationType, OkfValueError } from './terms.js';
export { okfExtensionPredicate, okfExtensionKey, okfExtensionPrefix, keptVerbatimPredicate } from './extensions.js';
export type { PathContext, PathFieldTerm } from './terms.js';
export { importBundle } from './bundle.js';
export { exportBundle, exportInputFromQuads } from './export.js';
export { validateBundle } from './validation.js';
export { quadsToNQuads } from './nquads.js';
export { loadBundleDir, loadBundleDirWithReport } from './loader.js';
export { isSafeIri, literalTerm, typedLiteralTerm, dedupeQuads, distinctTriples } from './utils.js';
