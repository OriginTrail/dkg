/**
 * RDF predicate / namespace constants for the OKF → DKG mapping.
 *
 * These deliberately mirror the vocabulary already minted by the node's
 * deterministic Markdown extractor (`packages/cli/src/extraction/
 * markdown-extractor.ts`) so that an OKF import and a natively-ingested
 * Markdown corpus converge on the same graph shape and join naturally.
 * The extractor's predicate strings are private module constants there;
 * we re-declare the same literal IRIs here (rather than import across the
 * `cli → okf` boundary, which would be a dependency cycle) and pin the
 * convergence with a test.
 *
 * The OKF-specific deltas — and the rationale for each — are recorded in
 * `docs/adr/0005-okf-rdf-mapping.md` and `CONTEXT.md`.
 */

// --- RDF / XSD ---
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
export const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
export const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
export const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';

// --- schema.org (converges with the extractor) ---
export const SCHEMA_NS = 'http://schema.org/';
export const SCHEMA_NAME = 'http://schema.org/name';
export const SCHEMA_DESCRIPTION = 'http://schema.org/description';
export const SCHEMA_KEYWORDS = 'http://schema.org/keywords';
/** Untyped directed concept→concept edge. Converges with the extractor's `[[wikilink]]` predicate. */
export const SCHEMA_MENTIONS = 'http://schema.org/mentions';
/** OKF `timestamp` = last-modified time (SPEC §4.1). */
export const SCHEMA_DATE_MODIFIED = 'http://schema.org/dateModified';
/** OKF `resource` = canonical URI of the underlying asset (SPEC §4.1). */
export const SCHEMA_URL = 'http://schema.org/url';
/** `# Citations` links (SPEC §8) — semantically distinct from concept edges. */
export const SCHEMA_CITATION = 'http://schema.org/citation';
/** Containment edge — opt-in target for type-pair relations (e.g. dataset→table). */
export const SCHEMA_HAS_PART = 'http://schema.org/hasPart';
/** Optional folder hierarchy (off by default — see ADR 0005). */
export const SCHEMA_IS_PART_OF = 'http://schema.org/isPartOf';

// --- DKG ontology (converges with the extractor) ---
export const DKG_HAS_SECTION = 'http://dkg.io/ontology/hasSection';

/**
 * Infix for deterministic skolem IRIs minted for `dkg:hasSection` nodes.
 * The daemon rejects blank-node RDF *objects* ("RDF object must be a quoted
 * literal term or absolute IRI"), so section nodes are skolemized into
 * concept-scoped IRIs `<conceptIri>/.well-known/genid/okfsec_<id>_<n>` — the
 * same `.well-known/genid/` scheme the node uses internally, so stored data is
 * identical whether or not the node would have skolemized them itself. Export
 * uses this infix to exclude section nodes from being rebuilt as concepts.
 */
export const SECTION_GENID_INFIX = '/.well-known/genid/';

/** Default IRI namespace for concept Knowledge Asset subjects. */
export const DEFAULT_IRI_BASE = 'urn:okf:';

/** The OKF version this consumer targets (SPEC is v0.1 draft). */
export const OKF_TARGET_VERSION = '0.1';
