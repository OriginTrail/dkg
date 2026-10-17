# ADR 0008 — OKF → RDF mapping and extractor reuse-vs-fork

- **Status**: Accepted
- **Date**: 2026-06-25
- **Version**: v10
- **Package**: `packages/okf` (`@origintrail-official/dkg-okf`)
- **Related**: archived ADR 0002
  ([importer chunking contract](../archive/internal/adr/0002-importer-chunking-contract.md)),
  archived ADR 0003
  ([code-graph ontology convergence](../archive/internal/adr/0003-code-graph-ontology-convergence.md)),
  `packages/cli/src/extraction/markdown-extractor.ts`,
  OKF SPEC v0.1 (`GoogleCloudPlatform/knowledge-catalog`, commit
  `d44368c15e38e7c92481c5992e4f9b5b421a801d`)
- **History**: Written by Ziga Drev as ADR 0005 on the original OKF integration
  branch ([#1331](https://github.com/OriginTrail/dkg/pull/1331), commit
  `b073363392386ac3aeaf9bdb508218424148e891`). That branch was later ported
  onto v10.0.1 as one commit without its `docs/` changes, so the package
  shipped in [#1388](https://github.com/OriginTrail/dkg/pull/1388) without this
  record. Restored on 2026-10-14 as ADR 0008, because 0005 now belongs to the
  KafkaStream ADR. Apart from its number and the links to the archived ADRs,
  the text is as written; the differences found in the shipped package when
  it was restored are under
  [Where the shipped package differs](#where-the-shipped-package-differs).

## Context

Google's Open Knowledge Format (OKF) standardises *how* knowledge is written and
exchanged — portable UTF-8 Markdown with YAML frontmatter and cross-links that
form a graph — but deliberately ships **no** verification, provenance or
ownership layer (OKF SPEC §1, §10). The DKG supplies exactly that. We want to
ingest an OKF bundle as deterministic, owned, verifiable Knowledge Assets,
reconstructing the bundle's cross-concept link graph, and surface it as a
first-class integration.

Two questions had to be settled before writing code:

1. **Reuse or fork the existing Markdown extractor?** The node already ingests
   Markdown deterministically via `markdown-extractor.ts`. Convergence — an OKF
   import and a natively-ingested Markdown corpus yielding joinable graphs — is a
   goal.
2. **What is the exact OKF → RDF predicate mapping?** It must be deterministic
   (no LLM), reconcile with the extractor's predicates, and honour OKF's
   permissive consumer rules (§9).

## Decision

### Reuse the vocabulary, not the code; add a real Markdown AST

The existing extractor is **regex-based** and resolves only `[[wikilinks]]` →
`schema:mentions`. OKF cross-links are standard Markdown links `[text](path.md)`,
which that extractor does not handle. Importing `extractFromMarkdown` from
`packages/cli` into `packages/okf` would also create a `cli → okf → cli`
dependency cycle (the CLI `okf` command depends on this package).

Therefore:

- **Converge on the extractor's predicate vocabulary** (`rdf:type`,
  `schema:name`, `schema:description`, `schema:keywords`, `schema:mentions`,
  `http://dkg.io/ontology/hasSection`), re-declaring the same literal IRIs in
  `constants.ts` and pinning the convergence with a test. The object encoding
  (raw IRIs without angle brackets; literals as `"…"` / `"…"^^<dt>`; blanks as
  `_:…`) matches the node's `Quad` term form so output drops straight into
  `/api/knowledge-assets/.../wm/write`.
- **Use a real Markdown AST** (`mdast-util-from-markdown`) for link, section and
  citation extraction, as OKF §2 requires — this is what lets the importer honour
  CommonMark semantics for links inside inline code spans.
- Keep `packages/okf` **runtime-standalone** (local `isSafeIri`, local `Quad`
  type, no `dkg-core` runtime import) so the pure mapper is unit-testable in
  isolation.

### Locked OKF → RDF mapping

| OKF frontmatter / construct | RDF predicate | Object | Notes |
|---|---|---|---|
| `type` (required) | `rdf:type` | full IRI as-is, else `http://schema.org/<PascalCase>` | `BigQuery Dataset` → `schema:BigQueryDataset` |
| `title` | `schema:name` | literal | |
| `description` | `schema:description` | literal | |
| `tags` (list) | `schema:keywords` | one literal per tag | converges with the extractor's hashtag handling |
| `timestamp` (ISO 8601) | `schema:dateModified` | literal `^^xsd:dateTime` | OKF defines it as last-modified |
| `resource` (canonical URI) | `schema:url` | IRI | chosen over `dcterms:source`; absent for abstract concepts |
| producer-defined keys | `http://schema.org/<camelCase>` | typed literal / IRI | **preserved, never dropped** (§4.1, §9) |
| concept link (§5) | `schema:mentions` | target concept IRI | **one untyped directed edge** — no FK/join inference (§5.3) |
| `# Citations` URL (§8) | `schema:citation` | URL IRI | numbered + bare-bullet styles; distinct from edges |
| body headings (`# …`) | `dkg:hasSection` | section blank node + `schema:name` | OKF titles live in frontmatter, so body H1s are genuine sections |
| folder hierarchy | `schema:isPartOf` | parent IRI | **off by default** (directories are not concepts) |

### IRI derivation

Concept subject IRI = `urn:okf:<conceptId>` (configurable base), a pure function
of the concept ID. Same bundle ⇒ same IRIs. This is the RDF subject; the on-chain
UAL is assigned by the node at VM publish (RFC-43 pre-knowable UALs are draft) and
is a distinct identifier.

### Edge cases (the judgement calls)

- **Links inside inline code spans** are **not** edges by default (CommonMark:
  code-span content is literal text). Recorded as `codeSpanLinks` + warned.
  `--include-code-span-links` opts in. This is the only place the prompt's
  illustrative acceptance list (`outputs → transactions, inputs`) and the
  implementation diverge — by design, and documented here and in `CONTEXT.md`.
- **Broken links** (resolved target not in the bundle) → warning, never fatal
  (§5.3, §9); the target may be not-yet-written knowledge.
- **Reserved files** (`index.md`, `log.md`) are never minted as KAs; `okf_version`
  is read only from a root `index.md` (§11).
- **Conformance** is permissive: only unparseable frontmatter or a missing
  non-empty `type` make a bundle non-conformant (§9); all other irregularities
  are tolerated.

### Determinism

The mapper is pure and LLM-free. Quads are serialised to canonical N-Quads
(deduped + lexically sorted), so the same bundle yields byte-identical output and
independent importers converge on the same graph (consistent with archived
ADR 0002).

## Consequences

- An OKF import and a native Markdown import share predicates and therefore join
  naturally in SPARQL.
- The mapper is a clean, isolated, unit-tested unit; the CLI command and the node
  are thin wrappers.
- `export.ts` is the clean inverse (graph-faithful, not byte-faithful): bodies are
  regenerated structurally, so round-trip equivalence is asserted over the
  semantic (non-`hasSection`) quad set.
- We do **not** infer typed FK/join semantics from untyped OKF links; surfacing
  that would require a separate, clearly-labelled Layer-2 enrichment pass.

## Where the shipped package differs

Found when this record was restored; the package that shipped in #1388 is
authoritative where the two disagree. The first two changes landed on the #1331
branch after this record was written, and the third came in #1388's review.

- **Section nodes are skolemized IRIs, not blank nodes.** The daemon rejects
  blank-node RDF objects, so each `dkg:hasSection` object is a deterministic
  concept-scoped IRI, `<conceptIri>/.well-known/genid/okfsec_<id>_<n>`
  (`SECTION_GENID_INFIX` in `packages/okf/src/constants.ts`), carrying the
  heading as `schema:name`. Export uses the same infix to keep section nodes out
  of the rebuilt concepts.
- **Opt-in typed edges.** `typeRelations` (`--relate` on the CLI) retypes a
  `schema:mentions` edge by its endpoints' OKF `type` pair, e.g. `schema:hasPart`
  from a dataset to its tables. It is off by default, so without it every edge
  is still one untyped `schema:mentions` (see `packages/okf/CONTEXT.md`).
- **A third conformance rule.** Each concept path segment must match
  `[A-Za-z0-9_][A-Za-z0-9_.-]*` (§2), because any other segment would mint a
  malformed subject IRI. `validateBundle` reports a violation as a hard error,
  and `importBundle` skips that concept with a warning.
- **No test pins the vocabulary convergence.** No test compares these IRIs with
  the extractor's. The okf tests assert the literal `rdf:type` and `schema:*`
  IRIs, but check `dkg:hasSection` only through the shared constant.
