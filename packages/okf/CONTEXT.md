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
`parameters`, `computation`, `executor`, `attester`). Mapped into the `okf:`
namespace (`http://dkg.io/ontology/okf/`) plus `prov:` and the existing
`schema:` terms. Single values sit flat on the concept; each entry of a
list-valued family (`sources`, `verified`, `parameters`) becomes a **family
node** — a skolemized IRI `<conceptIri>/.well-known/genid/okf{src,ver,param}_<id>_<n>`
typed `okf:Source` / `okf:Verification` / `okf:Parameter`, with `n` the entry's
position among the usable entries: export restores the original order from it,
and because a skipped entry (a `verified` entry without `by`, an entry that is
not a mapping) takes no number, re-importing an export, which writes only the
usable entries, mints the same IRIs. Warnings name an entry by its position in
the list as written.

**Family definition** (`src/families/specs.ts`):
The one declaration of a family: its shape (scalar, mapping or list), its
ordered field → predicate table with each field's kind (text, token, actor,
date, integer, boolean, path, text-list), and its diagnostic wording. The
encoder (`families/encode.ts`), the decoder (`families/decode.ts`), the shape
diagnostics (`families/diagnostics.ts`) and the verification parser
(`parseVerified`) all read it, so adding or changing a field is one edit.
Field order is also the key order export writes. Every behaviour is a field of
the definition — `derivesLineage` (adds `prov:wasDerivedFrom`),
`derivesTrustTier` (`verified` materialises the tier), `allowedValues`
(`status`) and `requiredForType` (`runtime` on an Attested Computation) — so no
code depends on which definition object it is handed. The definitions are
internal: the package exports the operations built on them (`familyQuads`,
`familyDiagnostics`, `parseVerified`, `exportInputFromQuads`, …), not the
descriptors.

**Parsed list** (`parseList`):
The single classification of a list family's entries — which are mappings,
which become nodes, at which index. `parseVerified` is its `verified` view;
the RDF, the summary counts and the diagnostics all read it, so an invalid
first entry followed by a valid verifier yields one node at index 1, one
counted verification, and a warning that names `verified[0]`.

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
  and builds the `conceptId → IRI` map; Pass 2 prepares each concept from its
  document alone (values encoded, body parsed, path-valued fields and links
  left as references); Pass 3 resolves each prepared concept's references
  against the final map (so an edge only forms to a concept that is imported).
  Each concept is prepared once and resolved once.
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
- **Graph → export input** is the package's job (`exportInputFromQuads`): a
  concept is a typed subject under the IRI base, and every skolemized node is
  attached to the concept its IRI starts with. `dkg okf export` only converts
  the daemon's SPARQL bindings to quads, so no graph consumer has to decode the
  mapper's IRI layout itself.
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
  families are rebuilt in their original entry order from the node IRIs, and
  everything the graph holds as a set is written in a canonical order, so export
  depends only on which triples the graph holds, never on the order a store
  returns them. This is a deliberate choice, not a defect; a future enhancement may have export
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
  string. js-yaml's own conversion would roll an impossible `2026-02-30` over to
  March and read an offset-less value as UTC before any check saw it, so the OKF
  document schema validates the text first: an unquoted value that is not a
  valid xsd:dateTime / xsd:date (or uses a YAML-only spelling such as
  `2001-12-14 21:59:43.10 -5`) stays the string it was, and a valid one keeps
  its original text alongside the `Date`. Quoted or not, a value therefore gets
  the same diagnostics: an invalid one is kept as a **plain** literal with a
  warning, never as a bogus typed literal that would poison date comparisons,
  and a missing explicit offset (§5 requires one) warns. Offset-less and
  date-only values are read as written (`2026-06-15` stays an xsd:date); a value
  with an offset is rendered in XSD canonical form (`Z`, no `.000`) and folds to
  UTC (same instant — the deployed store canonicalises xsd:dateTime the same
  way). Staleness reads an offset-less value as UTC, and a timestamp in a text
  field or inside a value kept verbatim is written as its original text, so
  nothing depends on the machine's time zone. On export, a date field is
  written as text (its import types the text again), while a typed date
  anywhere else (a family extension, a producer key, a value kept verbatim
  under its generic predicate) is written as an unquoted YAML timestamp,
  exactly as stored: there only YAML itself can say the value is a date, and
  a quoted one would re-import as a plain literal.
- **Actors are literals, not IRIs.** Minting `urn:okf:actor:human:x` nodes would
  let a later layer link actors to DIDs / wallets, but the convention is a string
  and IRI-encoding `@`, spaces or `%` adds an invertibility problem for no
  consumer benefit today. A DID binding can be added as a separate, opt-in edge
  without changing these triples.
- **Set-valued order.** A multi-valued RDF property is unordered, so export
  writes set-valued lists (`tags`, `authors`, `executor.receipt` — it declares
  the fields a run must return — links, citations) and producer and extension
  keys in a canonical order (by RDF term), not the order the source bundle or
  the store happened to use. A single-valued field that somehow holds two
  values exports the same one either way. `parameters`, `verified` and
  `sources` keep their order because the node IRI numbers the entries, and a
  value kept verbatim as one `rdf:JSON` literal keeps its internal order.
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
- **Values are arbitrary YAML.** A family field that holds one value but is
  given a mapping or list (`status: { … }`, `runtime: [bigquery]`) keeps it
  verbatim as one `rdf:JSON` literal and warns; it is never coerced, because a
  mapping with its own `toString` key makes `String()` throw. A verifier given
  that way names no verifier, so its entry is skipped. Base fields use a
  coercion that never throws. A concept whose value no RDF term can hold (a
  cyclic YAML alias has no JSON form) fails while it is prepared, is skipped
  with an `unmappable-value` warning, and leaves the concept index before any
  reference is resolved, so no other concept links to it (its links report as
  unresolved); the rest of the bundle imports. That
  is the only failure caught: any other exception in the mapper is a defect and
  propagates.
- **`schema:isPartOf` on export.** The edge `emitFolderHierarchy` infers (to the
  concept's own parent directory) is omitted, since the path implies it and the
  option re-derives it; any other `isPartOf` value is a producer key and is kept.
- **Keys are arbitrary strings.** Producer keys, extension keys and concept
  IDs (file paths) may be `constructor`, `toString` or `__proto__`. Export uses
  own-property checks and defined (not assigned) properties throughout, and the
  bundle's concept dictionaries have no prototype, so none of these names is
  dropped or misread.
- **Wrong-shaped nested families** (`sources[].usage_window: last-quarter`) are
  kept verbatim under the generic predicate on the entry's node, warned about,
  and written back under their own key on export. Entry nodes carry no other
  `schema:` producer keys, so the read-back is unambiguous.
- **A wrong-shaped top-level `usage_window`** (`usage_window: Q2`) is kept
  verbatim as `schema:usageWindow` on the concept — the very triple a producer
  key named `usageWindow` produces — so export writes it back as the
  `usageWindow` producer key. The graph round-trips exactly, but the
  frontmatter key changes and the shape warning does not recur on re-import.
  Single-word families (`generated`, `verified`, `sources`, …) keep their key,
  since camelCase leaves them unchanged.
- **Each triple once.** The mapper deduplicates its output per concept: a store
  holds a set, so two `sources` naming one resource give two `okf:Source` nodes
  but a single `prov:wasDerivedFrom` edge. Without this the expected count in
  `dkg okf verify` exceeded what any complete import can store, a permanent
  false shortfall; the verifier also counts distinct triples on its own.
- **Conformance is permissive.** Only two rules make a bundle non-conformant
  (unparseable frontmatter; missing non-empty `type`). Missing optionals, unknown
  types/keys, broken links, missing `index.md`, malformed families and unknown
  versions are tolerated (OKF §11).
