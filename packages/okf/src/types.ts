/**
 * Public types for the OKF → DKG mapper.
 *
 * The RDF output is a deterministic array of `Quad`s. We reuse the node's
 * canonical `Quad` shape (`{ subject, predicate, object, graph? }`) so the
 * mapper's output drops straight into the importer/`/api/assertion/write`
 * path without translation.
 */

/** Canonical quad shape, structurally identical to `dkg-core`'s extraction `Quad`. */
export interface Quad {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

/** A parsed OKF concept document (frontmatter + body), per SPEC §4. */
export interface OkfDocument {
  /** Bundle-relative concept ID (path with `.md` removed), e.g. `tables/blocks`. */
  conceptId: string;
  /** Path segments of the concept ID, e.g. `['tables', 'blocks']`. */
  segments: string[];
  /** Parsed YAML frontmatter (empty object if none). */
  frontmatter: Record<string, unknown>;
  /** Markdown body (everything after the closing `---`). */
  body: string;
}

/** A resolved or unresolved cross-link discovered in a concept body (SPEC §6). */
export interface OkfLink {
  /** Raw link target as written in the Markdown, e.g. `../tables/blocks.md`. */
  raw: string;
  /** Resolved target concept ID if it exists in the bundle, else `null`. */
  targetConceptId: string | null;
  /** True when the link sat inside an inline code span (SPEC/CommonMark edge case). */
  inCodeSpan: boolean;
}

/** A citation captured from a legacy v0.1 `# Citations` section (v0.2 SPEC §13.1 fallback). */
export interface OkfCitation {
  /** The cited URL (external in the wild). */
  url: string;
  /** Optional human label (numbered `[n] [label](url)` style). */
  label?: string;
}

/**
 * A deterministic, opt-in rule that types a cross-concept edge by the OKF
 * `type` of its two endpoints — no LLM, no prose parsing. e.g. a link from a
 * `BigQuery Dataset` to a `BigQuery Table` is containment (`schema:hasPart`),
 * while `BigQuery Table` → `BigQuery Table` stays an untyped reference
 * (`schema:mentions`). Both endpoint types come straight from frontmatter, so
 * this is byte-stable. Default behaviour (no rules) keeps every edge as
 * `schema:mentions`, preserving the "links are untyped per SPEC §6.1" guarantee.
 */
export interface TypeRelation {
  /** Source concept's OKF `type` (exact string, e.g. `BigQuery Dataset`). */
  from: string;
  /** Target concept's OKF `type`. */
  to: string;
  /** Predicate IRI to use for edges matching this (from,to) type pair. */
  predicate: string;
}

/** Mapping options. All deterministic; no network, no LLM. */
export interface OkfMappingOptions {
  /** IRI namespace for concept subjects. Default `urn:okf:`. */
  iriBase?: string;
  /**
   * Opt-in type-pair edge typing. Empty/undefined ⇒ every cross-concept edge is
   * `schema:mentions` (the faithful, zero-interpretation default).
   */
  typeRelations?: TypeRelation[];
  /**
   * Whether a concept link written inside an inline code span counts as an edge.
   * Default `false` — CommonMark treats code-span content as literal text, so it
   * is NOT a link. See ADR 0005 / CONTEXT.md "Flagged ambiguities".
   */
  includeCodeSpanLinks?: boolean;
  /**
   * Whether to emit `schema:isPartOf` triples reflecting the folder hierarchy.
   * Default `false` — directories are not concepts, so minting them as nodes
   * muddies the concept graph. See ADR 0005.
   */
  emitFolderHierarchy?: boolean;
}

/** Trust tiers, lowest to highest (SPEC §5.3). */
export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

/** Lifecycle status (SPEC §5.4). Absent ⇒ `stable`. */
export type OkfStatus = 'draft' | 'stable' | 'deprecated';

/** One normalised `verified[]` event (SPEC §5.2). */
export interface VerificationEvent {
  /** Actor (§7), e.g. `human:jsmith@acme`, `process:finance-nightly`, `reference_agent/gemini-2.5-pro`. */
  by: string;
  /** ISO 8601 lexical of the confirmation instant, or `null` when absent/unparseable. */
  at: string | null;
  /** Producer-defined keys on the event, preserved verbatim. */
  extra: Record<string, unknown>;
}

/**
 * Per-concept v0.2 trust / provenance / lifecycle summary, derived from
 * frontmatter exactly as SPEC §5 prescribes (no inference). Staleness is
 * time-dependent and therefore NOT materialised here — use `isStale()`.
 */
export interface ConceptTrust {
  /** §5.3 tier derived from `verified`. */
  tier: TrustTier;
  /** §5.4 status; `stable` when absent. An unknown value is passed through. */
  status: OkfStatus | string;
  /** §5.5 `stale_after` lexical, or `null`. */
  staleAfter: string | null;
  /** `generated.by` actor, or `null`. */
  generatedBy: string | null;
  /** `generated.at`, falling back to the legacy v0.1 `timestamp` (§13.1), or `null`. */
  generatedAt: string | null;
  /** Number of well-formed `verified[]` events. */
  verifications: number;
  /** Number of `sources[]` entries. */
  sources: number;
  /** Bundle concepts this concept derives from via `sources[].resource` (sorted, unique). */
  derivedFromConcepts: string[];
  /** True when `type` is `Attested Computation` (§10). */
  attestedComputation: boolean;
}

/** Per-concept mapping result. */
export interface ConceptMapping {
  conceptId: string;
  /** Deterministic subject IRI for this concept's Knowledge Asset. */
  iri: string;
  /** Content + linkage triples for this concept (including its skolemized section / family nodes). */
  quads: Quad[];
  /** Resolved concept→concept edges (subset of body links). */
  resolvedLinks: OkfLink[];
  /** Links whose target is not in the bundle (warned, never fatal — SPEC §6.1/§11). */
  brokenLinks: OkfLink[];
  /** Links skipped because they sat in a code span and the option is off. */
  codeSpanLinks: OkfLink[];
  /** Legacy citations captured (distinct from concept edges). */
  citations: OkfCitation[];
  /** v0.2 trust / provenance / lifecycle summary (SPEC §5, §10). */
  trust: ConceptTrust;
  /** Non-fatal diagnostics raised while mapping this concept (v0.2 family shape, footnotes, broken source paths). */
  warnings: OkfWarning[];
}

/** A non-fatal diagnostic surfaced during a bundle import. */
export interface OkfWarning {
  conceptId?: string;
  code:
    | 'broken-link'
    | 'code-span-link'
    | 'missing-type'
    | 'reserved-skip'
    | 'parse'
    | 'invalid-path'
    | 'malformed-family'
    | 'unknown-footnote'
    | 'unsupported-version';
  message: string;
}

/** Result of importing a whole bundle. */
export interface BundleImport {
  /** OKF version declared in the root `index.md`, if any (SPEC §12). */
  okfVersion: string | null;
  /** Concept ID → subject IRI map (Pass 1). */
  iriByConceptId: Record<string, string>;
  /** Per-concept mappings (Pass 2). */
  concepts: ConceptMapping[];
  /** Reserved files (`index.md` / `log.md`) skipped — never minted as KAs. */
  reservedSkipped: string[];
  /** All quads across all concepts, in concept order. */
  quads: Quad[];
  /** Non-fatal diagnostics. */
  warnings: OkfWarning[];
}

/**
 * The minimum the exporter needs: a concept's ID, subject IRI and quads
 * (including any skolemized family nodes under the subject). A `BundleImport`
 * satisfies this; so does a set of concepts rebuilt from a SPARQL query.
 */
export interface ExportInput {
  concepts: Array<Pick<ConceptMapping, 'conceptId' | 'iri' | 'quads'>>;
}

/** A single file fed to the in-memory mapper (path is bundle-relative, POSIX). */
export interface BundleFile {
  /** Bundle-relative POSIX path including extension, e.g. `tables/blocks.md`. */
  path: string;
  /** UTF-8 file contents. */
  content: string;
}

/** §11 conformance report. */
export interface ConformanceReport {
  conformant: boolean;
  /** Hard violations — only §11 rules 1–2 (parseable frontmatter + non-empty `type`) make a bundle non-conformant; reserved-file structure issues are warnings. */
  errors: string[];
  /** Things consumers MUST tolerate (§11) — surfaced as info, never failing. */
  warnings: string[];
}
