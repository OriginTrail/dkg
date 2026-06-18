# RFC: Per-KA metadata trim + indexed graph addressing

**Status:** Proposed — Phases 0–1, **all of Phase 2**, and Phase-3 items 1/3/4 + the minimal-shape partition implemented in the accompanying PR; Phase-3 item 2 (lifecycle-URN merge) is deferred with a worked plan (see below).
**Motivation:** scalability. Publishing **one 1-triple KA leaves ~134 resident quads** in the local store (live-measured, rc.17, Base Sepolia). ~97% is publish bookkeeping, ~30 quads are repeated copies of five values. Combined with hot-path SPARQL that scans graph names, this is the mechanism behind the rc.17 idle-node CPU saturation (`oxigraph-server` at 200–360%): store volume feeds RocksDB compaction *and* makes every recurring full-store reconciler query more expensive. The storage adapter itself documents the second half: *"the `SELECT DISTINCT ?g` quad-store scan — **the dominant idle-node CPU cost**"* (`packages/storage/src/adapters/sparql-http.ts:336`).

## Ground truth (live dump, KA #122, `megagiga` CG)

One `dkg shared-memory publish` of 1 user triple writes, resident:

| Graph | Quads | Content |
|---|---|---|
| `{cg}/_meta` | 86 | on-chain mirror (UAL node, 21) · token node `UAL/1` (7) · AuthorshipProof bnode (4) · author seal + chain receipt (15) · lifecycle URN (16) · 2 PROV events (17) · publication node (5) · orphan WM marker (1) |
| `{cg}/context/{id}/_meta` | 29 | byte-identical copy of UAL + UAL/1 rows (+1 dangling bnode) |
| `{cg}/_shared_memory_meta` | 15 | ShareTransition (5) + public-stage snapshot (10) |
| `{cg}/_verifiable_memory/{addr}/{n}` | 2 | **the user triple** + trust stamp |
| `{cg}/context/{id}` | 2 | queryable copy of the user triple |

Redundancy: merkle root ×6, entity URI ×10 (`entity`+`rootEntity` pairs on 5 subjects), author address ×8, on-chain id ×3 (+ as the UAL's last URI segment), tx/block ×2 each.

Method: every predicate audited for **writers and readers** (grep over `packages/*/src`, `node-ui`, `mcp-dkg`; both `${NS}pred` template and inline-IRI forms). Verdicts: **DROP** = zero readers repo-wide; **MIGRATE** = readers exist but trivially re-pointable; **KEEP** = load-bearing.

## Part 1 — metadata trim

### Phase 0: dead code (implemented)

- `generateAssertionPublishedMetadata` (`packages/publisher/src/metadata.ts:1465-1496`) and its gate (`packages/publisher/src/dkg-publisher.ts:1550-1578`) — the gate joins `dkg:agent`, a predicate the lifecycle writer never emits (it writes `prov:wasAttributedTo`), so it **never fires**: 0 `dkg:AssertionPublished` instances in a live store with 113 assertions. The SWM→VM flip is done imperatively (`dkg-agent-publish.ts:3067-3127`).
- The orphaned history `OPTIONAL { … dkg:kcUal … }` read (`packages/agent/src/dkg-agent.ts:1914`).
- The dangling `authoredBy` blank node in the partition copy (no outgoing triples in any graph).

### Phase 1: zero-reader drops (implemented) — ≈ −23 quads/KA

| Dropped triple | Was written at | Why safe |
|---|---|---|
| `dkg:kaCount` | metadata.ts:138 | zero readers; wire/chain carries its own count. Post-rc.17 one publish = 1 KA, so it is also a constant `1` — a KC-era remnant |
| `dkg:blockTimestamp` | metadata.ts:332-337 | zero readers |
| `dkg:publisherAddress` | metadata.ts:338 | zero readers (code uses on-chain/UAL-derived address) |
| `dkg:chainId` | metadata.ts:340 | zero readers (code reads `this.chain.chainId`) |
| `dkg:tokenId` ×2 (KC + token rows) | metadata.ts:201-203, 231 | zero readers (token order parsed from `<ual>/<n>` URI, metadata.ts:973-979) |
| `dkg:publicTripleCount` ×2 | metadata.ts:199, 232-237 | zero readers (recomputed from payload at verify time) |
| `dkg:authoredBy → bnode` + AuthorshipProof block (5) | metadata.ts:426-436 via dkg-publisher.ts:2794-2809 | zero code readers; on-chain `KnowledgeBatch.authorAddress` is canonical per the writer's own comment (metadata.ts:79-81) |
| Publication node + `dkg:publication` edge (6) | metadata.ts:266-278, 277 | zero pattern readers; only the backfill repair tool CONSTRUCT-copies it (one-line tool edit included) |
| lifecycle URN: `a prov:Entity`, `a dkg:Assertion`, `dkg:contextGraph`, `prov:wasGeneratedBy` (4) | metadata.ts:1333-1337 | type rows / `contextGraph`: readers none (the type row's sole reader was the Phase-0 dead gate; history joins event-side `prov:generated/used`); `prov:wasGeneratedBy`: one generic client-side matcher exists but is not stranded — see the graph-viz correction below |
| `dkg:blockNumber` | metadata.ts:331 | sole reader is an `OPTIONAL` clause (endorse provenance, dkg-agent-endorse.ts:893) — binds nothing, degrades gracefully; derivable from `transactionHash` via RPC on demand |

**Correction (adversarial review F1):** `dkg:publishedAt` (KC row, metadata.ts) was originally in this table but is **KEEP**, not DROP — the reader audit missed the kafka-plugin discovery queries (`packages/kafka-plugin/src/discovery.ts` `buildListQuery`/`buildCountQuery`/`buildSingleByUalQuery`), which join `?ual dkg:publishedAt ?receivedAt` and order the KA list by it. The write stays on the KC/UAL row (+1 quad vs. the original Phase-1 estimate).

**Correction (adversarial review, graph-viz):** the lifecycle-URN `prov:wasGeneratedBy` "readers: none" verdict was literally wrong — the audit missed a client-side predicate matcher (same failure mode as the F1 kafka-plugin miss): `packages/graph-viz/src/core/provenance-resolver.ts:79` generically matches `prov:wasGeneratedBy` on any loaded node and populates `ProvenanceInfo.generatedBy`/`generatedByName`. The DROP nonetheless stands — the removal strands nothing: (a) `_meta` lifecycle rows are never fed to the viz in any default node-ui flow (`MemoryLayerView` feeds `RdfGraph` data-layer SPARQL results only; `_meta` is joined solely to enumerate WM graph names); (b) `generatedBy`/`generatedByName` have no renderer anywhere in the repo; (c) the resolver's live feed is content-layer `prov:wasGeneratedBy` writers untouched by the trim (semantic enrichment `shared-assertion-helpers.ts`, agent profiles `profile.ts`, user-authored data). Documentation-only correction; no code change.

The `context/{id}/_meta` partition copy is a CONSTRUCT-copy of the KC/token rows, so it **shrinks automatically** by every quad dropped above.

### Phase 2: dedupe with small reader migrations (implemented in full)

| Item | Saves | Migration |
|---|---|---|
| `rdf:type dkg:KnowledgeCollection` + aggregate `dkg:KnowledgeAsset` type rows | −2 | rewrote the two status counters (`packages/cli/src/daemon/lifecycle.ts`) to count `dkg:status` / member subjects |
| `entity`+`rootEntity` dual pairs on 5 subjects → **one `rootEntity`** (the §10.1 rename is cancelled for the member list; honest name waits for the next ontology bump) | −8 | dual-read shim retained (`packages/core/src/entity-predicate.ts:39`) — replicas hold dual-written rows; seal pair stays (signed material); the promote EVENT no longer carries the member list at all — history/feed readers fall back to the stable lifecycle-subject stamp (read-both) |
| `wm/swm/vmCurrentAssertion` written only on divergence from `vm` (same hash ×3 when no draft) | −2 | `vm` always written; history reader `COALESCE`s missing `wm`/`swm` → `vm` (`agent.assertion.history()`); the create-vs-update idempotency gate reads only `vm`; convergent stamps now DELETE the stale row (`_stampPointerIfDivergedFromVm`) |
| `fromLayer`/`toLayer` on events (100% determined by event class) | −4 | OPTIONAL in the history query, derived in TS from the event class (Created ⇒ none→WM, Promoted ⇒ WM→SWM, Updated ⇒ VM→VM, Discarded ⇒ WM→none); old-store rows still read |
| `prov:wasAssociatedWith` on events | −2 | node-ui feed pattern OPTIONAL with `COALESCE` to the subject's `prov:wasAttributedTo` (same agent DID, stamped at create) |
| partition copy → documented minimal shape (`restateKaPartition`) | −21 | RS prover needs only `rootEntity` + `batchId` (+`privateMerkleRoot`) — ka-extractor read-both |
| `publishedAtKaId` (third copy of the on-chain id) | −1 | receipt builder (`buildAssertionPublishReceiptQuads`) no longer emits it; node-ui receipt hook reads the UAL-subject `dkg:batchId` (read-both: legacy receipt rows win) |
| `publicSnapshotRef` (byte-identical to `publicQuadsDigest` — `putSnapshot` returns `ref === digest`) | −1 | collapsed: store-backed rows are "digest + no `publicSnapshotGraph`"; compact resolution + SWM snapshot sync read-both |
| orphan WM `memoryLayer` marker at VM flip | −0 (corrected by review F4) | the imperative flip (dkg-agent-publish.ts) UPDATES the per-KA WM-graph marker in place to `"VM"` instead of deleting it — `assertAssertionDataPersisted` reads it as the stale-re-promote no-op witness (Codex #898), so the row must survive; the misleading orphan `"SWM"` value is gone either way |

**Identity columns after dedupe:** the UAL-row on-chain id is the *queryable index* (rename `dkg:batchId` → `dkg:onChainId` only at the next deliberate ontology bump); the seal's `reservedKaId` survives untouched — it is OT-RFC-43 §F2 **author-signed material**, not a redundant copy.

### Phase 3: aggressive options (items 1, 3, 4 and the minimal-shape partition implemented; item 2 deferred)

1. **Collapse `UAL` + `UAL/1` into one node** (−7, kills `dkg:partOf`) — **implemented**. Justified by the post-rc.17 invariant "1 publish = 1 KA = 1 UAL". Writers collapsed (`generateKCMetadata`, `restateKaPartition`, `restateLabelGraphForUpdate`); readers migrated read-both (UAL-subject ‖ legacy `<ual>/<n>`+`partOf`): resolveKA, access-handler (incl. a `<ual>/<n>`→bare-UAL fallback for old clients), RS prover, sync delta filter, sync Merkle verifier (see the sync-verify correction below), daemon KA counter, update prior-roots, async-lift subtraction, EPCIS UAL annotation, kafka-plugin discovery (list/count/single — also the reason `dkg:publishedAt` is KEEP, see the Phase-1 correction); endorse + cg-registry already matched both shapes.

   **Correction (adversarial review, multi-root-access):** the collapse is now **conditional**. Unconditionally collapsed multi-root KAs lost the root↔bag pairing private access depends on: bags are stored and served strictly per root (`storePrivateTriples`/`getPrivateTriples(rootEntity)`), but with every member `dkg:rootEntity` and per-root `dkg:privateMerkleRoot` row on one UAL subject the AccessHandler could only pick an engine-arbitrary root — non-first bags were unreachable via any request shape, requests were denied when the arbitrary pick had no bag, and a wrong-member serve verified silently (the F3 guard recomputes the attestation over whatever is served). Fix: single-root publishes (the measured, dominant case) keep the full collapse; **multi-root** publishes additionally re-emit the pre-trim `<ual>/<tokenId>` pairing rows (`rootEntity`/`partOf`/`privateTripleCount`/`privateMerkleRoot`) in all four collapsed writers (`generateKCMetadata`, `restateKaPartition`, `restateLabelGraphForUpdate`, and the same-graph minimal-shape partition write in `dkg-publisher.ts` for parity). The handler is additionally hardened: a bare-UAL request on an already-written collapsed multi-root store now serves the first member root that actually HAS a bag instead of denying on an arbitrary pick. Readers tolerate the dual shape by construction — it is exactly the pre-trim aggregate+token layout they were already read-both over.

   **Correction (adversarial review, sync-verify):** the durable-sync Merkle verifier (`verifySyncedData`, duplicated in `dkg-agent-utils.ts` and `sync-verify-worker-impl.ts`) joined subjects to a KC exclusively via the legacy `partOf` token edge, so collapsed-shape KCs built an empty join and took the "no KA info — accept on trust" branch — the trim degraded the (responder-side already-inert, see #1055) verification path to never-verify for new-shape rows. Fixed read-both in both copies: `kaRootEntity` is a multi-map (the collapsed UAL subject holds ALL member roots; legacy token subjects carry one each), merkleRoot-bearing subjects that carry their own `rootEntity` rows self-map as their own KA (keying on `merkleRoot` guards against non-KA rootEntity carriers — lifecycle URNs, SWM op rows — minting bogus KCs), and per-KC root lists are deduped so dual-shape rows don't double-count a partition.
2. **Merge the lifecycle URN into the seal subject** (−5): one assertion = one node. Touches sync replication scope and history. **Deferred** — implementation audit surfaced (a) subject collision between subject-scoped lifecycle wipes and the author-signed seal/receipt rows, and (b) exact-subject kaId/reservedUal reads that risk identity double-allocation on upgraded stores. See `TODO(rfc-ka-trim)` at `assertionLifecycleUri` (packages/core/src/constants.ts) for the worked migration plan.
3. **PROV events behind `metadata.provenanceEvents` config** (−17 when off) — **implemented**: "lite mode" for high-throughput publishers / core nodes; default `true`; seal/state/identity rows always written; history API returns `events: []` for disabled ranges.
4. **Drop ShareTransition** (−5) — **implemented**: the node-ui on-chain-receipt hook now resolves straight off the seal-subject receipt rows in `_meta` (read-both: legacy two-hop ShareTransition fallback retained for old stores).

   **Correction (adversarial review, node-ui-receipt):** the hook's lifecycle join read a shape NO writer ever emitted — `?lc dkg:rootEntity ?asrt` expects the assertion URI as the `rootEntity` OBJECT, but lifecycle `dkg:rootEntity` rows stamp MEMBER entities (pre-trim writers were identical, so the join never bound on any store and the UAL/agent fields silently degraded). Fixed in `useEntityOnChainReceipt` (both `buildSealReceiptQuery` and the legacy `buildReceiptQuery`): the lifecycle URN is joined through its member-entity stamp on the CLICKED entity, pinned to the matched assertion by the structural (addr, name) correspondence — URN tail `:{addr}:{name}` ⟷ assertion-URI tail `/assertion/{addr}/{name}`, unambiguous because assertion names cannot contain `/` (`validateAssertionName`). The URN's `prov:wasAttributedTo` is surfaced as the agent fallback. The seal-subject `reservedUal`/`wasAttributedTo` OPTIONALs remain as forward-compat for the deferred P3.2 lifecycle merge (they bind nothing today).
5. **Partition copy → zero locally** (−7 beyond minimal shape): NOT taken. Instead the Phase-2 row landed: same-graph publishes write only the documented **minimal shape** into the per-cgId partition (collapsed entity pair + `batchId` + `merkleRoot` (+`privateMerkleRoot`) + `materializedVersion`); REMAP publishes keep the wholesale move (the partition is their only meta home). RS prover + backfill route are read-both.

**Quad budget:** 134 → ~99 (Phase 1) → ~75 (Phase 2) → **~45–50 (Phase 3), ~40 in lite mode**. No consensus (merkle/seal/status), resolution (rootEntity/contextGraph/kaId/reservedUal), access (accessPolicy/publisherPeerId/wasAttributedTo), sync (memoryLayer/assertionGraph/prov:generated), or trust (trustLevel) path is touched in any phase.

## Part 2 — query patterns (the other half of the saturation)

Trimming quads lowers the water level; these stop the daemon from boiling the ocean per tick. Inventory of unindexable hot-path patterns (all are full scans on any SPARQL engine — Blazegraph included):

| Pattern | Sites (non-exhaustive) | Runs |
|---|---|---|
| `FILTER(STRSTARTS(STR(?g), …))` graph-name surgery | gossip-publish-handler.ts:252 (per gossip message); dkg-agent-endorse.ts:799; profile-manager.ts:79; ccl-fact-resolution.ts:72; dkg-agent-cg-resolve.ts:430-432 | per message / per request |
| `STR(?g) = CONCAT(…)` boundary filters | sync/responder/sync-handler.ts:147-239 | per sync request served |
| `SELECT DISTINCT ?g` full enumeration | storage adapters (oxigraph.ts:268, blazegraph.ts:178, sparql-http.ts:387) | host-mode sweeps; cache exists but write-heavy sync invalidates it continuously |
| per-CG full sweeps | syncReconciler every 5 min → `canUseSharedMemoryForContextGraph` per known CG (dkg-agent-lifecycle.ts:2070, 2837); host-mode/VM/warm-core timers | every tick, cost grows with store |

### Proposal A — graph registry (one quad per graph kills every name scan)

At graph creation, write into one well-known graph (`did:dkg:registry`):

```
<graphUri> dkg:graphKind  "vm" | "swm" | "wm" | "meta" | "data" ;
           dkg:ofContextGraph <cgUri> .
```

Every "all VM graphs of CG X" becomes an indexed lookup + direct `GRAPH <g>` access. Precedent already in the codebase: `dkg:assertionGraph` is exactly this pointer for per-KA VM graphs and is already used by history and import — the migration is "use the pointer everywhere name-matching is used today." `SELECT DISTINCT ?g` enumeration is replaced by reading the registry. Registry writes are tiny, append-mostly, and deleted with their graph.

### Proposal B — event-driven reconcilers (dirty sets, not sweeps)

The 5-min reconcilers re-derive the world from the store every tick. Replace with dirty-set tracking: subscription/`_meta` writes enqueue the affected CG; ticks process the queue and a slow background full-verify pass (e.g. hourly) catches drift. Cost becomes O(changes), not O(store).

### Proposal C — keep per-KA graphs

The graph-per-KA design itself is sound (a named graph is just the 4th term of a quad; no per-graph cost). With A+B in place there is no reason to restructure the data layout.

## Compatibility

- All trimmed graphs are **node-local** (`_meta`, partition, SWM-meta) — no wire-format or consensus change. Cross-version interop: nodes that sync rows written by older versions still read them (drops are write-side); the `entity`/`rootEntity` dual-read shim covers the dedupe.
- The author **seal block is untouched in every phase** — it is the signed mint authorization (`parseAssertionSealQuads` → mint args, dkg-agent-publish.ts:2850).
- Bug fixed in passing: `dkg:publisherPeerId` stores the literal `"unknown"` on the KC row (real peer id only lands in the SWM snapshot row).

## Verification approach

Per-predicate reader audit (multi-agent, grep both URI forms over all packages) + live-store census cross-check (e.g. `rdf:type` counts: `AssertionPublished` = 0 confirmed the dead writer). The PR includes: writer-side removals, the named reader migrations, updated test fixtures, and a regression grep proving no dropped predicate retains a reader.

## Invariant exception

The PR-wide invariant is "every migrated reader reads both old+new shapes; no write removal may strand a reader". One write removal is **sanctioned despite having had a live reader at removal time**: the P3.1 collapse stops minting `dkg:partOf` (the `<ual>/<n> dkg:partOf <ual>` token edge) for single-root publishes (multi-root publishes re-emit it — see the multi-root-access correction in Phase 3). The kafka-plugin discovery queries still joined it when the writer was dropped — caught by the adversarial review (F1) and fixed by making all three discovery queries read-both (legacy `partOf` join UNION collapsed UAL-subject match), like every other migrated `partOf` reader. The removal stands because (a) all known readers are now read-both over both shapes (old-shape rows persist in pre-upgrade stores and replica-synced rows), and (b) the related `dkg:publishedAt` KC-row write — F1's other half — was restored outright rather than excepted (it is a KEEP, see the Phase-1 correction). No other write removal with a surviving reader is sanctioned.
