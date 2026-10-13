# OKF

Deterministic Google Open Knowledge Format (OKF v0.2) → DKG mapper. Turns a
portable OKF bundle (Markdown + YAML frontmatter + untyped cross-links) into
owned, verifiable RDF Knowledge Assets, reconstructing the bundle's
cross-concept link graph and carrying the v0.2 provenance / trust / lifecycle /
attestation families as queryable triples. Pure, no LLM, no network: the same
bundle always yields identical triples and IRIs. The `dkg okf` CLI command is a
thin wrapper over this package.

The framing: OKF standardises *how* knowledge is written and exchanged and, in
v0.2, *records* trust signals (`generated`, `verified`, `sources`, `status`,
`stale_after`, Attested Computations) — but it ships **no** verification,
provenance or ownership layer (OKF SPEC §1: "OKF records the computation and
the means to check it; it does not execute anything itself"; a `verified`
entry is a string, not a signature). The DKG supplies exactly that. This
package is the bridge — the trust-and-permanence backend for OKF.

## Language

**Bundle**:
A directory tree of UTF-8 Markdown files; the unit of distribution (OKF §3). Fed
to the mapper as an in-memory `BundleFile[]` (`{ path, content }`, POSIX paths).
`loadBundleDir` is the only filesystem surface; the mapper itself is I/O-free.

**Concept**:
One non-reserved `.md` file = YAML frontmatter + Markdown body (OKF §4). Each
concept becomes exactly one Knowledge Asset. Reserved `index.md` / `log.md`
files are **not** concepts and are never minted as KAs (OKF §3.1, §8, §9).

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
A standard Markdown link `[text](path)` from one concept to another (OKF §6).
Resolved against the bundle (absolute `/abs`, relative `./`, parent `../`,
bare-sibling, extension-less forms) into an **untyped directed edge**
(`schema:mentions`). The kind of relationship lives in prose, not the link
(OKF §6.1) — the mapper never infers FK/join types. Broken links are warnings,
never errors (OKF §6.1, §11).

**Citation**:
A link (usually an external URL) under a legacy v0.1 `# Citations` heading,
backing a claim. Mapped to `schema:citation`, semantically distinct from concept
edges. Superseded in v0.2 by `sources` (§13.1) but still parsed.

**Family** (v0.2):
One of the optional frontmatter groups SPEC §5 and §10 define — provenance
(`sources`, `usage_window`), trust (`generated`, `verified`), lifecycle
(`status`, `stale_after`) and the Attested Computation contract (`runtime`,
`parameters`, `computation`, `executor`, `attester`). Mapped by `families.ts`
into the `okf:` namespace (`http://dkg.io/ontology/okf/`) plus `prov:` and the
existing `schema:` terms. Single values sit flat on the concept; each entry of a
list-valued family (`sources`, `verified`, `parameters`) becomes a **family
node** — a skolemized IRI `<conceptIri>/.well-known/genid/okf{src,ver,param}_<id>_<n>`
typed `okf:Source` / `okf:Verification` / `okf:Parameter`, with the entry index
`n` in the IRI so export restores the original order.

**Actor** (§7):
The string convention `human:<id>` / `process:<id>` / `<producer>/<version>`
used by `generated.by`, `verified[].by` and `sources[].author`. Always an RDF
literal (`okf:generatedBy`, `okf:verifiedBy`, `okf:author`) — never an IRI —
because the convention is a string, and trust tiering keys off the `human:`
prefix (§5.3), which a consumer reads straight from the literal.

**Trust tier** (§5.3):
Derived once from `verified`: no verifier ⇒ `unverified`, non-`human:` actors
only ⇒ `machine-confirmed`, any `human:` actor ⇒ `human-reviewed`. Materialised
as `okf:trustTier` only when a verifier exists; absence *is* the unverified
signal. Advisory, never access control.

**Staleness** (§5.5):
`now >= stale_after`. Time-dependent, so never a triple — `isStale()` computes
it; the CLI summary reports it against the current time.

**Memory layers** (where imported assets live):
- **WM** (Working Memory): private to one agent, free, reversible. The import
  default.
- **SWM** (Shared Working Memory): team-visible, gossip-replicated, free,
  TTL-bounded. Reached with `--share` (finalize + advance).
- **Private import** (`--private`): same per-concept KA lifecycle as `--share`,
  but the target Context Graph is invite-only; each concept is finalized and
  shared to SWM without VM promotion.
- **VM** (Verifiable Memory): on-chain, permanent, costs TRAC. **Never** written
  by this package; promotion is a separate, explicitly-gated operator step.

## Relationships

- Bundle → many Concepts (+ reserved files, skipped). Pass 1 indexes the bundle
  and builds the `conceptId → IRI` map; Pass 2 maps each concept and resolves its
  links against that map (so an edge only forms to a concept that exists).
- Concept → one Knowledge Asset (one subject IRI) → many quads (frontmatter
  triples + family nodes + body sections + untyped edges + citations).
- Frontmatter key → RDF predicate via the locked table (ADR 0005; the v0.2 rows
  are in `README.md`). `type` is the only required key (OKF §11); everything
  else degrades gracefully when absent.
- Link → `schema:mentions` edge **iff** its resolved target is a concept in the
  bundle; otherwise it is a broken-link warning (target may be not-yet-written
  knowledge) or, for external URLs, simply ignored as a non-edge.
- **Path-valued fields** (`sources[].resource`, `computation`,
  `executor.resource`, `attester.resource` — §6.2) resolve the same way, with
  one extra step: file-relative first (the §6.2 rule), then bundle-root-relative
  (the convention Google's own reference bundles use, e.g.
  `policies/x.md` written from `metrics/y.md`). A concept → its IRI (a typed
  edge); an absolute URL → an IRI; anything else → a literal (a `references/`
  artifact, an attester `.py`, a scope descriptor such as
  `all queries in BigQuery project X`).
- **Lineage** (§5.1 "lineage is expressed through links"): every
  `sources[].resource` with an IRI additionally yields
  `<concept> prov:wasDerivedFrom <resource>` on the concept itself, so
  credibility can propagate through the graph with a SPARQL property path
  (`?c prov:wasDerivedFrom+ ?root`) — the recursion the spec invites consumers
  to do. Scope descriptors get no derivation edge (they have no IRI).
- **Derived triples** (`okf:trustTier`, `prov:wasDerivedFrom`) are consumer
  derivations, so export never writes them back; the next import re-derives
  them. Round trip is therefore graph-equal.
- **`generated.at` and the legacy `timestamp`** both land on
  `schema:dateModified`, so a mixed v0.1 / v0.2 corpus is uniformly queryable
  by one last-modified predicate. `generated.at` wins when both are present;
  the leftover `timestamp` is preserved as the producer key `schema:timestamp`.
- **Opt-in typed edges (`typeRelations` / `--relate`).** By default every edge is
  `schema:mentions` (zero interpretation, faithful to OKF §6.1's untyped links).
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
  (untyped) OKF link because OKF can't express the relation type. The v0.2
  families are rebuilt in their original entry order from the node IRIs. This
  is a deliberate choice, not a defect; a future enhancement may have export
  *add* provenance (UAL / seal, e.g. a `verified` entry naming the DKG
  publisher) when serialising from a published graph.
- **Diagnostics are shared.** `familyDiagnostics` (context-free shape checks)
  feeds both `validateBundle` (as strings) and `importBundle` (as coded
  warnings), so the two never disagree. Only the mapper adds the
  context-dependent findings (unresolved bundle paths, dangling footnotes).

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
  name is idempotent — except that the original spacing is not recoverable
  (`BigQueryDataset` exports as written). The one spec-defined type whose exact
  spelling carries meaning, `Attested Computation` (§10.5 discovery is by that
  string), is special-cased on export, and detection (`isAttestedComputationType`)
  accepts both spellings.
- **Root-relative vs. file-relative paths (upstream issue #29).** SPEC §6.2 says a
  path without a leading `/` is file-relative, but Google's own `acme_retail`
  bundle writes `policies/x.md` from `metrics/y.md` meaning bundle-root-relative.
  We resolve file-relative first, then root-relative, so both conventions work;
  export always writes the unambiguous absolute `/path.md` form.
- **Timestamps.** YAML parsers (js-yaml here, PyYAML in the reference agent) turn
  an unquoted `2026-06-30T14:00:00Z` into a native datetime; a quoted one stays a
  string. A native `Date` is rendered in XSD canonical form (`Z`, no `.000`) so
  the common spelling round-trips byte-for-byte; an offset-bearing value folds to
  UTC (same instant — the deployed store canonicalises xsd:dateTime the same way).
  A value that is not a valid xsd:dateTime / xsd:date lexical is kept as a
  **plain** literal with a warning, never as a bogus typed literal that would
  poison date comparisons. Missing explicit offsets (§5 requires one) warn.
- **Actors are literals, not IRIs.** Minting `urn:okf:actor:human:x` nodes would
  let a later layer link actors to DIDs / wallets, but the convention is a string
  and IRI-encoding `@`, spaces or `%` adds an invertibility problem for no
  consumer benefit today. A DID binding can be added as a separate, opt-in edge
  without changing these triples.
- **`executor.receipt` order.** A multi-valued RDF property is unordered, so the
  receipt field list comes back sorted from export (set semantics — it declares
  the fields a run must return). `parameters`, `verified` and `sources` keep
  their order because the entry index is in the node IRI.
- **Both `timestamp` and `generated` present.** Unusual (a migration leftover).
  `generated.at` → `schema:dateModified`; `timestamp` → `schema:timestamp` (the
  node extractor's own slug for that key), preserved and exported verbatim.
- **Nested producer values are `rdf:JSON`.** A mapping-valued producer key (e.g.
  the `not:` extension in `acme_retail`) is carried as
  `"…"^^rdf:JSON` so it exports back as an object; previously it degraded to a
  string. Scalars keep their xsd types; the deployed stores keep custom
  datatypes verbatim.
- **Footnotes are checked only when `sources` is declared.** `[^label]` must join
  a `sources[].id` (§5.1); a v0.1-style document using footnotes for anything
  else is left alone. Detection is on body text nodes, so a label whose
  definition happens to parse as a CommonMark link reference definition is
  silently skipped (false negative only).
- **Google's `acme_retail` `log.md` carries frontmatter**, which §8/§9 say a
  reserved file should not. It is tolerated with a warning and never minted.
- **Versioning.** The consumer targets 0.2 and reads 0.1 under the §13.1
  fallbacks; any other declared `okf_version` warns and is consumed best-effort
  (§12). Export always declares `okf_version: "0.2"` in the root `index.md`.
- **`timestamp` → `schema:dateModified`.** OKF defines `timestamp` as last-modified
  time, so we map it to `schema:dateModified` (typed `xsd:dateTime`) rather than
  the extractor's naive `schema:timestamp` slug — a deliberate semantic choice.
- **`resource` → `schema:url`.** Chosen over `dcterms:source`; documented in ADR 0005.
- **Citations, two styles.** Both numbered (`[1] [text](url)`) and bare-bullet
  (`- https://…`) forms are parsed leniently; deduplicated by URL. Export does
  not migrate them to `sources` (a faithful inverse, not a migration tool).
- **Folder hierarchy.** `schema:isPartOf` from directory structure is **off by
  default** — directories are not concepts, and minting them as graph nodes would
  muddy the concept graph. Available via `emitFolderHierarchy`; export ignores it
  (the path implies it).
- **Producer-defined keys** are always preserved (camelCased into schema.org),
  never dropped or rejected (OKF §4.1, §11). Unknown keys *inside* a family are
  preserved too, under the family-scoped extension predicate
  `okf:<familyKey>.<percent-encoded key>` on the family's subject (the concept
  for `generated` / `executor` / `attester` / `usage_window`, the entry's node
  for `verified` / `sources` / `parameters`). Unlike the top-level camelCase
  convention this is invertible: `timeout_s`, `sample rate` and `café` come back
  exactly, and the predicate is always IRI-safe. The top-level convention is
  left as it was in v0.1 so an OKF import keeps converging with the node's
  Markdown extractor.
- **Each triple once.** The mapper deduplicates its output per concept: a store
  holds a set, so two `sources` naming one resource give two `okf:Source` nodes
  but a single `prov:wasDerivedFrom` edge. Without this the expected count in
  `dkg okf verify` exceeded what any complete import can store, a permanent
  false shortfall; the verifier also counts distinct triples on its own.
- **Conformance is permissive.** Only two rules make a bundle non-conformant
  (unparseable frontmatter; missing non-empty `type`). Missing optionals, unknown
  types/keys, broken links, missing `index.md`, malformed families and unknown
  versions are tolerated (OKF §11).
