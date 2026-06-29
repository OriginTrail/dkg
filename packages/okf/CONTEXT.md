# OKF

Deterministic Google Open Knowledge Format (OKF) → DKG mapper. Turns a portable
OKF bundle (Markdown + YAML frontmatter + untyped cross-links) into owned,
verifiable RDF Knowledge Assets, reconstructing the bundle's cross-concept link
graph. Pure, no LLM, no network: the same bundle always yields identical triples
and IRIs. The `dkg okf` CLI command is a thin wrapper over this package.

The framing: OKF standardises *how* knowledge is written and exchanged but ships
**no** verification, provenance or ownership layer (OKF SPEC §1, §10). The DKG
supplies exactly that. This package is the bridge — the trust-and-permanence
backend for OKF.

## Language

**Bundle**:
A directory tree of UTF-8 Markdown files; the unit of distribution (OKF §3). Fed
to the mapper as an in-memory `BundleFile[]` (`{ path, content }`, POSIX paths).
`loadBundleDir` is the only filesystem surface; the mapper itself is I/O-free.

**Concept**:
One non-reserved `.md` file = YAML frontmatter + Markdown body (OKF §4). Each
concept becomes exactly one Knowledge Asset. Reserved `index.md` / `log.md`
files are **not** concepts and are never minted as KAs (OKF §3.1, §6, §7).

**Concept ID**:
The file's bundle-relative path with `.md` removed (OKF §2) — e.g.
`tables/blocks`. The path *is* the concept's identity. Segment validation agrees
byte-for-byte with the reference agent's `paths.py` (`[A-Za-z0-9_][A-Za-z0-9_.\-]*`).

**IRI**:
The Knowledge Asset subject IRI, derived deterministically from the concept ID:
`urn:okf:<conceptId>` (configurable base). Same bundle ⇒ same IRIs. This is the
RDF subject; the on-chain UAL is assigned by the node at publish time (it is not
the same thing — see Flagged ambiguities).

**Link**:
A standard Markdown link `[text](path)` from one concept to another (OKF §5).
Resolved against the bundle (absolute `/abs`, relative `./`, parent `../`,
bare-sibling, extension-less forms) into an **untyped directed edge**
(`schema:mentions`). The kind of relationship lives in prose, not the link
(OKF §5.3) — the mapper never infers FK/join types. Broken links are warnings,
never errors (OKF §5.3, §9).

**Citation**:
A link (usually an external URL) under a `# Citations` heading (OKF §8), backing
a claim. Mapped to `schema:citation`, semantically distinct from concept edges.

**Memory layers** (where imported assets live):
- **WM** (Working Memory): private to one agent, free, reversible. The import
  default.
- **SWM** (Shared Working Memory): team-visible, gossip-replicated, free,
  TTL-bounded. Reached with `--share` (finalize + advance).
- **VM** (Verifiable Memory): on-chain, permanent, costs TRAC. **Never** written
  by this package; promotion is a separate, explicitly-gated operator step.

## Relationships

- Bundle → many Concepts (+ reserved files, skipped). Pass 1 indexes the bundle
  and builds the `conceptId → IRI` map; Pass 2 maps each concept and resolves its
  links against that map (so an edge only forms to a concept that exists).
- Concept → one Knowledge Asset (one subject IRI) → many quads (frontmatter
  triples + body sections + untyped edges + citations).
- Frontmatter key → RDF predicate via the locked table (ADR 0005). `type` is the
  only required key (OKF §9); everything else degrades gracefully when absent.
- Link → `schema:mentions` edge **iff** its resolved target is a concept in the
  bundle; otherwise it is a broken-link warning (target may be not-yet-written
  knowledge) or, for external URLs, simply ignored as a non-edge.
- **Opt-in typed edges (`typeRelations` / `--relate`).** By default every edge is
  `schema:mentions` (zero interpretation, faithful to OKF §5.3's untyped links).
  A caller may supply deterministic `(fromType, toType) → predicate` rules to
  type edges by their endpoints' OKF `type` — e.g. `BigQuery Dataset → BigQuery
  Table = schema:hasPart` (containment) while `Table → Table` stays `mentions`.
  This is byte-stable (types come straight from frontmatter, no prose, no LLM)
  and **off by default** so the purity guarantee holds unless explicitly opted in.
  Caveat: the rule is endpoint-type-based, so it cannot distinguish a same-dataset
  containment link from a cross-dataset reference of the same type pair — use it
  where that distinction doesn't apply, or leave the default.
- **Round-trip is graph-faithful, not byte-faithful, by design.** `import →
  export → import` reproduces an equivalent *semantic graph*, not the original
  bytes: free-form prose isn't recoverable from triples, so export regenerates
  bodies structurally, and a typed edge (e.g. `hasPart`) exports as a plain
  (untyped) OKF link because OKF can't express the relation type. This is a
  deliberate choice, not a defect; a future enhancement may have export *add*
  provenance (UAL / seal) when serialising from a published graph.

## Flagged ambiguities

- **Reuse vs. fork of the Markdown extractor.** The node's `markdown-extractor.ts`
  is regex-based and resolves only `[[wikilinks]]`, not OKF's `[text](path)`
  links; importing it from `packages/cli` would also create a `cli → okf → cli`
  dependency cycle. So we **converge on its predicate vocabulary** (same
  `schema:*` / `dkg:hasSection` IRIs, pinned by a test) but use a **real Markdown
  AST** (`mdast-util-from-markdown`) for link/section/citation extraction — which
  OKF §2 mandates and which is what lets us honour the in-code-span rule below.
- **Links inside inline code spans.** `outputs.md` writes its only two concept
  links inside backticks: `` `[transactions](transactions.md)` ``. CommonMark
  treats code-span content as literal text, so **by default these are NOT edges**
  (the mechanism-first answer). They are recorded as `codeSpanLinks` and surfaced
  as warnings. `--include-code-span-links` flips the policy; both behaviours are
  tested.
- **IRI derivation / UAL.** Concept subject IRIs are `urn:okf:<conceptId>`, a pure
  function of the concept ID. The on-chain UAL (`did:dkg:<chain>/<ka>/<n>`) is
  assigned by the node at VM publish (RFC-43 pre-knowable UALs are still draft) —
  do not conflate the two. WM/SWM data carries no on-chain verification.
- **`type` normalisation.** A bare `type` value is PascalCased into the schema.org
  namespace (`BigQuery Dataset` → `http://schema.org/BigQueryDataset`); a full IRI
  `type` is used unchanged. Round-trips losslessly because PascalCase of the local
  name is idempotent.
- **`timestamp` → `schema:dateModified`.** OKF defines `timestamp` as last-modified
  time, so we map it to `schema:dateModified` (typed `xsd:dateTime`) rather than
  the extractor's naive `schema:timestamp` slug — a deliberate semantic choice.
- **`resource` → `schema:url`.** Chosen over `dcterms:source`; documented in ADR 0005.
- **Citations, two styles.** Both numbered (`[1] [text](url)`) and bare-bullet
  (`- https://…`) forms are parsed leniently; deduplicated by URL.
- **Folder hierarchy.** `schema:isPartOf` from directory structure is **off by
  default** — directories are not concepts, and minting them as graph nodes would
  muddy the concept graph. Available via `emitFolderHierarchy`.
- **Producer-defined keys** are always preserved (camelCased into schema.org),
  never dropped or rejected (OKF §4.1, §9).
- **Conformance is permissive.** Only two rules make a bundle non-conformant
  (unparseable frontmatter; missing non-empty `type`). Missing optionals, unknown
  types/keys, broken links and missing `index.md` are tolerated (OKF §9).
