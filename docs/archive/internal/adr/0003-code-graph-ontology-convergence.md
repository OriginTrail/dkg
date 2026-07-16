# ADR 0003 — Code-graph ontology convergence

- **Status**: Accepted
- **Date**: 2026-05-25
- **Authors**: branarakic
- **Related issues**: [#596](https://github.com/OriginTrail/dkg/issues/596), [#602](https://github.com/OriginTrail/dkg/pull/602)
- **Related ADRs**: [0002 — Importer chunking contract](./0002-importer-chunking-contract.md)

## Context

Three things in this repository (and the shared workspace scanner that lives
outside the repo at `.dkg/scripts/scan-code.mjs`) currently produce RDF
triples about source files, packages, classes, and functions:

| Producer | URI shape | Scope |
|---|---|---|
| `scripts/lib/ontology.mjs` (`Code.uri.file`) | `urn:dkg:code:file:<pkgName>/<relPath>` | DKG monorepo packages |
| The parent workspace's `scan-code.mjs` | `urn:dkg:code:file:<owner>/<name>/<relPath>` | Arbitrary external GitHub repos (also occasionally used against this monorepo with `owner=OriginTrail name=dkg`) |
| PR [#602](https://github.com/OriginTrail/dkg/pull/602) Graphify importer | `graphify:file:<hash>` and similar | The repository the experiment was run against |
| Any future ad-hoc importer | (unknown — drift risk) | (unknown) |

This is fine for a single producer working in isolation. It fragments the
graph the moment two producers describe the same file: queries don't join,
the UI shows two nodes for `packages/storage/src/adapters/oxigraph.ts`, and
`dkg_memory_search` returns duplicates.

The Graphify experiment in PR #602 made this concrete by emitting `graphify:*`
URIs for ~30k files that the parent scanner had already indexed under
`urn:dkg:code:*`. Neither side knew about the other.

We need a canonical shape, documented expectations for which producer owns
which slice, and a sketch of how to reconcile already-emitted parallel URIs.

## Decision

1. **Canonical URI shapes for the `code:*` ontology** (defined in `scripts/lib/ontology.mjs`):

   ```
   urn:dkg:code:package:<pkgName>
   urn:dkg:code:file:<pkgName>/<relPath>
   urn:dkg:code:module:<moduleName>
   ```

   - **Encoding** — there are two producers in play and they encode
     differently for historical reasons. New code MUST keep doing what
     the existing producer in its slice does, **not** invent a third
     convention:
     - `scripts/lib/ontology.mjs` (`Code.uri.file`) — the monorepo
       helper — runs `encodeURIComponent` on `<pkgName>` and on
       `<relPath>` **as whole strings**. A `relPath` of `src/a b.ts`
       becomes `src%2Fa%20b.ts` and the literal URI is
       `urn:dkg:code:file:@origintrail-official%2Fdkg-storage/src%2Fa%20b.ts`.
       This is what every monorepo importer (`import-code-graph.mjs`,
       `seed-dkg-code-project.mjs`, `import-github.mjs`, `import-tasks.mjs`,
       `import-decisions.mjs`) emits today.
     - The parent workspace's `.dkg/scripts/scan-code.mjs` — which scans
       arbitrary external GitHub repos — percent-encodes **each path
       segment** and joins them with literal `/`. The parent workspace's
       `AGENTS.md` (§ "Query gotchas #4") documents this. That convention
       stays as well; both producers have months of WM/SWM/VM data behind
       them.
     - These two encodings cannot collide because the producers own
       disjoint `<pkgName>` slices (see §2): the monorepo helper passes
       the package.json `name` field (e.g. `@origintrail-official/dkg-storage`);
       the parent scanner passes `<owner>/<name>` (e.g.
       `OriginTrail/dkg`). No `<pkgName>` is valid in both spaces.
     - If a future change unifies the encoding, that's a separate ADR
       with a real migration plan; do not flip it in passing.
   - `<pkgName>` is **the source's natural package handle in the producer's
     scope**, not always a public npm name:
     - For DKG monorepo packages: the scoped package.json `name` field —
       e.g. `@origintrail-official/dkg-storage`,
       `@origintrail-official/dkg-agent`,
       `@origintrail-official/dkg-cli`. This matches what the existing
       monorepo importers pass; using a hand-rolled unscoped form would
       create a parallel `dkg-storage` namespace and fragment the graph.
     - For external GitHub repos scanned by the parent workspace's
       `scan-code.mjs`: `<owner>/<name>` (slash kept as-is — that's the
       only case `<pkgName>` contains a literal slash). The parent
       scanner has been emitting this pattern for months; it stays.
     - For loose source trees with no package metadata: a slug derived
       from the directory name.

2. **One producer owns one slice.** Each tool MUST stay inside its declared
   scope so the URIs don't collide:

   | Producer | Owns | `<pkgName>` shape | Reads from |
   |---|---|---|---|
   | `scripts/lib/ontology.mjs` consumers in this worktree | DKG monorepo `urn:dkg:code:*` triples | scoped package.json name (`@origintrail-official/dkg-storage`) | Other producers via SPARQL — joins are by URI |
   | Parent workspace's `scan-code.mjs` | External-repo `urn:dkg:code:*` triples | `<owner>/<name>` (slash kept literal) | Other producers via SPARQL — joins are by URI |
   | Future Graphify-style importers | A producer-specific sub-graph; URIs MUST follow the canonical shape above (no `graphify:*` namespace) | Whatever fits the producer's scope; pick one and stick to it | Other producers via SPARQL — joins are by URI |

3. **The `graphify:*` URI namespace is deprecated.** Importers that
   currently emit `graphify:file:<hash>` MUST switch to
   `urn:dkg:code:file:<pkgName>/<relPath>` (using the producer's declared
   `<pkgName>` scope). For graphs that have already been promoted to
   SWM/VM with `graphify:*` URIs, a one-shot reconciliation assertion
   maps the legacy URIs forward (see §Reconciliation).

4. **`<relPath>` is the path relative to the package root, not the repo
   root.** A monorepo file at `packages/storage/src/adapters/oxigraph.ts`
   has `<pkgName>=@origintrail-official/dkg-storage` (the scoped name
   from that package's `package.json`) and
   `<relPath>=src/adapters/oxigraph.ts`. The scope-prefixed handle is
   what `Code.uri.package`/`Code.uri.file` emit today, so the example
   here matches what the helper produces — no parallel namespace. The
   parent's scanner (which runs against external repos one repo at a
   time) has no concept of "package root", so its `<relPath>` is the
   repo-root-relative path — but its `<pkgName>=<owner>/<name>` is also
   repo-rooted, so the produced URI is unambiguous.

5. **The `code:` ontology stays exactly as defined today** —
   `scripts/lib/ontology.mjs` is the canonical source of truth for class
   IRIs (`code:Package`, `code:File`, `code:Function`, `code:Class`,
   `code:Interface`, `code:TypeAlias`, `code:Enum`, `code:ExternalModule`)
   and property IRIs (`code:path`, `code:package`, `code:imports`,
   `code:exports`, `code:contains`, etc.). New producers MUST import these
   constants rather than redeclaring them.

## Reconciliation

Existing graphs that promoted `graphify:*` URIs to SWM/VM need a
machine-readable bridge so downstream queries can find the canonical node
either way. The pattern is a small `owl:sameAs` reconciliation assertion,
written once per known-aliased URI:

```turtle
@prefix owl: <http://www.w3.org/2002/07/owl#> .

<graphify:file:7f3a9c1e>
    owl:sameAs <urn:dkg:code:file:%40origintrail-official/dkg-storage/src/adapters/oxigraph.ts> .

<graphify:file:b2d4e8f0>
    owl:sameAs <urn:dkg:code:file:%40origintrail-official/dkg-agent/src/dkg-agent.ts> .
```

The canonical URIs above match the shape `Code.uri.file()` already
emits — note the `%40` (percent-encoded `@`) in the scoped package
name, applied per `scripts/lib/ontology.mjs`. Using the unscoped
`dkg-storage`/`dkg-agent` form here would re-introduce the parallel
namespace this ADR is trying to eliminate.

In SPARQL, joins across the legacy and canonical URIs become trivial.
Two things to note:

- The `PREFIX owl:` declaration is required by standard SPARQL parsers
  when using the `owl:` short form (Codex flagged the earlier draft
  for shipping the property path without it).
- DKG sub-graph data is stored in named graphs (see [AGENTS.md §Query
  gotchas](../../AGENTS.md)); a query against the default graph returns
  zero rows. Wrap the pattern in `GRAPH ?g { ... }` so the example is
  executable against the real `code` sub-graph.

```sparql
PREFIX owl: <http://www.w3.org/2002/07/owl#>

SELECT ?file ?path WHERE {
  GRAPH ?g {
    ?file owl:sameAs* ?canonical .
    ?canonical <http://dkg.io/ontology/code/path> ?path .
  }
}
```

Authoring the reconciliation assertion is the responsibility of whichever
agent operated the deprecated importer. The assertion can be promoted
through the standard `assertion/create + write + promote` flow (within
the chunking budgets from ADR 0002 — one reconciliation typically fits in
a single ROOT_CHUNK = 1000 URIs).

## Consequences

**Will change** (in PRs that follow this ADR):

- Future `packages/cli/skills/dkg-importer/SKILL.md` — the agent-readable
  importer manual will cite this ADR for the canonical URI shape and the
  "no `graphify:*` URIs in new code" rule.
- The Graphify experiment (PR #602) — its importer migrates from
  `graphify:*` URIs to `urn:dkg:code:*` URIs in a follow-up PR. The
  experiment authors author a one-shot `owl:sameAs` reconciliation for
  any graphs that have already been promoted with the legacy URIs.
- The parent workspace's `.dkg/scripts/scan-code.mjs` — scheduled for a
  documentation pass that points at this ADR. No URI-shape change is
  required; the existing `<owner>/<name>/<per-segment-encoded-relPath>`
  shape is already canonical within its scope (external-repo scanning).
- Any new code-graph importer — MUST import class/property IRIs from
  `scripts/lib/ontology.mjs` and MUST follow the URI shape above.

**Will not change**:

- Existing `urn:dkg:code:*` URIs in WM/SWM/VM produced by either
  `scripts/lib/ontology.mjs` consumers or the parent scanner. They are
  already canonical.
- The `code:*` class hierarchy or property IRIs.
- The decision about how to encode language-specific concepts (Solidity
  contracts, Python type hints, etc.) — those continue to evolve through
  the existing `Code.T.*` definitions in `scripts/lib/ontology.mjs`.

## Rejected alternatives

- **"Two parallel canonical namespaces, `urn:dkg:code:*` and
  `urn:dkg:scanned-code:*`."** Would solve the producer-scope question by
  giving each producer its own namespace, but at the cost of breaking
  every existing query. Existing consumers (the parent scanner has been
  emitting `urn:dkg:code:*` for months and other tooling joins against it)
  would have to be migrated. Not worth the churn.
- **"Hash-based URIs (`urn:dkg:code:file:sha256:<digest>`)."** Producer-
  independent, but loses human readability ("which file is
  `sha256:7f3a…`?") and forces clients to maintain hash → path indexes
  outside the graph. Considered for derived-artefact identity later but
  not for the canonical URI.
- **"Each producer maintains its own private URI space and joins through
  an indirection."** That's exactly the `owl:sameAs` reconciliation pattern
  above, applied universally. Without a canonical shape it leads to N²
  bridges between producers. The canonical-with-one-bridge approach is
  strictly better than N² bridges.

## References

- W3C OWL 2 reference for `owl:sameAs` — [https://www.w3.org/TR/owl2-syntax/#Individual_Equality](https://www.w3.org/TR/owl2-syntax/#Individual_Equality)
- The percent-encoding requirement is mirrored in the parent workspace's
  `AGENTS.md` § "Query gotchas (4)".
- `scripts/lib/ontology.mjs` — canonical definitions of the `code:*` ontology
  (classes, properties, URI helpers).
