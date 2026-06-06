# OT-RFC-46: Knowledge Assets as member-entity-scoped triples in bounded named-graph buckets (logical KA identity)

| Field | Value |
|-------|-------|
| **RFC** | OT-RFC-46 |
| **Title** | Knowledge Assets as member-entity-scoped triples in bounded named-graph buckets (logical KA identity) |
| **Status** | Draft — **V10.0 decision: ship Model 2 (§17)**; Model 1 / buckets specified here but deferred post-launch |
| **Created** | 2026-06-06 |
| **Track** | Protocol Core (storage layout, query engine, memory layers) |
| **Packages** | `query`, `publisher`, `agent`, `core`, `storage` |
| **Chain change** | **None.** Off-chain storage-layout + query-engine change. The packed `kaId` and the UAL string are untouched; consensus/merkle is untouched (see §10). |
| **Parent** | [OT-RFC-43 — Deterministic KA identity & the SWM→VM publish model](OT-RFC-43-deterministic-ka-identity.md) (§3, §10.1, §10.4, §10.5) |
| **Related** | [OT-RFC-44 — File = Knowledge Asset (Design B)](OT-RFC-44-file-equals-ka.md), [OT-RFC-45 — Update authority is owner-only](OT-RFC-45-update-authority-owner-only.md), [SPEC_PART1_MARKETPLACE.md](../SPEC_PART1_MARKETPLACE.md), GitHub issue #184 |

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

> **Citation convention.** Unqualified filenames resolve as: `metadata.ts` → `packages/publisher/src/metadata.ts`; `dkg-publisher.ts` → `packages/publisher/src/dkg-publisher.ts`; `auto-partition.ts`/`skolemize.ts` → `packages/publisher/src/`; `dkg-query-engine.ts` → `packages/query/src/`; `constants.ts`/`assertion-seal.ts`/`entity-predicate.ts`/`messenger-types.ts` → `packages/core/src/`; `dkg-agent-*.ts`/`sync-handler.ts`/`allocator.ts` → `packages/agent/src/`; route files (`query.ts`, `memory.ts`, `knowledge-assets.ts`) → `packages/cli/src/daemon/routes/`.

> **Why this is its own RFC.** RFC-44 fixed *how many KAs a file maps to* (N → 1) but left untouched *where a KA's quads physically live*. Today the Working-Memory (WM) and Verified-Memory (VM) layers still mint **one named graph per Knowledge Asset**, and the read path pays for it on every request. This RFC removes the per-KA named graph: a KA is identified **logically by its member-entity set** and its quads live inside a **small, bounded number of named-graph "buckets"** — exactly the way the Shared-Working-Memory (SWM) layer already works in production. It carries **no chain risk** and changes **no UAL or `kaId` format**. The merkle/consensus boundary does not move because it was **never** the graph boundary (§10).

---

## 0. TL;DR

- A KA's logical identity is **its member-entity set**, not a named graph. The merkle/consensus boundary is **already** member-entity-scoped — `buildAssertionSealQuads` commits exactly `skolemizeByEntity(filteredQuads).keys()` (`packages/core/src/assertion-seal.ts:52`), never the graph IRI. So we can drop the per-KA named graph without touching the seal.
- Stop minting one graph per KA in WM (`.../assertion/{addr}/{name}`) and VM (`.../_verified_memory/{vmId}`). Store many KAs in a **bounded** number of buckets keyed by `(contextGraph[/subGraph]/layer)` — exactly the shape SWM already has (`.../_shared_memory`, one graph, many assertions; `packages/core/src/constants.ts:217-219`).
- This is a **generalization, not an invention — with one honest caveat.** SWM already selects one KA out of a many-KA bucket with `VALUES ?root {…} … FILTER(?s = ?root || STRSTARTS(STR(?s), "<root>/.well-known/genid/"))` (`packages/publisher/src/dkg-publisher.ts:1238-1247`), and `resolveKA` already resolves a **published** KA by its member-entity closure — but via the post-publish UAL label rows (`?ka dkg:partOf <ual>` + `dkg:rootEntity`, `packages/query/src/dkg-query-engine.ts:694-703`), **not** the lifecycle URN. The carve-out pattern is proven; the per-KA **membership index is genuinely new work for WM/SWM** (§3.3).
- It kills the dominant **discovery** cost: **two full-store `listGraphs()` scans** per view-read (`packages/query/src/dkg-query-engine.ts:517` and `:576`) plus an **N-way `GRAPH … UNION`** over discovered graphs (`:2195-2198`), both of which scale with the *global* KA count. Buckets make discovery O(1) and land every read on the single-graph fast path (`:438-439`). **But discovery is only half the read.** The data read itself MUST be a **single indexed seek on a UAL-keyed backlink** (§3.5), not the `STRSTARTS` string scan — benchmarked at **616 ms vs ~0.05 ms** on Oxigraph at 100K KAs/bucket. The RFC's membership/backlink predicate is **`dkg:knowledgeAsset` with the KA's UAL (`dkg:reservedUal`) as the object** — verified **free** on this branch (the lowercase `http://dkg.io/ontology/knowledgeAsset` has zero occurrences repo-wide; only the capitalized rdf:type class `dkg:KnowledgeAsset` exists, `metadata.ts:196`). The read becomes a **single bound-`(predicate,object)` POS seek** with **no `_meta` round-trip** — the same index-seek access class `resolveKA` already runs portably on Blazegraph (`dkg-query-engine.ts:697-698`). Without it, the read regresses from O(KA) to O(bucket) and a point-read becomes *slower than today* at scale. The indexed backlink is a **hard prerequisite, not an optimization.**
- The backlink object — the `reservedUal` — is **pre-knowable**: `did:dkg:{chainId}/{author}/{number}` (`dkg-agent-publish.ts:1834`, `RESERVED_UAL_PRED` at `metadata.ts:1225`), so the `<member-subject> dkg:knowledgeAsset <reservedUal>` triple is writable at skolemize/finalize and re-emitted on every subsequent WM draft of an already-finalized KA (whose `reservedUal` is preserved across discard+recreate).
- It eliminates the recurring **Blazegraph multi-graph-UNION** fights — four commits over two days (`e73e1c28`, `88b7703e`, `a9184f7a`, `d19af5f8`) — because there is no N-way UNION to flatten.
- It **dissolves issue #184** rather than patching it: the `{view, subGraphName}` hard-throw (`:300-305`) exists only because subgraph scope is treated as a graph *prefix* that omits `/{sub}/`. Under buckets, subgraph scope is one more triple-pattern constraint inside one bucket.
- The hard part is **ACL** (§9): WM per-agent isolation is enforced today by *both* the physical graph URI **and** a query-time deny. Removing the graph boundary makes the query-time filter load-bearing alone, so the bucket query layer MUST inject a non-strippable agent-id constraint server-side.
- Migration is **dual-read/backfill**, reusing the in-repo `ASSERTION_ROOT_ENTITY → ASSERTION_ENTITY` rename template (`assertion-seal.ts:59-67`). WM is **node-local** (sync excludes the WM layer), so WM bucketing has zero wire impact and ships first. The tactical `#184` WM+SWM resolver fix ships **independently and first** (§14). **This RFC now BUILDS ON the `feat/unify-knowledge-assets-routes` branch (v10-devnet + KA-route-unification): the legacy `/api/assertion` surface is already deleted and replaced by `/api/knowledge-assets` (`routes/assertion.ts` removed, commit `3b5c47fb`), so the prior "coordinate with the rc.17 route migration" caveat is RESOLVED — that migration is done here.**
- **⚠️ This is a model choice, not just a layout change (added after review — see §16).** Adopting buckets silently commits the protocol to **Model 1 (exclusive entity):** a member-entity subject may belong to **at most one KA per bucket**, and enriching an entity is **owner-only** (OT-RFC-45). The alternative is **Model 2: one named graph per KA keyed by the UAL, plus a bounded `_meta` discovery index** — which supports *overlapping, multi-author* claims about a shared entity and keeps atomic delete + a physical ACL fence, at the cost of fragmented full-subgraph analytic scans. Critically, the two headline §2 wins — O(1) discovery (§2.1) and #184 (§2.3) — are **model-independent** (Model 2 gets both from the `_meta` index, without per-KA graph collapse). §16 compares the two in full.

---

## 1. Summary

Today the DKG stores three memory layers with three different graph cardinalities (`packages/core/src/constants.ts:217-237`):

| Layer | URI shape | Cardinality | Subgraph form? |
|-------|-----------|-------------|----------------|
| **WM** | `did:dkg:context-graph:{cg}[/{sub}]/assertion/{addr}/{name}` | **MANY** (one graph per `(agent, name)`, prefix-addressed) | yes (`/{sub}/assertion/…`) |
| **SWM** | `did:dkg:context-graph:{cg}[/{sub}]/_shared_memory` | **ONE** (one graph, many assertions) | yes (`/{sub}/_shared_memory`) |
| **VM** | `did:dkg:context-graph:{cg}/_verified_memory/{vmId}` | **MANY** (one graph per item) | **no** (URI helper takes no `subGraphName`) |

Three layers, **three different storage shapes** — different cardinalities, and even different subgraph support. That asymmetry is unnecessary complexity, and this RFC removes it. **Under bucketing the three rows collapse into one shape:**

| Layer | Bucket (this RFC) | Cardinality | Differs only in (**policy**, not structure) |
|-------|-------------------|-------------|---------------------------------------------|
| **WM** | `…/{cg}[/{sub}]/_working_memory` | **ONE** | private to the author |
| **SWM** | `…/{cg}[/{sub}]/_shared_memory` | **ONE** | team-visible, TTL-bounded |
| **VM** | `…/{cg}[/{sub}]/_verified_memory` | **ONE** | public, on-chain, permanent |

Same bucket shape, same `dkg:knowledgeAsset <ual>` membership, same single-seek read, same `_meta` row. The only per-layer differences are the layer token in the URI and the layer's **visibility/lifecycle policy** — which is the entire reason the three layers exist. §1.1 renders one KA identically across all three.

SWM already runs the model this RFC proposes: a **single bounded named graph** holding many KAs, where an individual KA is carved out **logically by its member-entity set** (`VALUES ?root` + a skolem-genid `STRSTARTS` filter), not by a graph boundary. The consensus/merkle boundary is *already* member-entity-scoped: the assertion seal records exactly `skolemizeByEntity(filteredQuads).keys()` so that publish can reproduce the same merkle leaves from a many-KA graph (`packages/core/src/assertion-seal.ts:47-56`).

This RFC **generalizes SWM's logical scoping to WM and VM.** A KA is identified by:

1. its **member-entity set** (the `skolemizeByEntity` keys — the same set the seal commits to), and
2. a **`_meta` membership/lifecycle record** keyed by the stable URN `urn:dkg:assertion:{cg}[:{sub}]:{addr}:{name}` (`constants.ts:249-251`) and/or its UAL, carrying `dkg:entity` members, `dkg:kaId`, `dkg:reservedUal`, `dkg:state`, `dkg:memoryLayer`, per-layer merkle pointers, and subgraph membership; **and, in the data bucket itself, a UAL-keyed `dkg:knowledgeAsset <reservedUal>` backlink on every KA subject (§3.3/§3.5) that makes a single KA's quads resolve in one indexed seek with no `_meta` round-trip.**

KA quads live in a **bucket** — a bounded named graph keyed by `(contextGraph[/subGraph]/layer)`. The number of named graphs per `(CG, subGraph, layer)` becomes a **constant**, matching the documented target model: *"No per-KA named graphs … A contextGraph with 100K KCs still has exactly 2 named graphs"* (`docs/SPEC_PART1_MARKETPLACE.md:168`).

The UAL (`did:dkg:{chainId}/{addr}/{kaId}`) and the packed `kaId = (uint160(author) << 96) | uint96(number)` (`packages/agent/src/allocator.ts:85`, `packages/core/src/messenger-types.ts:259`) remain the stable external handle. Nothing on chain changes.

### 1.1 A worked example — one KA across all three layers

One KA: author `0xabc…def`, name `img-bot`, in CG `acme`, no subgraph. It has one member entity `did:dkg:agent:QmImageBot` with one formerly-blank child (an offering), and a **pre-knowable** `reservedUal = did:dkg:100/0xabc…def/7` (kaId `7`, merkle `3f9a…c1`). Below are **all** of its triples at each lifecycle stage. The load-bearing point: the **data + backlink triples are byte-identical in every layer — only the bucket's layer token (the 4th column) changes**; the `_meta` row merely *accretes* lifecycle annotations as the KA matures.

> Prefixes: `dkg: → http://dkg.io/ontology/`, `schema: → http://schema.org/`, `ex: → http://example.org/`, `xsd: → http://www.w3.org/2001/XMLSchema#`, `a → rdf:type`. The 4th column of each quad is the named graph (the bucket / `_meta`).

**(a) WM** — `draft-open`, then `wm-sealed` after finalize.

```nquads
# bucket graph: did:dkg:context-graph:acme/_working_memory
<did:dkg:agent:QmImageBot>                             schema:name "ImageBot"          <…/_working_memory> .
<did:dkg:agent:QmImageBot>                             ex:offers   <…QmImageBot/.well-known/genid/offering1> <…/_working_memory> .
<…QmImageBot/.well-known/genid/offering1>              ex:type     "ImageAnalysis"      <…/_working_memory> .
# — membership backlink (the §3.5 index): one per subject, object = the UAL —
<did:dkg:agent:QmImageBot>                             dkg:knowledgeAsset <did:dkg:100/0xabc…def/7> <…/_working_memory> .
<…QmImageBot/.well-known/genid/offering1>              dkg:knowledgeAsset <did:dkg:100/0xabc…def/7> <…/_working_memory> .

# lifecycle row, graph: did:dkg:context-graph:acme/_meta   (subject = the lifecycle URN)
<urn:dkg:assertion:acme:0xabc…def:img-bot>  a dkg:Assertion, <http://www.w3.org/ns/prov#Entity> .
<urn:…:img-bot>  <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:0xabc…def> .
<urn:…:img-bot>  dkg:contextGraph   <did:dkg:context-graph:acme> .
<urn:…:img-bot>  dkg:assertionName  "img-bot" .
<urn:…:img-bot>  dkg:entity         <did:dkg:agent:QmImageBot> .          # member-entity membership (in _meta)
<urn:…:img-bot>  dkg:reservedUal    "did:dkg:100/0xabc…def/7" .
<urn:…:img-bot>  dkg:kaId           "7"^^xsd:integer .
<urn:…:img-bot>  dkg:memoryLayer    "WM" .
# …at finalize, the seal block + the WM pointer land → status wm-sealed:
<urn:…:img-bot>  dkg:wmCurrentAssertion    "3f9a…c1" .
<urn:…:img-bot>  dkg:assertionMerkleRoot   "3f9a…c1"^^xsd:hexBinary .
<urn:…:img-bot>  dkg:authorAddress         "0xAbc…Def" .
<urn:…:img-bot>  dkg:assertedAtChainId     "100"^^xsd:integer .
```

**(b) SWM** — `swm-shared`. Promote moves the **same** data + backlink into the SWM bucket; the only change to those five quads is the 4th column.

```nquads
# bucket graph: did:dkg:context-graph:acme/_shared_memory   — the 3 data + 2 backlink quads, IDENTICAL except:
<did:dkg:agent:QmImageBot>  schema:name "ImageBot"  <…/_shared_memory> .          # …/_shared_memory, not …/_working_memory
<…(offers, type, and the two dkg:knowledgeAsset backlinks — all re-homed to …/_shared_memory)… >

# graph: did:dkg:context-graph:acme/_meta   — SAME row, mutated/accreted in place:
<urn:…:img-bot>  dkg:memoryLayer "SWM" .                                  # overwrites "WM" (not duplicated)
<urn:…:img-bot>  dkg:swmCurrentAssertion "3f9a…c1" .                      # → status swm-shared
<did:dkg:agent:QmImageBot>  dkg:workspaceOwner <did:dkg:agent:0xabc…def> .   # first-writer-wins ownership
```

**(c) VM** — `vm-confirmed`. Publish anchors the KA on-chain. **Same** data + backlink, now in the VM bucket; `_meta` gains the on-chain identity node.

```nquads
# bucket graph: did:dkg:context-graph:acme/_verified_memory   — the same 3 data + 2 backlink quads, re-homed here.

# graph: did:dkg:context-graph:acme/_meta
<urn:…:img-bot>  dkg:memoryLayer "VM" .  dkg:state "published" .  dkg:vmCurrentAssertion "3f9a…c1" .   # → status vm-confirmed
# the on-chain UAL node (OT-RFC-44 Design B), keyed by the UAL itself:
<did:dkg:100/0xabc…def/7>  a dkg:KnowledgeAsset .
<did:dkg:100/0xabc…def/7>  dkg:publicTripleCount "3"^^xsd:integer .
<did:dkg:100/0xabc…def/7>  dkg:entity <did:dkg:agent:QmImageBot> .
```

**What this shows.** The KA's *content* — three data triples and their two `dkg:knowledgeAsset` backlinks — is structurally identical in WM, SWM, and VM; promotion and publish only change which bucket holds it. Everything that *differs* between layers is either the bucket's layer token or a lifecycle annotation in `_meta`. Read/write/delete/seal for this KA is the **same single indexed seek** (`?s dkg:knowledgeAsset <did:dkg:100/0xabc…def/7>`) in every layer — that is the uniformity of §3.

---

## Terminology (read this first)

| Term | Definition |
|------|------------|
| **KA (Knowledge Asset)** | One file/lifecycle (OT-RFC-44 Design B), whose member entities are the keys of `skolemizeByEntity` over its quads. May have **multiple** member entities. |
| **Member entity** | A non-blank, non-skolemized subject IRI in an assertion. Phase 1 of `skolemizeByEntity` collects every such subject into the member-entity set (`packages/publisher/src/auto-partition.ts:24`). *Earlier drafts called this the "root entity"; this RFC avoids "root" so it is never confused with the **merkle root** (a verifiability primitive of the KA). The code predicate is still `dkg:rootEntity`, mid-rename to `dkg:entity` per OT-RFC-43 §10.1.* |
| **Member-entity set** | `[...skolemizeByEntity(quads).keys()]` — the KA's logical identity and the exact set the seal commits to (`assertion-seal.ts:52`). |
| **Skolem child** | A formerly-blank node rewritten to `{rootEntity}/.well-known/genid/{label}` (`packages/publisher/src/skolemize.ts:24`). Belongs to its parent member entity; recovered by `rootEntityFromSkolemized`. |
| **Member-entity closure** | A KA's quads = `{ ?s : ?s = root || STRSTARTS(STR(?s), "<root>/.well-known/genid/") }` over the member-entity set. This is the carve-out filter used in three production sites today. |
| **Bucket** | A bounded named graph holding many KAs, keyed by `(contextGraph[/subGraph]/layer)`. SWM's `.../_shared_memory` is the existing example. |
| **`_meta` record** | The KA's lifecycle/seal triples in `did:dkg:context-graph:{cg}/_meta`, keyed by the lifecycle URN, the assertion-graph URI (seal), or the UAL (on-chain node). Exists today — **but does not yet carry member-entity membership on the lifecycle URN for WM/SWM**; adding that membership index is core new work of this RFC (§3.3). |
| **View** | A read mode (`working-memory`, `shared-working-memory`, `verified-memory`) resolved to a set of graphs/prefixes by the query engine (`dkg-query-engine.ts:80-159`). |
| **Lifecycle URN** | `urn:dkg:assertion:{cg}[:{sub}]:{addr}:{name}` (`constants.ts:249-251`). The stable `_meta` subject that survives WM→SWM→VM. |
| **Packed `kaId` / UAL** | `kaId = (uint160(author) << 96) | uint96(number)`; UAL `did:dkg:{chainId}/{addr}/{kaId|number}`. The on-chain anchor, unchanged by this RFC. |

---

## 2. Motivation — what's broken today

The per-KA named graph is the root cause of a cluster of scaling, portability, and correctness problems. We enumerate them as numbered subproblems.

### 2.1 Whole-store graph enumeration on every view-read — O(#KA)

Every view-read enumerates the **entire** triple store, twice.

- `queryWithView` expands every resolved prefix by calling `discoverGraphsByPrefix` once per prefix (`dkg-query-engine.ts:380-383`), which runs `await this.store.listGraphs()` and filters in application code:

  ```ts
  // dkg-query-engine.ts:516-521
  private async discoverGraphsByPrefix(prefix: string): Promise<string[]> {
    const allGraphs = await this.store.listGraphs();
    return allGraphs.filter(
      (g) => g.startsWith(prefix) && !g.includes('/_meta') && !g.includes('/staging/'),
    );
  }
  ```

- The scoped-content allow-list path enumerates the whole store a **second** time per read:

  ```ts
  // dkg-query-engine.ts:576-580
  const allGraphs = await this.store.listGraphs();
  for (const graph of allGraphs) {
    if (isScopedContentGraph(graph, contextGraphId, /* … */)) {
      allowed.add(graph);
    }
  }
  ```

`listGraphs()` is itself a full-store `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }` on **every** backend (Oxigraph, Blazegraph, sparql-http). And `working-memory` with no `assertionName` resolves to a **prefix** (`did:dkg:context-graph:{id}/assertion/{agent}/`, `:80-83`), so *every* WM read goes through this path. The cost therefore grows with the **global KA count of the node**, not with the size of the CG you queried. With one bucket per layer there is nothing to enumerate: the bucket URI is computed directly from `(CG[/sub]/layer)`.

### 2.2 N-way `GRAPH … UNION` + Blazegraph portability tax

After enumeration, a multi-graph read builds a single N-way union — one `{ GRAPH <g> { inner } }` branch per discovered graph, joined by `UNION`:

```ts
// dkg-query-engine.ts:2195-2198
const unionBranches = graphUris
  .map((g) => `{ GRAPH <${g}> { ${inner} } }`)
  .join(' UNION ');
return `${before} ${unionBranches} ${after}`;
```

Query text and engine AST complexity grow linearly with the per-KA graph count. This is the direct cause of a recurring portability fight: Blazegraph's parser crashes with **`Illegal child type for union: UnionNode`** when a `UNION` appears inside a `GRAPH` block that is itself a branch of an outer `UNION` — Oxigraph tolerates it, Blazegraph does not. This **blocked the entire assertion promote and publish flow on Blazegraph nodes** and forced an unstable cascade of fixes:

| Commit | What it papered over |
|--------|----------------------|
| `e73e1c28` | "flatten nested SPARQL UNIONs for Blazegraph compat" — the `Illegal child type for union: UnionNode` crash |
| `a9184f7a` | "eliminate scope leak and variable collision in Blazegraph compat" — `wrapWithGraphUnion` returns `null` instead of leaking `?__dkg_viewGraph` into caller scope |
| `88b7703e` | "form-aware multi-graph UNION fallback" — per-graph CONSTRUCT/ASK/SELECT merge because a single union can't be built |
| `d19af5f8` | "unblock large Blazegraph publishes" — a single large `DELETE DATA` over the full quad set hit Jetty's `maxFormContentSize` (~200 KB) |

The fallback can't even honor cross-graph solution-set modifiers: a multi-graph query combining an inner `UNION` with `DISTINCT/ORDER BY/LIMIT/OFFSET/GROUP BY/aggregate` is **rejected outright** (`:499-506`) because per-graph slices can't reconstruct the modifier semantics. That is a legitimate query shape made un-runnable purely by the graph-per-KA fan-out. The `TripleStore` interface is by design *"pure SPARQL 1.1 … any SPARQL-capable store (Oxigraph, Blazegraph, Neptune, GraphDB, Jena)"* (`packages/storage/src/triple-store.ts:1-5`), so a feature that only works on Oxigraph is a portability regression by the layer's own intent. One bucket graph per layer collapses every read onto the single-graph fast path (`:438-439`) — no N-way UNION, no nested-UnionNode crash, no per-graph fallback.

### 2.3 Issue #184 (subgraph-within-view) is a symptom, not a bug to patch

The query engine refuses any `{view, subGraphName}` combination outright:

```ts
// dkg-query-engine.ts:300-305
if (options.subGraphName) {
  throw new Error(
    `subGraphName cannot be combined with view-based routing (view='${options.view}'). ` +
    'Sub-graph scoping within views is deferred to V10.x.',
  );
}
```

The deeper cause: `resolveViewGraphs` builds ROOT prefixes that **omit** the `/{sub}/` segment. `working-memory` hardcodes `.../assertion/{agent}/` (`:82`) and `shared-working-memory` calls `contextGraphSharedMemoryUri(contextGraphId)` with **no** `subGraphName` argument (`:87`). So subgraph WM/SWM data is structurally unreachable on every view route — and VM has **no subgraph URI form at all** (`constants.ts:227`). Subgraph scope is being treated as a *graph prefix*. Under buckets it becomes a triple-pattern constraint inside one bucket, and the throw disappears (§5c).

### 2.4 Non-uniform 3-cardinality layer addressing → 3 code paths

The three layers have three different graph cardinalities (§1 table) and even three different *subgraph* stories — WM and SWM accept a `subGraphName`, VM does not (`constants.ts:227-237`). This forces three different read/write/discovery code paths and three different allow-list branches (`isScopedContentGraph` special-cases `assertion/` at `:803` and `_verified_memory/` separately). A bucketed model gives all three layers the **same** shape — one bounded bucket, member-entity-scoped — so there is one read path, one write path, and one membership index.

### 2.5 Provenance / visibility footguns from alias-split graphs

`canonicaliseWmId` exists because the same agent may author under its **EVM address** or its **peerId**, and *those hash to different assertion graphs today* (`packages/agent/src/dkg-agent-query.ts:548-553`, comment+split at `:531-553`). So one logical agent's WM can be split across two physical graph prefixes (`.../assertion/{evm}/` and `.../assertion/{peerId}/`), and a read keyed on the "wrong" alias silently misses data. The membership/lifecycle `_meta` record is already the source of truth for state and entity set (it is mutated in place on a single stable URN across WM→SWM→VM); the per-KA graph boundary is a *second, divergent* index that has to be kept in sync. Collapsing to one agent-keyed bucket partition removes the divergence — but the migration MUST canonicalise both alias prefixes into one partition or alias-stranded WM disappears (§11).

### 2.6 The tell: SWM already runs the proposed model

The strongest evidence that this is feasible is that **one of the three layers already does it.** SWM is a single named graph holding many assertions (`constants.ts:217-219`), and:

- a single KA is selected by member-entity `VALUES` + skolem filter (`dkg-publisher.ts:1244-1253`),
- selective load uses a `VALUES ?entity {…}` clause against `_shared_memory_meta` (`dkg-publisher.ts:3510-3511`),
- the seal scopes the SWM CONSTRUCT to exactly the assertion's member entities to reproduce the signed merkle leaves (`assertion-seal.ts:47-56`),
- SWM read ACL is enforced at the **CG level**, not per-assertion (`swm-agent-gate-access.test.ts:17-23`).

SWM has none of the problems in §2.1–§2.4 because it has no per-KA graph. The RFC's entire thesis is: **make WM and VM look like SWM.**

---

## 3. The model

> **One structure for all three layers.** The headline consequence of bucketing: WM, SWM, and VM stop having three different storage shapes (§1, §2.4) and become **the same** — one bounded bucket per `(cg[/sub]/layer)`, the same `dkg:knowledgeAsset <ual>` membership backlink, the same single indexed-seek read, the same `_meta` lifecycle row. What legitimately differs between layers is **policy** — who may read (§9), how long it lives, what it costs — **not structure**. That separation is the point: the three layers exist *because* their visibility/lifecycle policies differ, and for no other reason. §1.1 shows the same KA rendered identically in all three.

### 3.1 KA logical identity = its member-entity set

A KA is identified by the set of member entities `[...skolemizeByEntity(quads).keys()]`. This is **not a new claim** — it is exactly the set the cryptographic seal commits to:

```ts
// packages/core/src/assertion-seal.ts:47-56 (doc comment on ASSERTION_ROOT_ENTITY)
// Root entity bound to the seal (multi-valued). Recorded at finalize
// time so that publishFromFinalizedAssertion can scope the SWM
// SPARQL CONSTRUCT to exactly this assertion's quads instead of
// bundling everything currently in shared memory. The set is
// derived from skolemizeByEntity(filteredQuads).keys() … so the
// post-promote SWM lookup produces the same merkle leaves the seal
// was signed over.
```

Under OT-RFC-44 Design B, **one file = one KA, possibly many member entities** (`packages/publisher/src/auto-partition.ts:6-9`). The KA's quads are its member-entity closure over those roots and their skolem children.

### 3.2 Bounded buckets (the bucket key)

A **bucket** is a named graph holding many KAs. We define the bucket key as the triple `(contextGraphId, subGraphName?, layer)`:

| Layer | Proposed bucket URI | Today |
|-------|---------------------|-------|
| **WM** | `did:dkg:context-graph:{cg}[/{sub}]/_working_memory` (one per CG[/sub]; per-agent membership carried as a triple — see §9) | many `.../assertion/{addr}/{name}` |
| **SWM** | `did:dkg:context-graph:{cg}[/{sub}]/_shared_memory` — **already a bucket** (`constants.ts:217-219`) | unchanged |
| **VM** | `did:dkg:context-graph:{cg}[/{sub}]/_verified_memory` (one per CG[/sub]) — **identical shape to WM/SWM** | many `.../_verified_memory/{vmId}`; **no** subgraph form |

> **Invariant (REQUIRED).** The number of named graphs per `(CG, subGraph, layer)` MUST be a constant independent of the KA count. Any residual admin/metadata `listGraphs()` scan MUST NOT scale with KA count. This is the property that makes graph discovery O(1) and matches `SPEC_PART1_MARKETPLACE.md:168`.

Subgraph scope becomes part of the bucket key **and/or** a `_meta` predicate (`dkg:subGraphName`, already written at create — `metadata.ts:1341-1343`), never a per-view graph prefix. This is the structural fix for §2.3 and gives VM the subgraph dimension it lacks.

> **Membership lives in the bucket too.** Beyond the `_meta` row (§3.3), each KA's subjects carry an in-bucket UAL-keyed backlink `<member-subject> dkg:knowledgeAsset <reservedUal>` (§3.5). It is an ordinary data triple, not a side-index, so the bucket-count invariant is unaffected; it is what turns the per-KA read into a single bound-`(predicate,object)` POS seek.

> **VM is the same shape as WM/SWM — uniformity, not exception.** Earlier drafts let VM's *public projection* live in the legacy root data graph `did:dkg:context-graph:{cg}`. That is a **separate, optional public read-through**, not a second storage shape: the canonical VM store is the `_verified_memory` bucket, identical to the other two layers. Whether to also expose a public root-graph view is §15.1 — it does not, and must not, break the one-structure-for-all-layers invariant.

### 3.3 The `_meta` membership / lifecycle row and the in-bucket UAL backlink

KA lifecycle is carried as triples in `did:dkg:context-graph:{cg}/_meta`, keyed by the lifecycle URN (and, on-chain, the UAL). The lifecycle/seal record **exists today** and is rich (`metadata.ts:1314-1345`) — but here is the honest gap this RFC must close: **that record does not carry the KA's member-entity membership on the lifecycle URN for WM or SWM.** Today, entity members (`dkg:entity`/`dkg:rootEntity`, dual-written) are attached to the **UAL** and its `<ual>/<tokenId>` label rows (**VM/on-chain only**, `metadata.ts:204,227`), the promote **event node** `eventUri` (`metadata.ts:1397`), and the **SWM** meta graph `.../_shared_memory_meta` — *not* `_meta` (`metadata.ts:520`). The WM created-row (`metadata.ts:1313-1345`) carries **no** entity members at all.

So the membership index the bucket read path joins against (lifecycle-URN → `dkg:entity`, in `_meta`) is **net-new work for WM/SWM**, not a re-pointing of an existing index. This RFC's core schema change is therefore to **introduce** that row — write `dkg:entity`/`dkg:rootEntity` on the lifecycle URN in `_meta` at create/promote, and migrate SWM's members off `_shared_memory_meta` onto it (§11 Phase 1) — and to demote `dkg:assertionGraph` from a physical boundary to a soft pointer. The (existing) record otherwise carries:

- identity: `rdf:type prov:Entity`, `rdf:type dkg:Assertion`, `prov:wasAttributedTo <did:dkg:agent:0x…>`, `dkg:contextGraph`, `dkg:assertionName`, `dkg:subGraphName` (conditional);
- **membership (NEW on the lifecycle URN for WM/SWM):** `dkg:entity` / `dkg:rootEntity`, one per root (today only on VM label rows / the promote event node / `_shared_memory_meta` — `metadata.ts:204,227,520,1397`);
- lifecycle: `dkg:state`, `dkg:memoryLayer` (mutated in place across WM→SWM→VM);
- pointers: `dkg:wm/swm/vmCurrentAssertion` (assertion merkle hex, no `0x`), so layer divergence is plain string equality;
- on-chain identity at publish: `dkg:kaId` (`xsd:integer`), `dkg:reservedUal` (`dkg-agent-publish.ts:1834`; pushed as `RESERVED_UAL_PRED` at `:1841-1846`).

**The in-bucket backlink (the read-path enabler).** The `_meta` row above is the *authoritative* membership index, but resolving a single KA's quads from it requires a cross-graph join (`_meta` → roots, then bucket → subjects). To make the per-KA read a **single indexed seek inside the bucket with no `_meta` round-trip**, this RFC additionally materializes, in the **data bucket**, one backlink triple per KA subject:

```nquads
<member-subject> <http://dkg.io/ontology/knowledgeAsset> <reservedUal> <…/_working_memory> .
```

The predicate is **`dkg:knowledgeAsset`** (lowercase `k`) and the object is the KA's **`reservedUal`**. `dkg:knowledgeAsset` is verified **free** on this branch — `http://dkg.io/ontology/knowledgeAsset` has **zero** occurrences repo-wide (including tests); only the capitalized rdf:type class `dkg:KnowledgeAsset` is used (`metadata.ts:196,223,853,1001`, object position). The object MUST be the `reservedUal`, **not** `dkg:partOf <ual>`: reusing `partOf` with a UAL object would collide with the post-publish label rows `<ual>/<tokenId> dkg:partOf <ual>` (`metadata.ts:228,854`) and with `resolveKA`'s member-enumeration `?ka partOf <ual>` (`dkg-query-engine.ts:698`) — the code explicitly warns that even a single such self-edge "would make the bare node match `?x partOf <ual>` member-enumeration (incl. resolveKA) and double-count members" (`metadata.ts:187-189`). The free `dkg:knowledgeAsset` predicate sidesteps that trap entirely. (The word "root" is deliberately **absent** from this new predicate so it is never confused with a merkle root; the existing **code** predicate `dkg:rootEntity` is unchanged and is still cited verbatim wherever it actually appears.)

The backlink is **writable from finalize onward**: `reservedUal = did:dkg:{chainId}/{author}/{number}` is minted at `assertionFinalize` (`dkg-agent-publish.ts:1834`, where `number` comes from `kaNumberAllocator.allocate`), and is **preserved** across discard+recreate of an already-published name (`A2_PRESERVE_PREDS` includes `dkg:reservedUal`), so every subsequent WM draft of a finalized KA can re-emit it. (A brand-new, never-finalized WM draft has no `reservedUal` yet; for that pre-finalize window the read falls back to the §3.5 `STRSTARTS` closure until finalize stamps the backlink — see §11.)

### 3.4 The merkle boundary does not change

Because the seal commits the member-entity set (not the graph IRI), moving from a physical graph boundary to a logical member-entity boundary **cannot** change the consensus boundary. The same member-entity carve-out that runs over `.../_shared_memory` today runs over `.../_working_memory` and `.../_verified_memory` tomorrow and selects the identical merkle leaves — a **correctness** statement (§10). For **performance**, that read must use the *indexed* form of the closure, not the `STRSTARTS` string scan (§3.5).

### 3.5 The read MUST be a single indexed seek on the UAL backlink, not `STRSTARTS` — mandatory at scale

Logical identity buys nothing if reading one KA scans the whole bucket. The carve-out the codebase uses today — `?s ?p ?o . FILTER(?s = ?root || STRSTARTS(STR(?s), "<root>/.well-known/genid/"))` (`dkg-publisher.ts:1238-1247`) — is a **string-prefix filter over an unbound `?s`**, which no triple-store index can serve. It is **O(#triples in the bucket)**, not O(KA). Benchmarked on the pinned Oxigraph 0.5.5 with 100K KAs in one bucket (~800K quads): the `STRSTARTS` closure runs **616 ms** and grows **linearly** with bucket size (3 → 29 → 148 → 616 ms at 1K → 100K KAs); the indexed form below runs **~0.05 ms, flat** at every size — a ~2,900× gap by 50K. So reusing `STRSTARTS` over a bucket makes every per-KA point-read **slower than today** (today: O(#KA) discovery + O(KA) read; bucket + `STRSTARTS`: O(1) discovery + **O(bucket)** read). **The indexed read is therefore a hard prerequisite of the data-layer change, not an optimization.**

**The fix — a single indexed seek on the in-bucket UAL backlink (§3.3).** At skolemize/finalize time, alongside each KA's data quads, emit one backlink triple per subject **into the same bucket** — predicate `dkg:knowledgeAsset`, object the KA's `reservedUal` — for the member entity and every skolem child:

```nquads
<did:dkg:agent:QmImageBot>                              <http://dkg.io/ontology/knowledgeAsset> <did:dkg:100/0xabc...def/7> <…/_working_memory> .
<did:dkg:agent:QmImageBot/.well-known/genid/offering1>  <http://dkg.io/ontology/knowledgeAsset> <did:dkg:100/0xabc...def/7> <…/_working_memory> .
```

Then read the whole KA in **one indexed seek**, with **no `_meta` round-trip**:

```sparql
GRAPH <bucket> {
  ?s <http://dkg.io/ontology/knowledgeAsset> <ual> .                       # bound (predicate,object) → POS/POCS seek, O(KA)
  ?s ?p ?o .
  FILTER( ?p != <http://dkg.io/ontology/knowledgeAsset> )                  # backlink excluded from the data projection
}
```

Because both the predicate and the object are bound, this resolves through the store's POS/POCS index (Oxigraph GPOS, Blazegraph POCS/CSPO) directly to exactly the KA's subjects — **O(KA)**. It is the *same* bound-`(predicate,object)` access class `resolveKA` already runs portably on Blazegraph today (`?ka dkg:partOf <ual>`, `dkg-query-engine.ts:697-698`), so it does **not** reintroduce the multi-graph-UNION portability tax. And because the UAL is the object, the seek **needs no prior lookup of the member-entity set** — it replaces the superseded two-step `UAL → roots (in _meta) → subjects` read with a single seek against the data bucket. (Contrast `resolveKA`'s data read at `dkg-query-engine.ts:729-744`, which still uses the O(bucket) `STRSTARTS` closure at `:732` — exactly the form this read supersedes.)

- **Not a side index.** The backlink is an ordinary triple in the data graph, so it does **not** violate the target model's "no side-index / no ownership index" rule (`SPEC_PART1_MARKETPLACE.md:168`). It **does** deviate from where that spec puts the mapping — §168 places the membership predicate "in the meta graph"; we put `dkg:knowledgeAsset <ual>` **in the data bucket** deliberately (a same-graph seek avoids the cross-graph `_meta` join and keeps the read O(KA) in one round-trip). This RFC supersedes the spec on location and says so explicitly.
- **Predicate is verified free.** `http://dkg.io/ontology/knowledgeAsset` (lowercase) has zero occurrences repo-wide; only the capitalized rdf:type `dkg:KnowledgeAsset` exists (`metadata.ts:196`). The object is the `reservedUal`, **not** `dkg:partOf <ual>`, to avoid the documented member-enumeration double-count collision (`metadata.ts:187-189`, label rows `:228,:854`).
- **Write cost.** +1 triple per KA subject; rewritten on UPDATE, removed on DELETE (alongside the data). Writable from finalize onward (§3.3); `reservedUal` is preserved across discard+recreate so every redraft re-emits it.
- **Consensus obligation (REQUIRED).** Because the backlink lives in the bucket, the seek's `?s ?p ?o` returns it too, so **every gather site that feeds the merkle/seal MUST exclude `dkg:knowledgeAsset` from its projection** — **seven sites, enumerated in §10.1**. The two that are non-negotiable feed the **on-chain** root: the publish gather `_loadSelectedSWMQuads` (`dkg-agent-publish.ts:2508`) and the finalization gather `getSharedMemoryQuadsForRoots` (`finalization-handler.ts:299` → `computeFlatKCRoot :303`). The rest are the SWM seal CONSTRUCT (`dkg-publisher.ts:1252`), promote restatement (`:4257`), VM per-root restatement (`metadata.ts:954-958`), the sync diff (`sync-handler.ts:236,241`), and the RS-proof leaf gather (`ka-extractor.ts:243-246`). This is mechanically identical to the existing `q.predicate !== WORKSPACE_OWNER_PREDICATE` / `!isTrustLevelQuad(q)` exclusion already applied at those sites — proven, but §10 must enumerate all of them, with a test asserting the bucket-carveout merkle root equals the legacy per-KA-graph root **with backlink triples present**. If any one site is missed, the backlink leaks into the merkle leaf set and breaks consensus invariance.

Every per-KA operation that uses the closure — read, view, update (`_loadSelectedSWMQuads`), scoped DELETE (§6.3), sync-diff, RS-proof — inherits this indexed read or stays O(bucket). It is the single most load-bearing change in the RFC. The `STRSTARTS` member-entity closure is retained **only** as a migration-window fallback (pre-finalize drafts and un-backfilled legacy KAs, §11).

### 3.6 Is this reification? (and how it relates to Wikidata)

Yes — in a precise, limited sense, and the limits are the design. The `dkg:knowledgeAsset <ual>` backlink **reifies graph membership**: it turns the "*which KA does this triple belong to?*" fact — which a named-graph 4th term carries *implicitly* — into an *explicit, queryable* triple. Materializing context/provenance as first-class data is indeed the same instinct behind Wikidata's model. But it is **deliberately coarser**, and the difference is the whole point:

- **Wikidata reifies every *statement*.** Each `(entity, property, value)` becomes a *statement node* carrying qualifiers, references, and rank, so you can assert things *about an individual statement*. That is full n-ary / statement reification — several extra nodes and triples per fact.
- **This RFC reifies *membership*, at the *subject* level — not the statement level.** We only ever need to (a) recover a KA's triple-set and (b) hash a merkle over it; we never attach qualifiers to individual statements. So we tag each **subject** with **one** `dkg:knowledgeAsset <ual>` triple, not each statement with a node. One extra triple per subject, versus Wikidata's several per statement. If a future need for per-statement qualifiers ever arises, *that* would be the moment to consider RDF-star — not now.

Two reification-adjacent techniques already in play are what let one bucket behave like many named graphs:

- **Skolemization** (`<member>/.well-known/genid/N`, OT-RFC-44) gives formerly-blank nodes stable, hashable IRIs — the prerequisite for addressing and merkle-hashing a KA's sub-tree by string.
- **The `_meta` lifecycle/seal record** is textbook provenance reification: statements *about the assertion* (who, when, which chain, which merkle root), keyed by a URN.

We explicitly rejected the heavier options (RDF-star quoted triples; full `rdf:Statement` reification) in §12.1 — they cost portability or ~4× triples to buy per-statement qualifiers we do not need. The subject-level membership triple is the **minimum** reification that makes a single bucket behave like many named graphs.

---

## 4. Representation — a worked before/after example

**Setup.** `cg = acme`, `agent = 0xabc...def`, `name = img-bot`, single member entity `did:dkg:agent:QmImageBot`, one skolemized leaf (formerly `_:offering1`). The KA is published; `number = 7`, `chainId = 100`.

### 4.1 BEFORE — KA data quads in its own per-`(agent,name)` WM graph

```nquads
# Named graph: did:dkg:context-graph:acme/assertion/0xabc...def/img-bot
<did:dkg:agent:QmImageBot> <http://schema.org/name> "ImageBot" <did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> .
<did:dkg:agent:QmImageBot> <http://ex.org/offers> <did:dkg:agent:QmImageBot/.well-known/genid/offering1> <did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> .
<did:dkg:agent:QmImageBot/.well-known/genid/offering1> <http://ex.org/type> "ImageAnalysis" <did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> .
```

The KA's identity is the **4th term** — the graph IRI. To read this KA, the engine must first *discover* this graph (a `listGraphs()` prefix scan, §2.1).

The lifecycle record in `_meta`, keyed by the stable URN (`constants.ts:249-251`; field-by-field from `metadata.ts:1314-1345`, then mutated forward by promote/publish):

```nquads
# Named graph: did:dkg:context-graph:acme/_meta
# subject = assertionLifecycleUri('acme','0xabc...def','img-bot')
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/ns/prov#Entity> .
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/Assertion> .
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:0xabc...def> .
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/contextGraph> <did:dkg:context-graph:acme> .
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/assertionName> "img-bot" .
# physical-boundary pointer — the RFC demotes this from "where the data is" to a soft hint:
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/assertionGraph> <did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> .
# state/memoryLayer mutated in place (created/WorkingMemory -> promoted/SWM -> published/VM):
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/state> "published" .
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/memoryLayer> "VM" .
# per-layer pointers = assertion merkle hex, no 0x:
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/swmCurrentAssertion> "3f9a...c1" .
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/vmCurrentAssertion> "3f9a...c1" .
# per-author KA identity stamped at publish (number = low 96 bits of kaId):
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/kaId> "7"^^<http://www.w3.org/2001/XMLSchema#integer> .
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/reservedUal> "did:dkg:100/0xabc...def/7" .
```

The seal block in `_meta`, keyed by the **assertion graph URI** (built by `buildAssertionSealQuads`; predicate set from `assertion-seal.ts:30-69`):

```nquads
# Named graph: did:dkg:context-graph:acme/_meta
<did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> <http://dkg.io/ontology/assertionMerkleRoot> "3f9a...c1"^^<http://www.w3.org/2001/XMLSchema#hexBinary> .
<did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> <http://dkg.io/ontology/authorAddress> "0xAbc...Def" .
<did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> <http://dkg.io/ontology/authorAttestationR> "a1b2..."^^<http://www.w3.org/2001/XMLSchema#hexBinary> .
<did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> <http://dkg.io/ontology/authorAttestationVS> "c3d4..."^^<http://www.w3.org/2001/XMLSchema#hexBinary> .
<did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> <http://dkg.io/ontology/authorSchemeVersion> "1"^^<http://www.w3.org/2001/XMLSchema#integer> .
<did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> <http://dkg.io/ontology/assertedAtChainId> "100"^^<http://www.w3.org/2001/XMLSchema#integer> .
<did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> <http://dkg.io/ontology/assertedAtKav10Address> "0xKAv10..." .
<did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> <http://dkg.io/ontology/assertionFinalizedAt> "2026-06-06T12:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
# root-entity binding (dual-written legacy + new), one pair per member root entity:
<did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> <http://dkg.io/ontology/assertionRootEntity> <did:dkg:agent:QmImageBot> .
<did:dkg:context-graph:acme/assertion/0xabc...def/img-bot> <http://dkg.io/ontology/assertionEntity> <did:dkg:agent:QmImageBot> .
```

### 4.2 AFTER — same KA's data quads in a shared WM bucket, membership carried as triples

Only the **4th term changes** for the user data: the graph IRI is now the bucket, not a per-KA URI. The KA's identity is no longer the graph; it is the in-bucket UAL backlink (`dkg:knowledgeAsset <ual>`, §3.5) plus the `_meta` membership row.

```nquads
# Named graph: did:dkg:context-graph:acme/_working_memory   (ONE bucket, many KAs)
<did:dkg:agent:QmImageBot> <http://schema.org/name> "ImageBot" <did:dkg:context-graph:acme/_working_memory> .
<did:dkg:agent:QmImageBot> <http://ex.org/offers> <did:dkg:agent:QmImageBot/.well-known/genid/offering1> <did:dkg:context-graph:acme/_working_memory> .
<did:dkg:agent:QmImageBot/.well-known/genid/offering1> <http://ex.org/type> "ImageAnalysis" <did:dkg:context-graph:acme/_working_memory> .
# in-bucket UAL backlink — one per KA subject (root + skolem children), object = reservedUal (§3.5):
<did:dkg:agent:QmImageBot> <http://dkg.io/ontology/knowledgeAsset> <did:dkg:100/0xabc...def/7> <did:dkg:context-graph:acme/_working_memory> .
<did:dkg:agent:QmImageBot/.well-known/genid/offering1> <http://dkg.io/ontology/knowledgeAsset> <did:dkg:100/0xabc...def/7> <did:dkg:context-graph:acme/_working_memory> .
```

The `dkg:knowledgeAsset <ual>` rows are what the single-seek read (§3.5) lands on. They are excluded from every merkle/seal projection (§10), so they never enter the signed leaf set.

The lifecycle row is **identical** to §4.1 except the boundary pointer now names the bucket and the agent is carried as an explicit membership constraint (§9):

```nquads
# Named graph: did:dkg:context-graph:acme/_meta
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/assertionGraph> <did:dkg:context-graph:acme/_working_memory> .   # now a bucket, not a per-KA graph
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:0xabc...def> .                 # the agent partition key (server-enforced, §9)
# membership = the KA's root-entity set — a NEW _meta row this RFC introduces (today the WM created-row at metadata.ts:1313-1345 writes NO entity members on the URN):
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/rootEntity> <did:dkg:agent:QmImageBot> .
<urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/entity> <did:dkg:agent:QmImageBot> .
# everything else (state, layer, pointers, kaId, reservedUal) is byte-for-byte as in §4.1.
```

The `_meta` row remains the authoritative membership index (used by view/list joins, §5b/§5c); the in-bucket `dkg:knowledgeAsset` backlink is the denormalized read-path enabler for the single-KA seek (§5a). The **seal block is unchanged** (§10): its subject can remain the assertion URI, and its `assertionRootEntity`/`assertionEntity` quads are exactly the membership the `_meta` view-read filters on.

For an on-chain (VM) KA, the `_meta` node at its bare UAL (OT-RFC-44 Design B; from `metadata.ts:196-228`) is already membership-as-triples and needs no shape change — only the *data* moves from `.../_verified_memory/{vmId}` into the VM bucket / root data graph, carrying the same `dkg:knowledgeAsset <ual>` backlink on each subject:

```nquads
# Named graph: did:dkg:context-graph:acme/_meta
<did:dkg:100/0xkastorage.../12345> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/KnowledgeAsset> .
<did:dkg:100/0xkastorage.../12345> <http://dkg.io/ontology/publicTripleCount> "3"^^<http://www.w3.org/2001/XMLSchema#integer> .
<did:dkg:100/0xkastorage.../12345> <http://dkg.io/ontology/tokenId> "1"^^<http://www.w3.org/2001/XMLSchema#integer> .
<did:dkg:100/0xkastorage.../12345> <http://dkg.io/ontology/rootEntity> <did:dkg:agent:QmImageBot> .
<did:dkg:100/0xkastorage.../12345> <http://dkg.io/ontology/entity> <did:dkg:agent:QmImageBot> .
# per-root compatibility label row at <ual>/<tokenId> — note: partOf object=UAL, NOT the new dkg:knowledgeAsset backlink:
<did:dkg:100/0xkastorage.../12345/1> <http://dkg.io/ontology/partOf> <did:dkg:100/0xkastorage.../12345> .
<did:dkg:100/0xkastorage.../12345/1> <http://dkg.io/ontology/rootEntity> <did:dkg:agent:QmImageBot> .
<did:dkg:100/0xkastorage.../12345/1> <http://dkg.io/ontology/entity> <did:dkg:agent:QmImageBot> .
```

---

## 5. Retrieval — worked examples

### 5a. Get one KA by a single indexed seek on the UAL backlink

**UAL → quads, in ONE step.** The superseded design read this in two steps (UAL → roots in `_meta`, then roots → subjects via a closure). With the in-bucket `dkg:knowledgeAsset <ual>` backlink (§3.5), the per-KA read collapses to a **single bound-`(predicate,object)` seek with no `_meta` round-trip**:

```sparql
CONSTRUCT { ?s ?p ?o } WHERE {
  GRAPH <did:dkg:context-graph:acme/_working_memory> {
    ?s <http://dkg.io/ontology/knowledgeAsset> <did:dkg:100/0xabc...def/7> .   # POS index seek → the KA's root + skolem children, O(KA)
    ?s ?p ?o .
    FILTER( ?p != <http://dkg.io/ontology/knowledgeAsset> )                    # backlink excluded from the data projection (§10)
  }
}
```

This lands on the single-graph fast path (`dkg-query-engine.ts:438-439`) and is the same bound-object access class `resolveKA` already runs portably on Blazegraph (`?ka dkg:partOf <ual>`, `dkg-query-engine.ts:697-698`). No `listGraphs()`, no N-way UNION, no `_meta` join.

The `_meta`-keyed resolution (UAL/lifecycle URN → `dkg:entity`/`dkg:rootEntity`) is still the **authoritative** membership index and is used by the view/list joins (§5b, §5c) — but the single-KA read no longer needs it. For reference, that join (de-duped for the dual-written predicate window, `entity-predicate.ts:19-25`) is:

```sparql
SELECT DISTINCT ?root WHERE {
  GRAPH <did:dkg:context-graph:acme/_meta> {
    { <urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/entity>     ?root }
    UNION
    { <urn:dkg:assertion:acme:0xabc...def:img-bot> <http://dkg.io/ontology/rootEntity> ?root }
  }
}
```

> **Depends on §3.3.** The single-seek read returns rows only for KAs whose subjects carry the `dkg:knowledgeAsset` backlink (finalized KAs, and redrafts of finalized KAs whose `reservedUal` is preserved). For pre-finalize WM drafts and un-backfilled legacy KAs the read falls back to the `STRSTARTS` closure below. The `_meta` membership join likewise returns zero rows for a WM/SWM KA until Phase 1 (§11) writes the membership row.

**Migration fallback only** — the production carve-out today uses a `STRSTARTS` string-prefix filter (`dkg-publisher.ts:1238-1247`, `resolveKA` at `dkg-query-engine.ts:729-744`), which is **O(bucket), not O(KA)** (§3.5). It is retained solely for the migration window:

```sparql
CONSTRUCT { ?s ?p ?o } WHERE {
  GRAPH <did:dkg:context-graph:acme/_working_memory> {
    ?s ?p ?o .
    FILTER( ?s = <did:dkg:agent:QmImageBot>
         || STRSTARTS(STR(?s), "did:dkg:agent:QmImageBot/.well-known/genid/") )   # O(bucket) — fallback ONLY
  }
}
```

| | Today (per-KA graph) | RFC, `STRSTARTS` closure ✗ (fallback) | RFC + `dkg:knowledgeAsset <ual>` seek (§3.5) ✓ |
|---|---|---|---|
| Resolve which graph | `listGraphs()` whole-store scan (`:517`) → **O(#KA)** | bucket URI from `(cg, layer)` → **O(1)** | **O(1)** |
| Find the KA's subjects | named-graph read → O(KA) | `STRSTARTS(genid)` over unbound `?s` → **O(bucket)** | `?s dkg:knowledgeAsset <ual>` → **O(KA)** POS seek |
| `_meta` round-trip to get roots | n/a | n/a (uses root prefix) | **none** — UAL is the bound object |
| Net at 100K KAs | O(#KA) discovery + O(KA) read | O(1) + **O(bucket)** — *slower than today* | O(1) + O(KA), one seek — *strictly better* |

### 5b. Get a view (e.g. `working-memory` for an agent)

**Today:** `working-memory` resolves to the prefix `did:dkg:context-graph:acme/assertion/0xabc...def/` (`:82`) → `discoverGraphsByPrefix` → `listGraphs()` (`:517`) → if >1 graph, N-way `GRAPH … UNION` (`:2195`), with allow-list `VALUES` injection that also scales O(N graphs) (`:1069-1074`).

**RFC:** the view resolves to exactly one bucket graph plus a server-injected agent constraint (§9):

```sparql
# view = working-memory, agentAddress = 0xabc...def
CONSTRUCT { ?s ?p ?o } WHERE {
  GRAPH <did:dkg:context-graph:acme/_meta> {
    ?ka <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:0xabc...def> .   # server-injected, non-strippable (§9)
    { ?ka <http://dkg.io/ontology/entity> ?root } UNION { ?ka <http://dkg.io/ontology/rootEntity> ?root }
  }
  GRAPH <did:dkg:context-graph:acme/_working_memory> {
    ?s ?p ?o .
    FILTER( ?s = ?root || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/")) )
  }
}
```

No `listGraphs()`, no N-way UNION, no per-graph fallback. `DISTINCT/ORDER BY/LIMIT/aggregate` evaluate natively over one bucket (eliminating the §2.2 fail-hard at `:499-506`).

### 5c. Subgraph scoping — #184 falls out as a triple-pattern filter

**Today:** `{view, subGraphName}` throws (`:300-305`); even without the throw, the view prefix omits `/{sub}/` (`:82,:87`) so subgraph data is unreachable, and VM has no subgraph URI at all (`constants.ts:227`).

**RFC:** subgraph scope is a `_meta` predicate (`dkg:subGraphName`, already written at create — `metadata.ts:1341-1343`) and/or the `{sub}` segment of the bucket URI. Same query as §5b, one extra constraint:

```sparql
GRAPH <did:dkg:context-graph:acme/_meta> {
  ?ka <http://dkg.io/ontology/subGraphName> "epcis-events" .                      # <-- the ONLY addition
  ?ka <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:0xabc...def> .
  { ?ka <http://dkg.io/ontology/entity> ?root } UNION { ?ka <http://dkg.io/ontology/rootEntity> ?root }
}
GRAPH <did:dkg:context-graph:acme/epcis-events/_working_memory> { ?s ?p ?o . FILTER(closure) }
```

`#184` dissolves: subgraph is one more `WHERE` constraint, identical across WM/SWM/VM, and VM gains the subgraph dimension it never had. The hard throw at `:300-305` is deleted.

---

## 6. Update — worked example

### 6.1 Update a KA's content (merkle re-seal unchanged)

Updating a KA = re-publishing the same `name`, reusing the existing `kaId`. The engine routes CREATE-vs-UPDATE on whether `dkg:vmCurrentAssertion` is set and a packed `kaId` exists (`dkg-agent-publish.ts:2631-2632`):

```ts
// dkg-agent-publish.ts:2631 (UPDATE PATH)
if (vmCurrent && packedKaId !== undefined) {
  const updateQuads = await this._loadSelectedSWMQuads(contextGraphId, { rootEntities: seal.rootEntities }, opts?.subGraphName);
  const updateAttestation = await this._buildPrecomputedUpdateAttestationForSeal(packedKaId, seal);
  result = await this.update(packedKaId, contextGraphId, updateQuads.map((q) => ({ ...q, graph: '' })), [], { precomputedUpdateAttestation: updateAttestation, … });
}
```

`_loadSelectedSWMQuads` is the same `VALUES ?root + STRSTARTS` carve-out (`dkg-agent-publish.ts:2496-2505`), scoped to `seal.rootEntities`. **This is already KA-identity-scoped, not graph-scoped** — it reuses the `kaId`, re-loads only the seal's member entities, and re-seals over them. Because the merkle was always over the member-entity-scoped quads (§10), **the re-seal is unchanged under bucketing**: the carve-out runs over the bucket instead of a per-KA graph, but the leaves are identical.

On the receiver side, the VM update is already a **per-root full restatement** inside a shared data graph — never a graph drop (`metadata.ts:952-963`):

```ts
const rootsToPurge = new Set<string>(newRoots);
for (const { root } of priorKaRows) rootsToPurge.add(root);
for (const root of rootsToPurge) {
  await store.deleteByPattern({ graph: dataGraph, subject: root });
  await store.deleteBySubjectPrefix(dataGraph, root + SKOLEM_INFIX);
}
if (dataQuads.length > 0) await store.insert(dataQuads);
```

This is *already* "update a KA inside a shared bucket." Versioning (`prov:wasRevisionOf <prior>`, `dkg:vmCurrentAssertion` pointer) is carried as `_meta` triples on the lifecycle URN — consistent with §3.3.

### 6.2 Conditional write (CAS)

`POST /api/shared-memory/conditional-write` already locks **per subject** (member-entity-granular), not per graph (`dkg-publisher.ts:1076-1079`):

```ts
const lockPrefix = options.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
const lockKeys = [...new Set([...conditionSubjects, ...quadSubjects])].map(s => `${lockPrefix}\0${s}`);
return this.withWriteLocks(lockKeys, () => this._executeConditionalWrite(…));
```

A failed condition surfaces as `StaleWriteError` → HTTP 409 (`memory.ts:2066-2071`). Bucketing changes nothing: locks are already keyed on `(cg[\0sub]\0subject)`, so co-tenant KAs in the same bucket never contend unless they touch the same root subject. SWM ownership is **first-writer-wins** at member-entity granularity (`dkg:workspaceOwner`; same peer may upsert, a different peer is rejected — `dkg-publisher.ts:4498-4502`). This per-root concurrency primitive **replaces** per-graph isolation as the bucket's contention control.

### 6.3 DELETE — the one operation that must change

DELETE is the **only** operation that still depends on a physical graph boundary. `assertionDiscard` deletes `_meta` rows first (ordering), then `DROP GRAPH` the whole WM assertion data graph (`dkg-publisher.ts:4655-4657`; method opens at `:4615`):

```ts
const metaGraph = contextGraphMetaUri(contextGraphId);
await this.store.deleteByPattern({ subject: graphUri, graph: metaGraph });
await this.store.dropGraph(graphUri);     // <-- destroys the whole graph
```

In a shared bucket you cannot `DROP GRAPH` one KA without destroying co-tenants. DELETE MUST become a **KA-scoped delete** over the same in-bucket UAL backlink the read uses (§3.5) — an indexed `dkg:knowledgeAsset <ual>` seek to enumerate the KA's subjects, then a per-subject delete — the inverse of the carve-out already used in promote (`dkg-publisher.ts:4253`, prior-state SWM upsert delete at `:4513-4517`) and VM restatement (`metadata.ts:954-958`):

```sparql
# RFC delete primitive: indexed-backlink scoped delete (co-tenant-safe, O(KA))
DELETE { GRAPH <…/_working_memory> { ?s ?p ?o } }
WHERE  { GRAPH <…/_working_memory> {
  ?s <http://dkg.io/ontology/knowledgeAsset> <did:dkg:100/0xabc...def/7> .   # POS seek → exactly this KA's subjects
  ?s ?p ?o .
} } ;
# plus delete the KA's membership/lifecycle/seal rows from _meta.
```

> **NOTE — `deleteBySubjectPrefix` is itself an O(bucket) scan.** The naive implementation (delete the root subject, then `deleteBySubjectPrefix(bucket, root + "/.well-known/genid/")` for the skolem children) does **not** give an O(KA) delete: `deleteBySubjectPrefix` is a `STRSTARTS`-over-unbound-`?s` UPDATE on all three adapters — `packages/storage/src/adapters/oxigraph.ts:287`, `.../blazegraph.ts:80`, `.../sparql-http.ts:167` (declarations at `oxigraph.ts:281` / `blazegraph.ts:77` / `sparql-http.ts:164`; interface contract `triple-store.ts:48`) — so each call is O(bucket). It has **14** production call sites (`dkg-publisher.ts:935,:1492,:4516`; `metadata.ts:820,:957`; `publish-handler.ts:194,:539,:541`; `finalization-handler.ts:1170`; `dkg-agent-lifecycle.ts:3619`; `profile-manager.ts:96`; `update-handler.ts:376`; `workspace-handler.ts:1034`; `private-store.ts:326`), every one a per-root genid-prefix scan. Worse, the two **HTTP** backends pay **2× `countQuads` (a full-graph `COUNT`, O(bucket))** per call — `blazegraph.ts:78`+`:82`, `sparql-http.ts:165`+`:173` — whereas Oxigraph diffs `this.store.size` synchronously (`oxigraph.ts:285`+`:289`) and avoids that tax. To make DELETE genuinely O(KA) in a bucket, the child delete MUST also seed off the indexed `dkg:knowledgeAsset <ual>` backlink (as above), not `deleteBySubjectPrefix`.

The codebase already flags wanting an **atomic** combined DELETE via a single SPARQL UPDATE as a tracked follow-up needing a new `TripleStore` method (`dkg-publisher.ts:4640-4643`). The RFC folds that desire into the new delete primitive: one indexed `DELETE WHERE` over the backlink + the `_meta` rows, atomic where the store supports it.

> **Safety note.** A buggy scoped-delete now corrupts neighbouring KAs in the same bucket instead of an isolated graph. The seek MUST bind the exact UAL (`?s dkg:knowledgeAsset <ual>`); tests MUST assert co-tenant survival (§13).

---

## 7. Querying KAs together — worked example

A cross-KA analytical query (e.g. "every agent in `acme` that offers `ImageAnalysis`, with their name").

**Today** — the WM view fans out across every per-`(agent,name)` graph: `listGraphs()` prefix scan → N-way `GRAPH … UNION` (`:2195`). If the user's own `WHERE` contains a `UNION`, `wrapWithGraphUnion` returns `null` (`:2185-2192`) and the engine runs **one `store.query` per discovered graph** then dedupes (`:471-476`) — and if the query also has `DISTINCT/ORDER BY/LIMIT`, it **throws** (`:499-506`). N graphs, N round-trips, fragile on Blazegraph.

**RFC** — one bucket scan, evaluated natively:

```sparql
SELECT DISTINCT ?agent ?name WHERE {
  GRAPH <did:dkg:context-graph:acme/_working_memory> {
    ?agent <http://ex.org/offers> ?off .
    ?off   <http://ex.org/type>   "ImageAnalysis" .
    ?agent <http://schema.org/name> ?name .
  }
}
ORDER BY ?name LIMIT 50
```

One graph, one round-trip, `DISTINCT/ORDER BY/LIMIT` honored natively, portable across every SPARQL engine the `TripleStore` interface targets. Cross-KA analytics — the thing the DKG is *for* — stop being the worst case and become the cheap case.

---

## 8. How this solves the problems

| Problem | Mechanism that fixes it |
|---------|-------------------------|
| **§2.1** two `listGraphs()` scans per read (`:517`, `:576`) | Bucket URI computed directly from `(CG[/sub]/layer)`; nothing to enumerate or prefix-filter. Discovery O(1). |
| **§2.2** N-way `GRAPH … UNION` + Blazegraph nested-UnionNode crash (`:2195`, `e73e1c28`…`d19af5f8`) | One bucket graph ⇒ every read hits the single-graph fast path (`:438-439`). No union to build, no fallback, no `Illegal child type for union`. |
| **§2.2** cross-graph modifier reject (`:499-506`) | One bucket evaluates `DISTINCT/ORDER BY/LIMIT/aggregate` natively; the fail-hard shape is gone. |
| **§2.3 / #184** `{view, subGraphName}` throw (`:300-305`); prefixes omit `/{sub}/` (`:82,:87`) | Subgraph becomes a `_meta` triple-pattern constraint (`dkg:subGraphName`) and/or the `{sub}` bucket segment. The throw is deleted (§5c). |
| **§2.4** three layer cardinalities ⇒ three code paths | All three layers become one bucket + member-entity closure; one read/write/membership path. |
| **§2.5** alias-split graphs strand WM data | One agent-keyed bucket partition; backfill canonicalises both alias prefixes via `canonicaliseWmId` (§11). |
| **§2.6** SWM already works this way | Generalize SWM's `VALUES ?root + STRSTARTS` (`:1244-1253`) and CG-level ACL to WM/VM. |

**Related wins.**

- **Engine portability.** No multi-graph UNION ⇒ no Oxigraph-only AST shapes; the publish/read path stops diverging across Oxigraph/Blazegraph/Neptune/GraphDB/Jena (`triple-store.ts:1-5`).
- **Layer uniformity.** WM, SWM, VM share one storage shape and one membership index (§3).
- **VM subgraph parity.** VM gains a `subGraphName` dimension it lacks today (`constants.ts:227`).
- **Provenance preserved.** `prov:wasAttributedTo`, `prov:wasRevisionOf`, `dkg:state/memoryLayer`, per-layer merkle pointers are all `_meta` triples already; none depend on the graph boundary.

---

## 9. ACL & privacy — the hard part

This is where removing the graph boundary has real teeth. **WM privacy is enforced today by TWO independent mechanisms, both load-bearing:**

1. the **physical graph-URI boundary** `.../assertion/{addr}/{name}` (a cross-agent read can't name another agent's graph), and
2. an explicit **query-time deny** when the authenticated caller ≠ target agent:

   ```ts
   // packages/agent/src/dkg-agent-query.ts:580-596
   if (opts.view === 'working-memory' && callerAgentAddressStr && agentAddressStr &&
       canonicaliseWmId(callerAgentAddressStr) !== canonicaliseWmId(agentAddressStr)) {
     return emptyQueryResultForKind(sparql);
   }
   ```

The WM isolation test asserts mechanism (1) is what holds for cross-agent reads (`wm-multi-agent-isolation-extra.test.ts:114`: *"B cannot accidentally see A's WM via its OWN agentAddress (graph-URI scoping holds)"*). **Removing the per-KA graph removes mechanism (1).** So under bucketing the query-time filter becomes the *sole* WM isolation enforcer — this is a genuine trust-boundary redesign, not a no-op.

### 9.1 WM per-agent isolation — two options

| Option | How | Pros | Cons |
|--------|-----|------|------|
| **A. Bucket-per-agent** `.../{agent}/_working_memory` | Keep a physical boundary but bounded *per agent*, not per KA | Preserves a hard physical fence; graph count = O(#agents on node), not O(#KA) | Reintroduces a `listGraphs`-style cost proportional to agent count; cross-agent analytics need a UNION again |
| **B. Single WM bucket + query-time agent filter** (RECOMMENDED) | One `.../_working_memory` per CG[/sub]; agent carried as `prov:wasAttributedTo` in `_meta` | Truly O(1) graphs; uniform with SWM/VM | Isolation is **entirely** a query-time property; must be unspoofable |

Option B is recommended for uniformity, but it makes isolation a property of the **query layer**, so the RFC imposes:

> **REQUIRED — non-strippable agent constraint.** Every WM bucket read MUST have a server-side `?ka prov:wasAttributedTo <callerAgent>` (and the matching member-entity join) injected by the engine *after* the user's SPARQL. **This is net-new, security-critical query rewriting — not a reuse of an existing primitive.** `constrainGraphVariablesToAllowedSet` (`dkg-query-engine.ts:1060-1076`) only injects a `VALUES ?g {…}` binding on **graph variables** and assumes a single top-level `WHERE` (it throws if it cannot locate the brace). The agent filter is a different, harder mechanism: a correlated triple-pattern join tying `?ka prov:wasAttributedTo <caller>` to the bucket's member-entity FILTER, which MUST remain unstrippable under arbitrary user `UNION`/subquery nesting — the same class of bug `a9184f7a` fixed for the `?__dkg_viewGraph` leak. The engine does not have this capability today; it is the single most security-critical piece of new code in the RFC.

There are **three** WM-isolation enforcement points that must stay wired to the new filter, since mechanism (1) is gone:

- (a) the A-1 query-time deny (`dkg-agent-query.ts:580-596`),
- (b) the daemon HTTP 403 self-alias gate for unauthenticated callers (`query.ts:557-582`),
- (c) the new server-injected bucket constraint above (replacing the lost graph boundary).

### 9.2 Public / private CG

CG-level privacy is **orthogonal** to the per-KA boundary and survives bucketing unchanged. The private-CG fence excludes the **entire** CG by prefix, driven by a CG-level `dkg:accessPolicy "private"` triple (`dkg-agent-query.ts:737-757`):

```sparql
GRAPH <ontologyGraph> { ?cg <http://dkg.io/ontology/accessPolicy> "private" }
# for each unreadable cg: prefixes.push(`did:dkg:context-graph:${cg}`)  -> excludes ALL graphs under the CG, buckets included
```

Classification is CG-level (`issue-865-public-cg-allowlist.test.ts:16-18`). Because the bucket URI is *under* `did:dkg:context-graph:{cg}`, the prefix exclusion covers it automatically. SWM read ACL is likewise CG-level (`swm-agent-gate-access.test.ts:17-23`), which is the precedent that **WM/VM bucketing needs no per-KA ACL** — CG membership is the fence.

### 9.3 The allow-list change

An assertion graph is admitted only if it is **registered** via a `dkg:assertionGraph` triple in `_meta` — `discoverRegisteredAssertionGraphs` reads `?assertion dkg:assertionGraph ?graph` (`dkg-query-engine.ts:618-636`); `assertExplicitGraphIrisAllowed` separately gates explicit-IRI queries (`:900-908`); and `isScopedContentGraph` special-cases the `assertion/` and `_verified_memory/` tails (`:803`). Under bucketing these flip from *"enumerate and admit physical per-KA graphs"* to *"admit the bucket graph; constrain rows by agent + member-entity."* The `assertion/`/`_verified_memory/` branches are retired (§11 Phase 3).

### 9.4 Honest security surface

- **Single point of failure.** With Option B, a query-layer bug = a cross-agent WM leak, where before it would also have to defeat the graph boundary. Defense-in-depth (a)+(b)+(c) and adversarial tests (§13) are mandatory, not optional.
- **Co-tenant blast radius.** A buggy scoped-DELETE (§6.3) corrupts neighbouring KAs in the bucket, not an isolated graph. Mitigated by the exact closure filter + co-tenant-survival tests.
- **What does NOT get worse.** CG-level privacy (§9.2), SWM ACL (already CG-level), and the on-chain identity/UAL are untouched.

---

## 10. Merkle / consensus invariance

**The seal boundary does not change, because it was never the graph boundary.**

- The seal records the member-entity set, derived from `skolemizeByEntity(filteredQuads).keys()`, *"so the post-promote SWM lookup produces the same merkle leaves the seal was signed over"* (`packages/core/src/assertion-seal.ts:50-55`).
- The seal's EIP-712 author attestation signs a **fixed struct** — `(merkleRoot, author, chain binding)` — **not** the entity-list quads and **not** the graph IRI (`assertion-seal.ts:64-67`).
- Publish scopes the SWM CONSTRUCT to `seal.rootEntities` to reproduce those leaves (`dkg-agent-publish.ts:2682-2693`). That CONSTRUCT already runs over a **many-KA bucket** (`.../_shared_memory`) today.

Therefore: moving WM/VM data from a per-KA graph into a bucket changes the **4th term of each quad** and nothing else. The carve-out selects the identical triples; `computeFlatKCRoot` (referenced in OT-RFC-44 §2) hashes the identical flat set; the merkle root is byte-identical; the author attestation verifies unchanged. The same is true for updates (§6.1): `_loadSelectedSWMQuads` already re-derives the leaves from a bucket. **No node re-signs, no proof changes, no chain interaction.** This is the load-bearing feasibility fact for the whole RFC.

### 10.1 REQUIRED — exclude `dkg:knowledgeAsset` at every gather site

The in-bucket UAL backlink (§3.5) is a data triple in the bucket, so the carve-out / single-KA seek returns it alongside the KA's real data. It MUST therefore be **excluded from the projection at every site that gathers triples to feed a merkle/seal/diff**, exactly as those sites already exclude `isTrustLevelQuad` and `WORKSPACE_OWNER_PREDICATE`. The change is mechanically adding one term — `q.predicate !== KNOWLEDGE_ASSET_PRED` (or `FILTER(?p != <http://dkg.io/ontology/knowledgeAsset>)` in SPARQL) — to each existing filter. If **any** site is missed, the backlink leaks into the merkle leaf set and breaks consensus invariance. The complete, enumerated set on this branch:

| # | Gather site | Existing exclusion to extend |
|---|-------------|------------------------------|
| 1 | **SWM seal CONSTRUCT** projection-exclude — `dkg-publisher.ts:1252` (CONSTRUCT body `1238-1247`) | `result.quads.filter((q) => !isTrustLevelQuad(q) && q.predicate !== WORKSPACE_OWNER_PREDICATE)` |
| 2 | **Promote** restatement projection-exclude — `dkg-publisher.ts:4257` (closure FILTER `4250-4253`) | `gather.quads.filter((q) => !isTrustLevelQuad(q) && q.predicate !== WORKSPACE_OWNER_PREDICATE)` |
| 3 | **VM per-root restatement** — `metadata.ts:954-958` (purge loop), reinsert `:963` | the per-root `deleteByPattern`/`deleteBySubjectPrefix` + `insert` must not re-seal the backlink |
| 4 | **On-chain publish gather** — `_loadSelectedSWMQuads`, `dkg-agent-publish.ts:2496-2508` (closure FILTER `2500-2503`, returns `result.quads` with **no** exclusion at `:2508`; called in the publish path at `:2638`, `:2992`) | **this is the single most consensus-critical site** — it feeds the on-chain publish merkle; add the `q.predicate !== KNOWLEDGE_ASSET_PRED` exclusion here |
| 5 | **Finalization gather** — `getSharedMemoryQuadsForRoots`, `finalization-handler.ts:278-300` (closure FILTER `291-294`, returns `:299`) feeding `computeFlatKCRoot` at `:303` and `verifyMerkleMatch` at `:773` | the chain-reconcile root; same exclusion |
| 6 | **Sync diff** — `packages/agent/src/sync/responder/sync-handler.ts:236,241` (data projection `GRAPH ?g { ?s ?p ?o }` at `:236`, member-entity closure FILTER at `:241`) | the `?s ?p ?o` projection must drop `?p = dkg:knowledgeAsset` |
| 7 | **RS-proof leaf gather** — `packages/random-sampling/src/ka-extractor.ts:243-246` (public-triple CONSTRUCT; seed `?ka dkg:partOf <ual> ; dkg:rootEntity ?root` at `:201-202`) | the `?s ?p ?o` projection must drop `?p = dkg:knowledgeAsset` |

> **Audit obligation.** Sites 4 and 5 (publish + finalization) are the ones that feed the **on-chain** root — a miss there is a consensus break, not a local glitch. Before Phase 3, audit every other member-entity-closure gather for whether it feeds a merkle/proof: `workspace-resolution.ts:530`, `async-lift-subtraction.ts:151`, `dkg-agent-endorse.ts:796`, `dkg-agent-cg-registry.ts:1080`, `private-store.ts:284`.

A test MUST assert the bucket-carveout merkle root equals the legacy per-KA-graph root **with backlink triples present in the bucket** — i.e. that the exclusion actually fires at all seven sites. (The existing `dkg:rootEntity` code predicate at the seed/closure sites — `dkg-query-engine.ts:697`, `sync-handler.ts:241`, `ka-extractor.ts:202` — is unchanged; only the new `dkg:knowledgeAsset` data triple is excluded from the *projection*.)

---

## 11. Backwards compatibility & migration

**This RFC builds on `feat/unify-knowledge-assets-routes` (v10-devnet + KA-route-unification).** The route migration the earlier draft flagged as a thing to "coordinate with the rc.17 route surface" is **already done on this branch**: the legacy `routes/assertion.ts` file is **deleted** (commit `3b5c47fb`) and the daemon surface is now `/api/knowledge-assets`, with handlers in `packages/cli/src/daemon/routes/knowledge-assets.ts` (+ `knowledge-assets-import.ts`, `knowledge-assets-async-share.ts`, `shared-assertion-helpers.ts`). The bucketing work layers on top of that surface; no route caveat remains.

The migration reuses the in-repo dual-write/dual-read template from the `ASSERTION_ROOT_ENTITY → ASSERTION_ENTITY` rename: *"Dual-WRITTEN alongside the legacy predicate … readers continue to read the legacy name … until a later release switches the dual-read and drops the legacy write"* (`assertion-seal.ts:59-67`).

| Phase | Scope | Reader behaviour | Wire impact |
|-------|-------|------------------|-------------|
| **0 — Tactical #184 fix** (independent) | WM+SWM view resolver passes `subGraphName` into the prefix/URI; delete the `{view, subGraphName}` throw (`dkg-query-engine.ts:300-305`) for WM+SWM | unchanged | none |
| **1 — Dual-write + add membership index + backlink** | On write/promote/publish, write quads to **both** the per-KA graph **and** the bucket; **add the lifecycle-URN→`dkg:entity` membership row in `_meta`** (absent today for WM, §3.3; migrate SWM's members off `_shared_memory_meta`); **and emit the in-bucket `<subject> dkg:knowledgeAsset <reservedUal>` backlink** on root + skolem children (writable from finalize onward, re-emitted on each redraft of a finalized KA whose `reservedUal` is preserved, §3.3) | Readers prefer the indexed `dkg:knowledgeAsset <ual>` seek; fall back to the `STRSTARTS` closure for pre-finalize drafts / KAs without a backlink | none (WM node-local) |
| **2 — Backfill** | For each `.../assertion/{addr}/{name}` and `.../_verified_memory/{vmId}` graph, `CONSTRUCT` its quads into the bucket, stamp `_meta` membership, **and stamp the `dkg:knowledgeAsset <ual>` backlink on every subject**; **canonicalise BOTH** `.../assertion/{evm}/` and `.../assertion/{peerId}/` into one agent partition (`canonicaliseWmId`) or alias-stranded WM disappears | indexed-seek first, `STRSTARTS`/per-KA fallback for not-yet-backfilled subjects | none |
| **3 — Flip read** | Read bucket-only via the indexed backlink; stop writing per-KA graphs; retire `assertExplicitGraphIrisAllowed`/`isScopedContentGraph` `assertion/`+`_verified_memory/` branches and the two `listGraphs()` scans (`:517`, `:576`) | bucket-only, indexed seek | none |
| **4 — Drop legacy** | `DROP GRAPH` the now-empty per-KA graphs; drop the `STRSTARTS` fallback | bucket-only | none |

**UAL ↔ graph compatibility.** The UAL (`did:dkg:{chainId}/{addr}/{kaId}`) and packed `kaId` are unchanged. The daemon's UAL→`kaId` classification (`classifyKaIdentifier`, `packages/cli/src/daemon/routes/knowledge-assets.ts:156-173`; docblock `:151-154`, UAL trailing-segment parse `:158-162`, `(agent<<96)|number` at `:172`) is untouched. The internal store key moves from "graph IRI" to "member-entity set + bucket + UAL backlink," but the *external* handle is identical, so clients see no change. Note this is the same `reservedUal` the backlink uses as its object (`dkg-agent-publish.ts:1834`, `RESERVED_UAL_PRED` at `metadata.ts:1225`) — pre-knowable at finalize, so the read-path backlink is materialized as soon as the UAL exists.

**WM ships first (verified zero-wire).** WM is strictly node-local — sync/gossip **exclude** the `WorkingMemory` layer (`packages/agent/src/sync/responder/sync-handler.ts:282,303,394`: `FILTER(?layer != "${MemoryLayer.WorkingMemory}")`). So WM bucketing has **zero** cross-node/wire impact and is purely a single-node store-layout + query-filter change behind `contextGraphAssertionUri`'s **~20 (roughly two dozen) non-test call sites across 11 files** (`dkg-publisher.ts` ×6, `knowledge-assets-import.ts` ×4, `dkg-agent-publish.ts` ×3, + singles in `dkg-agent.ts`, `lifecycle.ts`, `knowledge-assets.ts`, `memory.ts`, `shared-assertion-helpers.ts`, `metadata.ts`, `dkg-query-engine.ts`, `graph-manager.ts`).

**SWM/VM are NOT a free ride — Phase 3 is a COST gate, not just a correctness gate.** The sync diff isolates a single KA's delta by a **member-entity closure** FILTER off `_meta` (`?s = ?re || STRSTARTS(… genid …)`, `packages/agent/src/sync/responder/sync-handler.ts:233-242,360-398`). The responder **already paginates the wire** (`ORDER BY ?g ?s ?p ?o OFFSET ${offset} LIMIT ${limit}` at `:242`, `:307`, `:398`), so the wire is bounded; the residual cost is that **each page still does O(bucket) join work** via the `STRSTARTS` closure (`:241`) until it seeds off the indexed `dkg:knowledgeAsset` backlink. Under co-tenancy the diff stays correct only if (a) bucket `?g` URIs stay stable **and** (b) the §3.3 membership rows + backlink exist on exactly the subjects the closure-diff joins against. The Phase-3 gate MUST therefore assert **both correctness and cost**: that the per-root closure-diff produces correct single-KA deltas inside a shared VM bucket **and** that per-KA sync-diff and RS-proof leaf gather touch **O(KA), not O(bucket)** (i.e. seed off the indexed backlink, sites 6–7 of §10.1) before any per-KA VM graph is retired (§13.11, §15.1).

**VM bucket key (explicit decision required).** `contextGraphVerifiedMemoryUri` has no `subGraphName` form (`constants.ts:227-228`), and the VM view already spans the **root data graph** `did:dkg:context-graph:{id}` plus the `_verified_memory/*` prefix (`dkg-query-engine.ts:156-159`). The RFC proposes: VM data for the **public** projection lands in the root data graph (matching `SPEC_PART1_MARKETPLACE.md:161-168`), with a per-CG[/sub] `_verified_memory` bucket for any non-public VM state; the `{vmId}` becomes a `_meta` attribute, not a graph segment. This is an open question (§15).

---

## 12. Costs / risks / alternatives considered

### 12.1 Alternatives

| Alternative | Why not |
|-------------|---------|
| **Status quo (per-KA graphs)** | The §2 problems are intrinsic to it: O(#KA) discovery, N-way UNION, Blazegraph fragility, #184, three code paths. |
| **RDF-star / quoted triples** for membership | Adds an engine-feature dependency (RDF-star support varies across Oxigraph/Blazegraph/Neptune/GraphDB/Jena) — the opposite of the portability goal (`triple-store.ts:1-5`). Membership is already cleanly expressible as plain triples (`dkg:entity`), so quoting buys nothing here. |
| **RDF reification** (`rdf:Statement`/`rdf:subject`/…) | 4× triple blow-up per membership fact and clumsy SPARQL; the lifecycle `_meta` record already carries membership far more compactly. |
| **Side index / ownership index** outside the store | Explicitly rejected by the target model: *"No side-index. No ownership index. No per-KA named graphs"* (`SPEC_PART1_MARKETPLACE.md:168`). A second index is a second thing to keep consistent (cf. the alias-split divergence, §2.5). |
| **Bucketed member-entity (this RFC)** | Already proven in production (SWM), zero chain/merkle impact, O(1) discovery, portable single-graph reads, and it *removes* code (the UNION machinery) rather than adding it. |

> **The "status quo" row understates the real alternative.** "Per-KA graphs" is slow today only because discovery goes through `listGraphs()`. A smarter variant — **Model 2: one named graph per KA keyed by the UAL, with discovery driven by a bounded `_meta` index instead of `listGraphs`** — keeps per-KA graphs *and* gets O(1) discovery and a fixed #184, while natively supporting overlapping multi-author claims and atomic `DROP GRAPH` delete. It is a genuinely distinct design point from both naive status quo and buckets, and is compared head-to-head with this RFC in **§16**.

### 12.2 Where it LOSES — be honest

- **Atomic `DROP GRAPH` is gone.** Deleting a KA was one cheap `dropGraph(uri)` (`dkg-publisher.ts:4657`); it becomes a scoped indexed-backlink `DELETE WHERE` (§6.3) — more SPARQL, and atomicity depends on store support (already a tracked follow-up, `dkg-publisher.ts:4640-4643`).
- **`count KAs = count graphs` is gone.** Today the number of per-KA named graphs *is* the KA count, so a KA census is a `listGraphs()`/prefix count. Under one bucket there is exactly one graph per `(CG,sub,layer)`, so counting KAs becomes a `COUNT(DISTINCT ?ka)` over the `_meta` membership rows (or the in-bucket `dkg:knowledgeAsset` objects), or a denormalized counter — not a graph count. This is a deliberate trade for O(1) discovery.
- **`deleteBySubjectPrefix` stays O(bucket), and HTTP pays it twice.** The skolem-child delete via `deleteBySubjectPrefix` is a `STRSTARTS` scan on all three adapters (`oxigraph.ts:287`, `blazegraph.ts:80`, `sparql-http.ts:167`), and the two **HTTP** backends additionally run **2× `countQuads` (full-graph `COUNT`, O(bucket)) per call** (`blazegraph.ts:78`+`:82`, `sparql-http.ts:165`+`:173`); Oxigraph diffs `store.size` and avoids the COUNT (`oxigraph.ts:285`+`:289`). So until the child delete seeds off the indexed backlink (§6.3), DELETE inherits an O(bucket) (HTTP: ~3× O(bucket)) cost.
- **`_meta` own-scan residual — NOT fixed by the data backlink.** `assertionCreate` runs a `_meta` lifecycle-subtree scan on (re)create — `FILTER(STR(?s) = "<lifecycleSubject>" || STRSTARTS(STR(?s), "<lifecycleSubject>/"))` (`dkg-publisher.ts:4110-4111`; method opens `:4068`) — to clean up stale event sub-entities. It is **O(#KA-in-CG)** because it scans `_meta`, not the data bucket, so the §3.5 `dkg:knowledgeAsset` data-bucket backlink does **not** address it. It needs its own indexed form (e.g. an indexed event→lifecycle link) and is called out here as a residual.
- **Pagination residual on the view/list CONSTRUCT path.** The query-engine view/list CONSTRUCT path injects **no LIMIT/keyset**: `wrapWithGraph` only wraps `GRAPH <uri> { inner }` (`dkg-query-engine.ts:2116-2134`, return `:2133`), reached via the single-graph fast path (`:438-439`). A bucketed view-all/list-scope read therefore returns the whole bucket unbounded; the RFC mandates a **keyset cursor on `kaId`/UAL** here. (The sync responder is *not* the gap — it already paginates the wire, `sync-handler.ts:242`; its residual is the O(bucket) per-page join, addressed by the indexed backlink.)
- **Per-graph ACL is gone.** A future "ACL per named graph" feature (if a backend offered it) is no longer available for WM/VM, because a KA no longer owns a graph. Isolation moves entirely to the query layer (§9).
- **Co-tenant blast radius.** A bug in the delete/closure scope corrupts neighbours in the bucket, not an isolated graph.
- **Hot bucket contention.** Many writers into one bucket rely on per-subject locks (`dkg-publisher.ts:1070-1073`) and first-writer-wins (`dkg-publisher.ts:4486-4494`) instead of per-graph isolation; pathological same-root contention is now visible where per-KA graphs hid it. (Arguably a correctness *gain* — the contention was always real.)

---

## 13. Test plan

The dangerous failures are isolation and consensus shaped; single-node happy-path tests are insufficient.

1. **Merkle invariance (consensus).** Promote+publish a multi-entity KA; assert the merkle root from the bucket carve-out == the root from the legacy per-KA graph, byte-for-byte. Assert the author attestation verifies unchanged. Run on a CG that also holds legacy per-KA KAs.
2. **WM cross-agent isolation under buckets (adversarial).** Agent A and B write WM into the *same* bucket. Assert B cannot read A's KAs via: (a) a plain view read, (b) a crafted SPARQL with a user `UNION`/subquery attempting to escape the injected `prov:wasAttributedTo` constraint, (c) naming A's member entity directly. The server-injected constraint MUST hold in all three (§9.1).
3. **Unauthenticated WM 403 gate.** With auth disabled, a caller with no recognised identity may only read the node-default agent's WM; else 403 (`query.ts:557-582`). Survives bucketing.
4. **Co-tenant-safe DELETE.** Two KAs share a bucket; delete one via the scoped `DELETE WHERE`; assert the other's quads + `_meta` survive intact, and the deleted KA's closure (incl. skolem children) is fully gone.
5. **#184 — subgraph view.** `{view: working-memory, subGraphName: epcis-events}` returns the subgraph's WM KAs (no throw). Same for SWM and VM (VM subgraph is new). Round-root vs subgraph data don't bleed.
6. **No `listGraphs` on the hot read path.** Spy `store.listGraphs`; assert a bucketed view-read calls it **zero** times (vs ≥2 today).
7. **Single-graph fast path.** Assert a bucketed read lands on `allGraphs.length === 1` (`:438-439`) — no `wrapWithGraphUnion`, no per-graph fallback.
8. **Blazegraph parity.** Run the cross-KA analytical query (§7) with an inner `UNION` + `ORDER BY`/`LIMIT` on Blazegraph; assert it does NOT throw the `:499-506` reject and matches Oxigraph output.
9. **Dual-read window.** Write membership with only legacy `dkg:rootEntity`; read with a node that emits `dkg:entity`; assert resolution via the `UNION` alternation and that results are `DISTINCT` (no double-count, `entity-predicate.ts:19-25`).
10. **Alias canonicalisation backfill.** Seed WM under both `.../assertion/{evm}/` and `.../assertion/{peerId}/`; run backfill; assert both land in one agent partition and neither is stranded (`canonicaliseWmId`).
11. **Cross-node ACK + RS proof on a bucketed VM KA.** A separate node ACKs and a challenger reconstructs the merkle proof from the bucket; assert leaves = all N entities' triples + skolem children (extends OT-RFC-44 §6).

---

## 14. Rollout

| Phase | Scope | Chain change? | Gate |
|-------|-------|---------------|------|
| **0 — Tactical #184 resolver fix (independent, ships first)** | WM+SWM view resolver threads `subGraphName` into prefixes/URIs; remove the `{view, subGraphName}` throw for WM+SWM (`:300-305`); VM remains deferred (no URI form yet) | No | `{working-memory|shared-working-memory, subGraphName}` reads return subgraph data; existing tests green |
| **1 — Dual-write buckets** | Write to per-KA graph AND bucket; refresh `_meta` membership; readers prefer bucket+closure | No | New publishes readable from bucket; merkle invariance test (§13.1) passes fleet-wide |
| **2 — Backfill** | `CONSTRUCT` legacy per-KA graphs into buckets; canonicalise alias prefixes | No | All historical WM/VM KAs resolve from buckets; no alias-stranded data (§13.10) |
| **3 — Flip read + retire scans** | Bucket-only reads; remove the two `listGraphs()` scans (`:517`,`:576`), the N-way UNION path, and the `assertion/`/`_verified_memory/` allow-list branches | No | Zero `listGraphs` on the hot path (§13.6); Blazegraph parity (§13.8) |
| **4 — Drop legacy** | `DROP GRAPH` empty per-KA graphs; stop dual-write | No | No per-KA graphs remain; graph count per `(CG,sub,layer)` is constant |

> **Phase 0 is independent.** The tactical WM+SWM resolver fix for #184 carries no storage-layout change and SHOULD ship on its own ahead of the bucket work, exactly as OT-RFC-44 carved out its urgent fix. The structural cure (Phases 1–4) then makes #184 un-recurrable.

> **Branch baseline.** This RFC is written against `feat/unify-knowledge-assets-routes` (v10-devnet + KA-route-unification), where the legacy `/api/assertion` surface is already retired in favour of `/api/knowledge-assets` (`routes/assertion.ts` deleted, commit `3b5c47fb`). The rollout therefore touches only the storage-layout / query-filter path; no route-surface migration is bundled into these phases. The Phase-3 gate is a **cost** gate as well as a correctness gate: per-KA sync-diff and RS-proof leaf gather MUST be shown to touch **O(KA), not O(bucket)** — i.e. seeded off the indexed `dkg:knowledgeAsset <ual>` backlink (§10.1 sites 6–7) — before any per-KA VM graph is retired.

---

## 15. Open questions

1. **VM bucket key.** Per-CG, per-subgraph, or keep `{vmId}` as a `_meta` attribute? How does the **root data graph** `did:dkg:context-graph:{id}` (already part of the VM view, `:156-159`) compose with a `_verified_memory` bucket — is the public projection *only* the root data graph (per `SPEC_PART1_MARKETPLACE.md:161-168`)?
2. **WM isolation: Option A vs B (§9.1).** Bucket-per-agent (hard fence, O(#agents) graphs) vs single bucket + injected query-time constraint (O(1) graphs, isolation entirely in the query layer). Is the query-layer-only fence acceptable given (a)+(b)+(c) defense-in-depth?
3. **Atomic scoped DELETE.** Adopt the tracked `TripleStore` follow-up (`:4652-4655`) as the new delete primitive, or accept bounded non-atomicity with retries during migration?
4. **Bucket URI naming.** `_working_memory` vs reusing the existing `_shared_memory` convention; do we want a `_verified_memory` (no `{vmId}`) bucket at all, or fold VM into the root data graph?
5. **Membership predicate primacy.** When does `dkg:entity` become the *sole* membership index and the legacy `dkg:rootEntity` dual-write stop (coupled to the OT-RFC-43 §10.1 rename schedule)?
6. **Hot-bucket write throughput.** Do per-subject locks (`:1076-1079`) + first-writer-wins (`:4498-4502`) scale to a high-fan-in single bucket, or do we need bucket sharding by a hash of the member entity (which would reintroduce a bounded, *constant* small set of graphs)?
7. **`dkg:subGraphName` vs `{sub}` bucket segment.** Carry subgraph scope as a `_meta` predicate, as the bucket URI segment, or both (the §5c example uses both)? Redundancy is safe but must stay consistent.

---

## 16. The entity-exclusivity fork: Model 1 (buckets) vs Model 2 (per-KA graph + `_meta` index)

> **Added after design review.** §1–§15 argue "buckets vs. today." That framing hides the actual decision. Bucketing is **not storage-model-neutral** — it forces one of two coherent data models. This section names both, compares them dimension-by-dimension, expands the central trade-off, surveys prior art, and gives a recommendation for the shared-agent-memory use case. The load-bearing realization: **the two §2 wins this RFC leads with (O(1) discovery, #184) are model-independent**, so they cannot, on their own, justify the model commitment that buckets quietly make.

### 16.1 The two models

**Model 1 — exclusive entity (this RFC, bucketed).**

- An entity (a `skolemizeByEntity` member subject) belongs to **exactly one KA** per `(CG, sub, layer)` bucket.
- Adding facts to an existing entity = **update its KA** (owner-only, OT-RFC-45).
- Cross-party knowledge = one authoritative item with provenance-bearing updates (the *shape* of Wikidata's "one item per entity" — see the caveat in §16.6).
- Storage: bounded buckets; membership via `dkg:rootEntity`/the in-bucket `dkg:knowledgeAsset <ual>` backlink (§3.5); per-KA read is an O(KA) indexed seek.

**Model 2 — overlapping KAs (per-KA named graph keyed by UAL + `_meta` index).**

- An entity may be described by **any number of KAs**; per-quad context is the graph's 4th term.
- Adding facts = **mint a new KA** that references the entity (no owner gate).
- Cross-party knowledge = complementary/competing KAs, separated by graph context, reconciled at query time.
- Storage: **one named graph per KA, named by the UAL** (its reserved UAL pre-publish); a **bounded `_meta` discovery/membership index**; discovery is **never** `listGraphs()` — it is a direct UAL→graph seek or an indexed `_meta` lookup. Subgraph scope is a `_meta` attribute (a KA lives in exactly one subgraph), not a quad-level dimension.

> **The §2 wins are model-independent.** O(1) discovery (§2.1) and #184 (§2.3) are achieved in Model 2 by the `_meta` index + subgraph-as-`_meta`-attribute, *without* collapsing per-KA graphs. The N-way-UNION/Blazegraph fight (§2.2) is likewise resolved in Model 2 by replacing the engine's textual per-graph UNION fan-out with a **variable-graph + `VALUES`** pattern. So neither §2.1, §2.2, nor §2.3 is a reason to prefer buckets specifically — they are reasons to *stop calling `listGraphs` and stop building textual UNIONs*, which both models can do.

### 16.2 Head-to-head

"Strictly better" means dominates on that dimension with no offsetting downside; otherwise the entry names the trade.

| Dimension | Model 1 — buckets / exclusive | Model 2 — per-KA UAL graph + `_meta` | Better |
|---|---|---|---|
| Overlapping claims about one entity | Forbidden (1 entity → 1 KA/bucket) | Native (per-quad context = the graph) | **M2** |
| "Add a fact" UX / permissionless contribution | Owner-only update or publish-time reject | Mint a new KA; no gatekeeper | **M2** |
| Point read (UAL → quads) | O(KA) via backlink seek (+exclusion machinery) | O(KA) via direct `GRAPH <ual>` seek | tie (M2 simpler) |
| Cross-KA full-subgraph analytic scan | single `GRAPH <bucket>` scan | `_meta` ⋈ N graphs (fragmented) | **M1** |
| Discovery (`listGraphs` avoidance) | O(1) bucket URI | O(1) via `_meta`/direct UAL | tie |
| Subgraph scoping / #184 | `_meta` attribute | `_meta` attribute | tie |
| Merkle/consensus risk surface | backlink in data → exclude at 7 sites + audit 5; one miss = consensus break | no backlink; graph term never enters a leaf | **M2** |
| Delete a KA | scoped `DELETE WHERE`; atomicity store-dependent; co-tenant blast radius | atomic `DROP GRAPH <ual>` | **M2** |
| WM per-agent isolation (ACL) | physical fence gone → build non-strippable query rewriter | physical graph-URI fence retained | **M2** |
| Pre-finalize / draft reads | no `reservedUal` → O(bucket) `STRSTARTS` on hot path | draft graph named by lifecycle URN → O(KA) | **M2** |
| Implementation / new code | backlink emit + 7-site exclusion + query rewriter + scoped delete | reuse graph reads + a `_meta` index | **M2** |
| Raw scalability ceiling | total triples only | total triples + per-store context bookkeeping at 10⁸–10⁹ graphs | **M1** |
| Alignment with SWM precedent + `SPEC:168` | matches verbatim | diverges (per-KA graphs) | **M1** |
| History / provenance / conflicting claims | overwrite-in-place loses dissent | append-only graphs preserve every claim | **M2** |

M1's wins concentrate on **full-scan analytics, raw graph-count headroom, and conformance to the current design/spec**. M2's wins concentrate on **correctness under overlap, consensus/ACL safety, delete simplicity, draft latency, implementation cost, and history.**

### 16.3 The deep point: physical isolation and scan-locality are the *same bit*

The graph-cardinality choice is **one bit that simultaneously sets five properties** — they are not independent knobs you can tune separately:

| Property | one graph **per KA** (M2) | one graph **per bucket** (M1) |
|---|---|---|
| Overlapping subject across KAs | **yes** (each KA's quads are 4th-term-isolated) | **no** (co-tenants share the graph; `?s ?p ?o` can't tell them apart) |
| Delete a single KA | atomic `DROP GRAPH` | scoped `DELETE WHERE` (store-dependent atomicity) |
| Physical ACL boundary | the graph URI **is** the fence | gone → enforced only by query rewriting |
| Merkle projection | graph term is never a leaf → nothing to exclude | backlink lives in data → exclude at every gather site |
| Full-subgraph scan | **N fragmented ranges** (one per KA) + a join | **1 contiguous range** |

Read the last two rows together and the conservation law is plain: **"per-KA physical isolation" and "single-range co-located subgraph scans" are the same bit inverted.** Co-location *is* the absence of isolation. You cannot buy fast whole-subgraph scans (M1) without also buying subject-exclusivity, query-only ACL, and the merkle-exclusion obligation — because they are all the one decision "put many KAs in one graph." Symmetrically, you cannot get overlap + atomic delete + a physical fence (M2) without paying fragmented full-scans. So the analytic-scan cost in §16.5 is **not an incidental wart of Model 2** — it is the exact, unavoidable dual of the flexibility Model 2 provides. Any claim to have "both" is really a third storage copy (a denormalized analytics graph) that must be kept in sync — the very "second index" the target model rejects (§12.1).

### 16.4 When does Model 1 even apply? Subject vs object position

Model 1 does **not** break merely because many KAs mention the same entity. It breaks only when an IRI is a **member *subject*** (a `skolemizeByEntity` key — contributes triples in subject position) of **more than one KA in a bucket**. An entity referenced in **object** position (`?event dkg:about <fn>`, `?edit dkg:editTarget <fn>`) is free in both models. So Model 1's viability is a **modeling-discipline question**:

- **Event/statement-shaped writes** — each KA mints a *fresh* subject (an event, a decision, an edit) and references shared entities as objects → no subject overlap → **Model 1 works** (and its full-scan analytics are a touch cheaper).
- **Direct multi-author annotation of a shared entity** — several agents each assert facts *on the entity itself* (subject position):

```trig
GRAPH <ka/A9> { <code:convertToMd> code:complexity 7 . }       # agent A
GRAPH <ka/C2> { <code:convertToMd> code:coverage "82%" . }     # agent C
GRAPH <ka/B8> { <code:convertToMd> code:smell "long-fn" . }    # agent B
```

Here `convertToMd` is a member subject of three KAs in the bucket → Model 1's single-seek read over-fetches all three as one blob and the per-KA merkle is polluted. Model 1 must then **reject** these (owner-only: only the node's owner may touch it) or **merge** them into one KA. Model 2 stores three graphs sharing an object IRI and answers every query with provenance intact. **The decision rule:** if your domain only ever *references* shared entities, both models work; if it *collaboratively annotates* shared entities, only Model 2 works without an owner bottleneck.

### 16.5 The `_meta` index is an equi-join, not a cross product

A common fear about the `_meta`-index pattern is that `SELECT … FROM <subgraph>` becomes a multiplication of `_meta` rows × subgraph triples. It does **not**. The pattern shares the variable `?ka`:

```sparql
GRAPH <…/_meta> { ?ka dkg:subGraphName "code" }   # binds ?ka to the N code KAs
GRAPH ?ka       { ?s ?p ?o }                        # SAME ?ka → 1-to-many equi-join
```

Each triple matches **only** the `_meta` row whose `?ka` is its own graph. With 1,000 code KAs totalling 50,000 triples: a cross product would be 1,000 × 50,000 = 50M rows; the equi-join is **50,000** — i.e. **O(subgraph size)**, never the product. The real cost vs. a Model-1 bucket scan is purely **constant-factor fragmentation**: N index range-seeks (one per KA graph) + a bounded join, vs. 1 contiguous range — same triples read, but N B-tree/LSM descents and a planner that must push the `?ka` restriction down. And it only bites **unselective** queries:

- **Discovery** (list KAs / since-timestamp / by-author): **pure `_meta`**, no data graph touched.
- **Selective content** (`?d dkg:about <fn>`, `?t dkg:assignee <X>`): a good planner seeds from the bound `(predicate,object)` index seek, lands on the few matching KAs, and uses `_meta` only as a confirming join → **O(matches)**.
- **Full-subgraph aggregates** (e.g. node degree over the whole code graph): genuinely **O(subgraph)** in *both* models — this is the only shape where Model 2's fragmentation is visible, and it is mitigable by denormalizing the aggregate into `_meta` (trading write-time work + staleness for read speed).

### 16.6 Prior art — which model is proven, and where

**Model 1 (exclusive/authoritative record) is proven for document- and master-data-shaped systems:**

- **Document stores** (MongoDB, Elasticsearch): the document is the unit, single-owner, updates replace. Proven at scale — *but documents don't share sub-entities*; cross-document references are by id and queries don't merge sub-trees, so the exclusivity is free.
- **Master Data Management** (Informatica, Reltio, "golden record"): literally "one authoritative entity, many sources reconciled in." This is the closest real precedent for Model 1's *intent* — **but MDM reconciles contributions with per-attribute (statement-level) provenance**, i.e. it tracks *which source asserted each value*. That is the heavy reification this RFC explicitly rejected (§3.6/§12.1).
- **Solid pods**: per-resource owner-only writes. A real system, but limited adoption, and the social cost of owner-gated writes is exactly the friction §16.4 flags.

> **The honest precedent gap.** Proven Model-1 systems either (a) don't share sub-entities (document stores), or (b) *do* allow multi-source contribution but reconcile via **statement-level provenance** (MDM, collaborative Wikidata). This RFC's Model 1 is the **third, least-precedented corner**: shared entities + subject-level membership + **owner-only updates with no statement provenance**. The "Wikidata's actual model" analogy in the alternatives discussion is imperfect — Wikidata's one-item-per-entity is livable *because anyone can attach a sourced statement to the shared item*; remove that (owner-only) and you keep the exclusivity constraint while losing the collaboration that makes it usable.

**Model 2 (overlapping, per-source context) is the native RDF idiom and is proven at web scale:**

- **The RDF Dataset / named-graph model itself** was designed precisely to carry per-statement-set context and provenance — the 4th term is *for* this.
- **Linked Data's "Anyone can say Anything about Any topic" (AAA)** open-world principle: many independent sources describe the same IRI, reconciled at query time. This is the foundational assumption of the entire RDF/SPARQL stack — and of a *decentralized* knowledge graph specifically.
- **Nanopublications**: each is a tiny named graph (assertion + provenance + publication info); the same entity recurs across millions of nanopubs with full attribution. A proven scientific-publishing model — and structurally **exactly Model 2**.

> A DKG is, by name and purpose, an open, multi-publisher, provenance-bearing graph. Model 2 is philosophically aligned with what a DKG *is*; Model 1 makes the DKG behave like a sharded document store with per-entity ownership.

### 16.7 Opinion — for shared agent memory on a large, historied codebase, Model 2 fits the grain

*(Author's recommendation, explicitly opinion.)* Picture the use case concretely: a context graph as **shared memory for several coding agents** on a big codebase with deep history — subgraphs for code (AST), tasks, decisions, spec. The workload has a characteristic shape:

- **Append-heavy, multi-writer.** Agents continuously add findings, decisions, edits, task updates.
- **Shared, long-lived entities.** Functions, files, modules, decisions are referenced and re-described constantly.
- **Conflicting and evolving beliefs are normal and valuable.** Agent A thinks `convertToMd` is the bottleneck; B disagrees; tomorrow both are revised. You want *both, with provenance and time*, not one silently overwriting the other.
- **Provenance and history are first-class.** "Who asserted this, when, and why" *is* the product (cf. the six queries in the worked example — half are pure provenance/discovery).
- **Permissionless enrichment.** Any agent should be able to annotate any code entity without asking an owner.

This is **event-sourcing**, and Model 2 maps to it natively: immutable per-claim graphs as the log, a materialized `_meta` view as the read model, supersession via `prov:wasRevisionOf` rather than destructive overwrite, conflicts coexisting with attribution, and O(1)/O(matches) discovery for the dominant query shapes. **Model 1 fights this grain on every axis** — owner-only updates bottleneck enrichment, in-place overwrite *destroys the history that is the whole point*, and subject-exclusivity forbids the collaborative annotation that multiple agents enriching a shared code graph will immediately want.

On scale: "lots of history" means many KAs, but a named graph is an **indexed column value, not a table** (§ Q2 analysis), so millions of graphs are storage-cheap; the binding costs are total triples and per-store context bookkeeping, and a single project's memory is realistically 10⁵–10⁷ KAs — comfortably within range when discovery is `_meta`-driven (validate at 10⁸–10⁹ only if you expect that ceiling). The price you pay — fragmented full-subgraph analytic scans (§16.3, §16.5) — lands on the *least frequent* query shape and is mitigable by denormalizing hot aggregates into `_meta`.

**So, concretely: for shared agent memory I would choose Model 2 — per-KA named graphs keyed by the UAL, with a bounded `_meta` discovery/membership index — and reserve Model-1 buckets only for subgraphs that are genuinely single-writer and analytics-dominated** (e.g. a machine-maintained derived index with one author and constant whole-graph scans), and even then as a *per-subgraph* bucket rather than a global one. I'd keep this RFC's problem statement wholesale — the `listGraphs`/UNION/#184 pain is real and well-diagnosed — but redirect the cure: **kill `listGraphs` and the textual UNION via the `_meta` index and variable-graph queries, which both models share, rather than collapsing per-KA graphs and inheriting an entity-exclusivity constraint that the multi-agent-memory use case actively works against. **§17 converts this into the concrete V10.0 launch decision.**

### 16.8 Traversal — the sharpest discriminator between the two models

Property-path / multi-hop traversal (`code:calls+`, transitive callers, dependency cycles, shortest path) is where the §16.3 "same coin" bites hardest, because of a precise SPARQL rule: **a property path is evaluated against a single active graph and cannot cross named-graph boundaries mid-traversal.**

- `GRAPH <g> { ?x p+ ?y }` traverses **only within `g`**.
- `GRAPH ?ka { ?x p+ ?y }` evaluates the path **inside each KA graph independently** — a single result path lies wholly within one `?ka` and never hops from KA-graph A into KA-graph B.

So in **Model 2**, where a call/dependency graph's edges are scattered across many per-KA graphs, a cross-KA path finds nothing useful via `GRAPH ?ka { … }`. Making it traversable requires forcing the edges into one active graph, and the portable options are all costly:

- **Union default graph** (store config) — works, but unscoped (whole store), and not every store defaults to it (Oxigraph's default graph is the unnamed graph, so paths return empty without explicit `FROM`).
- **`FROM <g1> FROM <g2> …`** enumerated from `_meta` — scoped, but the `FROM` list **grows with the number of KAs in scope** (graph URIs in `FROM` must be literal), which **reintroduces the §2.2 N-graph query-text bloat** — just moved from `UNION` branches to `FROM` clauses.
- **Materialize a co-located edge/index graph** — fast, but the denormalized second copy the target model rejects.

In **Model 1**, the subgraph is one graph, so `GRAPH <…/_code> { ?x code:calls+ ?y }` traverses the whole subgraph natively, and the graph-count for any traversal scope is **O(#subgraphs) = a small constant** (even cross-subgraph traversal is a bounded `FROM <code> FROM <decisions>`). Note also that store-specific traversal (Neptune Gremlin/openCypher) would help M2 but **breaks the pure-SPARQL-1.1 portability contract** (`triple-store.ts:1-5`), so it is not a portable escape hatch.

**Consequence for the hybrid:** traversal is the cleanest signal for `storageModel`. Graph-structured, traversal-heavy subgraphs — the code/AST/dependency graph above all — want `bucket` (M1), and they are *also* typically single-writer (the indexer), so the entity-exclusivity cost is free there. Judgment/append subgraphs (decisions, tasks, findings) are not traversal-heavy and want `per-ka` (M2). This is why the deferred M1 path (§17.6) targets exactly the code-graph-shaped subgraphs.

---

## 17. Decision for V10.0 mainnet: ship Model 2, with the hybrid as the target architecture

> **This section is the decision.** §16 lays out the fork; this section resolves it for launch. We must adopt **one** system for V10.0 mainnet. We adopt **Model 2 (per-KA named graph keyed by the UAL + a bounded `_meta` discovery index)** as the single shipping model, and **§16's per-subgraph hybrid as the target architecture** that V10.0's substrate is explicitly built to extend.

### 17.1 The decision

1. **Target architecture (multi-release):** §16's hybrid — a per-subgraph `dkg:storageModel ∈ { per-ka (M2), bucket (M1) }`, over a **universal substrate** (`_meta` index + UAL/`kaId` + the layout-independent seal of §10).
2. **V10.0 mainnet ships exactly one implemented model: Model 2.** `per-ka` is the default and, at launch, the only `storageModel`. There is no `bucket` code path in the V10.0 critical scope.
3. **Model 1 / `bucket` is specified (this RFC, §3–§10) but deferred** to a post-launch release, as an opt-in `storageModel` for traversal-/analytics-heavy, typically single-writer subgraphs (the code/AST graph is the canonical case — §16.8 traversal argument).

### 17.2 Why Model 2 is the lower-delta, lower-risk launch choice

- **WM and VM are already Model 2.** Per §1's current-state table, WM (`…/assertion/{addr}/{name}`) and VM (`…/_verified_memory/{vmId}`) are **already one-graph-per-KA ("MANY")**. Only SWM is already a bucket. So 2 of 3 layers stay structurally as-is; M2 changes only **discovery** (read the `_meta` index instead of scanning `listGraphs()`) and **naming** (key the per-KA graph by the UAL / reserved UAL). Model 1 would instead *convert* WM and VM from per-KA graphs into buckets — strictly more churn.
- **It fixes every §2 problem with model-independent machinery.** `listGraphs` O(#KA) discovery (§2.1), the N-way-UNION/Blazegraph tax (§2.2), and #184 (§2.3) are all resolved by the `_meta` index + variable-graph/`VALUES` queries + subgraph-as-`_meta`-attribute — none of which require buckets.
- **It removes the four riskiest pieces from the launch critical path** (see §17.3).
- **Nothing is wasted.** The substrate built for M2 — `_meta` membership/discovery, UAL keying, the layout-independent seal — is exactly the foundation the deferred M1 path reuses.

### 17.3 What ships vs. what defers (the scope cut)

| Concern | V10.0 — Model 2 (ships) | Deferred — Model 1 / `bucket` (post-launch) |
|---|---|---|
| Discovery (§2.1) | `_meta` index replaces `listGraphs()` | — (same substrate) |
| Cross-graph reads (§2.2) | variable-graph + `VALUES` replaces textual UNION | — |
| Subgraph / #184 (§2.3) | subgraph as a `_meta` attribute | — |
| Data placement | per-KA graph keyed by UAL (WM/VM already this) | one bucket per `(sub, layer)` |
| Membership backlink (§3.3/§3.5) | **not needed** — the graph **is** the KA identity | required (`dkg:knowledgeAsset <ual>` in-data) |
| Merkle exclusion (§10.1, 7 sites + audit) | **not needed** — no backlink in the data | required, and consensus-critical |
| WM per-agent ACL (§9.1) | physical graph-URI fence **retained** | requires the non-strippable query rewriter |
| Delete (§6.3) | atomic `DROP GRAPH <ual>` | scoped co-tenant-safe `DELETE WHERE` |
| Entity exclusivity (§16.4) | **not enforced** — overlap is allowed | enforced (extend `workspaceOwner`) |

The right-hand column is precisely the set of consensus- and security-critical mechanisms this RFC spent §3.5, §6.3, §9.1, and §10.1 worrying about. **Shipping M2 takes all of them off the mainnet-launch critical path.** Those sections remain the normative spec for the *future* `bucket` model; they are simply not V10.0 scope.

### 17.4 The one real conversion: SWM

SWM is the only layer already bucketed (M1). For a single launch model, SWM data moves from the single `…/_shared_memory` graph into per-KA graphs keyed by the UAL — **the same per-KA path WM and VM use**, so it is applying one uniform code path, not adding a second.

- **Migration:** reuse §11's dual-write/backfill, scoped to SWM — dual-write each promoted KA into both `_shared_memory` and its per-KA graph; backfill existing SWM via the per-member-entity `CONSTRUCT`; flip reads to the `_meta`-index path; drop the bucket.
- **Silver lining + behaviour-change flag (REQUIRED decision):** under M2 overlap is allowed, so SWM's `workspaceOwner` first-writer-wins **exclusivity enforcement** (`dkg-publisher.ts:4487-4490`) is **no longer required for correctness** — it becomes optional policy. This is a deliberate behaviour change: two peers may both hold KAs about the same entity in SWM. V10.0 MUST decide explicitly whether to (a) drop the exclusivity check, or (b) keep `workspaceOwner` as a *soft* advisory/ownership hint without rejecting co-claims.

### 17.5 Consensus safety of shipping M2

Because the seal is layout-independent (§10), shipping M2 changes **no merkle root** relative to today's per-KA WM/VM, and SWM's bucket→per-KA split reproduces byte-identical leaves (same member-entity carve-out, only the 4th term changes). Consistent with the header: **no chain change.**

### 17.6 The deferred Model 1 path (additive, gated)

When a subgraph proves traversal-/analytics-heavy (the code/AST graph), add `bucket` as an opt-in `storageModel`: implement the backlink (§3.5), the 7-site exclusion + audit (§10.1), the scoped delete (§6.3), and — only if it is a WM subgraph — the query rewriter (§9.1). The substrate already exists, so M1 lands as a **localized, opt-in data-placement strategy**, gated behind the §13 consensus-invariance and cost tests. No part of V10.0 has to be unwound to add it.**
