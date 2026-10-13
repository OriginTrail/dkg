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
 * `docs/adr/0005-okf-rdf-mapping.md` and `CONTEXT.md`. The OKF v0.2 trust,
 * provenance, lifecycle and attestation families (SPEC §5, §10) live in a
 * dedicated `okf:` sub-namespace of the DKG ontology so they can never collide
 * with the node's own asset metadata (`dkg:status`, `dkg:trustLevel`, …).
 */

// --- RDF / XSD ---
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
/**
 * JSON-valued literal datatype (RDF 1.2 / JSON-LD 1.1). Object-valued
 * producer keys are carried as `"…"^^rdf:JSON` so they round-trip as objects,
 * not as strings. The deployed stores keep custom datatypes verbatim.
 */
export const RDF_JSON = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON';
export const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
export const XSD_DATE = 'http://www.w3.org/2001/XMLSchema#date';
export const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
export const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
export const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';

// --- schema.org (converges with the extractor) ---
export const SCHEMA_NS = 'http://schema.org/';
export const SCHEMA_NAME = 'http://schema.org/name';
export const SCHEMA_DESCRIPTION = 'http://schema.org/description';
export const SCHEMA_KEYWORDS = 'http://schema.org/keywords';
export const SCHEMA_IDENTIFIER = 'http://schema.org/identifier';
/** Untyped directed concept→concept edge. Converges with the extractor's `[[wikilink]]` predicate. */
export const SCHEMA_MENTIONS = 'http://schema.org/mentions';
/**
 * Last meaningful content change. v0.2 `generated.at` (SPEC §5.2) and the
 * legacy v0.1 `timestamp` (§13.1 fallback) both land here, so a mixed-version
 * corpus is uniformly queryable by one predicate. On a `okf:Source` node it is
 * the source's own `last_modified` (§5.1).
 */
export const SCHEMA_DATE_MODIFIED = 'http://schema.org/dateModified';
/** OKF `resource` = canonical URI of the underlying asset (SPEC §4.1). */
export const SCHEMA_URL = 'http://schema.org/url';
/** Legacy v0.1 `# Citations` links (v0.1 SPEC §8) — semantically distinct from concept edges. */
export const SCHEMA_CITATION = 'http://schema.org/citation';
/** Containment edge — opt-in target for type-pair relations (e.g. dataset→table). */
export const SCHEMA_HAS_PART = 'http://schema.org/hasPart';
/** Optional folder hierarchy (off by default — see ADR 0005). */
export const SCHEMA_IS_PART_OF = 'http://schema.org/isPartOf';

// --- W3C PROV-O ---
export const PROV_NS = 'http://www.w3.org/ns/prov#';
/**
 * Concept → the material it derives from (SPEC §5.1). Emitted alongside the
 * `okf:Source` node whenever a `sources[].resource` has an IRI: a bundle
 * concept (typed lineage edge, so credibility can propagate with a SPARQL
 * property path) or an absolute URL. Scope descriptors have no IRI and get no
 * derivation edge.
 */
export const PROV_WAS_DERIVED_FROM = PROV_NS + 'wasDerivedFrom';

// --- DKG ontology (converges with the extractor) ---
export const DKG_HAS_SECTION = 'http://dkg.io/ontology/hasSection';

// --- OKF v0.2 families (SPEC §5, §7, §10) ---
export const OKF_NS = 'http://dkg.io/ontology/okf/';
/** `generated.by` — actor literal (§5.2, §7). */
export const OKF_GENERATED_BY = OKF_NS + 'generatedBy';
/** Prefix for producer-defined keys nested inside `generated` (`generated<PascalKey>`). */
export const OKF_GENERATED_PREFIX = OKF_NS + 'generated';
/** Concept → one `okf:Verification` node per `verified[]` event (§5.2). */
export const OKF_VERIFICATION = OKF_NS + 'verification';
export const OKF_VERIFIED_BY = OKF_NS + 'verifiedBy';
export const OKF_VERIFIED_AT = OKF_NS + 'verifiedAt';
/** Derived §5.3 trust tier (`machine-confirmed` | `human-reviewed`); absent ⇒ `unverified`. */
export const OKF_TRUST_TIER = OKF_NS + 'trustTier';
/** `status` (§5.4). Absent ⇒ `stable` — the default is never materialised. */
export const OKF_STATUS = OKF_NS + 'status';
/** `stale_after` (§5.5), xsd:dateTime. */
export const OKF_STALE_AFTER = OKF_NS + 'staleAfter';
/** Concept → one `okf:Source` node per `sources[]` entry (§5.1). */
export const OKF_SOURCE = OKF_NS + 'source';
/** Path-valued field (§6.2): a concept IRI, an absolute URL, or a literal path / scope descriptor. */
export const OKF_RESOURCE = OKF_NS + 'resource';
/** `sources[].author` — actor literal (§5.1 credibility signal). */
export const OKF_AUTHOR = OKF_NS + 'author';
export const OKF_USAGE_COUNT = OKF_NS + 'usageCount';
export const OKF_USAGE_WINDOW_FROM = OKF_NS + 'usageWindowFrom';
export const OKF_USAGE_WINDOW_TO = OKF_NS + 'usageWindowTo';
/** Attested Computation contract (§10.2). */
export const OKF_RUNTIME = OKF_NS + 'runtime';
export const OKF_PARAMETER = OKF_NS + 'parameter';
export const OKF_PARAMETER_TYPE = OKF_NS + 'parameterType';
export const OKF_REQUIRED = OKF_NS + 'required';
export const OKF_COMPUTATION = OKF_NS + 'computation';
export const OKF_EXECUTOR_PREFIX = OKF_NS + 'executor';
export const OKF_EXECUTOR_RESOURCE = OKF_NS + 'executorResource';
export const OKF_EXECUTOR_RECEIPT = OKF_NS + 'executorReceipt';
export const OKF_ATTESTER_PREFIX = OKF_NS + 'attester';
export const OKF_ATTESTER_RESOURCE = OKF_NS + 'attesterResource';
/** Classes of the skolemized family nodes. */
export const OKF_CLASS_VERIFICATION = OKF_NS + 'Verification';
export const OKF_CLASS_SOURCE = OKF_NS + 'Source';
export const OKF_CLASS_PARAMETER = OKF_NS + 'Parameter';

/** The `type` value that makes a concept an Attested Computation (§10). */
export const OKF_ATTESTED_COMPUTATION_TYPE = 'Attested Computation';
/** Allowed `status` values (§5.4). Anything else is tolerated with a warning. */
export const OKF_STATUS_VALUES = ['draft', 'stable', 'deprecated'] as const;
/** Trust tiers, lowest to highest (§5.3). */
export const OKF_TRUST_TIERS = ['unverified', 'machine-confirmed', 'human-reviewed'] as const;

/**
 * Infix for deterministic skolem IRIs minted for `dkg:hasSection` nodes and
 * for the v0.2 family nodes (`okf:Verification`, `okf:Source`, `okf:Parameter`).
 * The daemon rejects blank-node RDF *objects* ("RDF object must be a quoted
 * literal term or absolute IRI"), so these nodes are skolemized into
 * concept-scoped IRIs `<conceptIri>/.well-known/genid/<tag><id>_<n>` — the
 * same `.well-known/genid/` scheme the node uses internally, so stored data is
 * identical whether or not the node would have skolemized them itself. Export
 * uses this infix to exclude the nodes from being rebuilt as concepts.
 */
export const SECTION_GENID_INFIX = '/.well-known/genid/';
/** Per-node-kind tags inside the genid IRI (`okfsec_<concept>_<n>`, …). */
export const GENID_TAGS = {
  section: 'okfsec_',
  verification: 'okfver_',
  source: 'okfsrc_',
  parameter: 'okfparam_',
} as const;

/** Default IRI namespace for concept Knowledge Asset subjects. */
export const DEFAULT_IRI_BASE = 'urn:okf:';

/** The OKF version this consumer targets (SPEC v0.2; v0.1 bundles consume under the §13.1 fallbacks). */
export const OKF_TARGET_VERSION = '0.2';
/** OKF versions this consumer understands; anything else is best-effort (§12) with a warning. */
export const OKF_KNOWN_VERSIONS = ['0.1', '0.2'] as const;
