/**
 * `@origintrail-official/dkg-okf` — deterministic Google Open Knowledge Format
 * (OKF) → DKG Knowledge Asset mapper.
 *
 * Turns a portable OKF bundle (Markdown + YAML frontmatter + untyped cross-links)
 * into owned, verifiable RDF Knowledge Assets, reconstructing the bundle's
 * cross-concept link graph. Pure, no LLM, no network: same bundle ⇒ identical
 * triples and IRIs. The `dkg okf` CLI command is a thin wrapper over this.
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
  ConceptMapping,
  OkfWarning,
  BundleImport,
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
export { frontmatterQuads, parseBody, mapConcept } from './mapping.js';
export { importBundle } from './bundle.js';
export { exportBundle } from './export.js';
export { validateBundle } from './validation.js';
export { quadsToNQuads } from './nquads.js';
export { loadBundleDir, loadBundleDirWithReport } from './loader.js';
export { isSafeIri, literalTerm, typedLiteralTerm } from './utils.js';
