# rc.17 — Chorus 3-layer equivalence: implementation & devnet-test plan

> Status: **planning + safe foundation started.** D6 (advisory ownership) is implemented on this
> branch (`rc17a-chorus-foundation`, sender-side, pending CI). Everything else below is spec'd
> for execution. This is a **multi-PR effort gated on #1041 landing on `main`**; it cannot be one
> commit. Consensus is invariant throughout — the merkle leaf is `(s,p,o)` only and the seal
> commits content+author, never the name or graph IRI (`packages/publisher/src/merkle.ts:9,57`;
> `packages/core/src/assertion-seal.ts:10-15`), so nothing here is chain-gated.

## The two sub-trains (cut at the layout boundary)

- **rc.17a** — substrate + identity + atomic + exclusivity. **Keeps the old graph layout** → each item independently shippable & revertable.
- **rc.17b** — uniform naming + query model + SWM per-KA + migration. **One coherent unit behind a `chorusLayout` feature flag + dual-read window** (mutually dependent: read-flip ↔ write re-home ↔ enumerator re-point).

## Hard requirements (non-negotiable)

1. **`chorusLayout` feature flag + dual-read window** gates the entire rc.17b train. The cutover flips physical graph IRIs; without dual-read it is irreversible mid-flight. Safe because old/new layouts can't diverge a merkle root.
2. **D1 re-allocation guard** — moving `allocate()` to create destroys the `hasExistingKaId` dedup signal (`dkg-agent-publish.ts:1801-1802`). Port an explicit "already-reserved?" check to create-time (keyed on the `reservedUal`/`kaId` carry-over in `A2_PRESERVE_PREDS`, `dkg-publisher.ts` create path) BEFORE allocating, or a draft re-open double-allocates and breaks the stable-UAL invariant.
3. **Sealed-quad invariance** — D1 may change identity labels and *where* triples live, but MUST NOT alter the reserved-subject-filtered, `skolemizeByEntity` input quad set the seal hashes (`assertion-seal.ts:47-58`). Byte-identical sealed quad set ⇒ identical root.
4. **CI grep-guard** for `'/assertion/'` and `'/_shared_memory'` string literals before flipping the URI builders — ~15 parsers fail OPEN (empty/wrong, not loud).

---

## Wave 1 — route anchor (existing plan, unchanged)
- Unblock **#1041** (fix the 2 Kosava jobs: `adapters+epcis+graph-viz+mcp-server+network-sim`, `node-ui`) → merge `feat/ka-routes-main` → `main`; close **#1039** (integration twin); rebase+land **#1042** (base must move to `main`).
- **D6** rides here (this branch): drop the `workspaceOwner` first-writer-wins **throw**, keep advisory.
  - ✅ **Sender** (`dkg-publisher.ts` ~4481): throw → warn+skip (done on this branch).
  - ☐ **Receiver** (`workspace-handler.ts` ~995-1014 validate/ownership gate, ~1018-1033 CAS): demote the reject to the same advisory warn+skip; keep the `workspaceOwner` quad write (~1104).
  - **Tests:** `shared-memory-publish-boundary.test.ts`, `workspace.test.ts` — flip the "throws on foreign co-claim" assertions to "skips & warns"; keep the `workspaceOwner` quad assertions.

## Wave 2 — rc.17a (substrate + identity; OLD layout preserved)

### SUBSTRATE-1 — `dkg:entity` on the lifecycle URN  *(M)*
- `metadata.ts` `generateAssertionCreatedMetadata` (~1313-1345): also emit `mq(subject /*URN*/, ${DKG}entity, <member-entity>, metaGraph)` per member entity (today entity rows hang off per-root label rows + the event subject via `entityMemberQuads`, ~204/227/856 — **not** the URN). Dual-write alongside the existing `dkg:rootEntity` per OT-RFC-43 §10.1.
- **Not** a prerequisite of the read-flip (corrected): the read-flip enumerates by `contextGraph`/`memoryLayer`/`assertionGraph`/`wasAttributedTo`, all already on the URN at create. SUBSTRATE-1 is for **entity-membership** queries + the SWM backfill CONSTRUCT.
- **Tests:** new `_meta`-membership unit test asserting the created-row carries `dkg:entity` on the URN.

### SUBSTRATE-2 — re-stamp `dkg:assertionGraph` on promote + publish  *(M)*  ← the read-flip's true hard gate
- Today `dkg:assertionGraph` is stamped **once at create** (`metadata.ts:1328`, → the WM graph) and never re-stamped: `generateAssertionPromotedMetadata` (1365-1403) flips only state+memoryLayer; `generateAssertionPublishedMetadata` (1420-1451) flips to VM + `vmCurrentAssertion` but no `assertionGraph`.
- **Promote:** in `generateAssertionPromotedMetadata`, `delete` the old `assertionGraph` (WM) quad and `insert` the layer-correct SWM graph (`contextGraphSharedMemoryUri(cg, sub)` in rc.17a; the per-KA SWM URI in rc.17b).
- **Publish:** in `generateAssertionPublishedMetadata`, same — `insert` the VM graph. **Caveat:** the VM graph is `_verifiable_memory/{vmId}` and `vmId` is **not** in `AssertionPublishedMeta` (it's a separate on-chain counter, `dkg-agent-endorse.ts:644`). Thread the VM graph URI (or `vmId`) into `AssertionPublishedMeta`, computed at the endorse call site.
- Backfill the **missing VM `assertionGraph` pointer** for existing VM KAs (one-shot migration step).
- **Tests:** lifecycle unit test asserting `assertionGraph` re-points WM→SWM→VM across promote/publish; the explicit seam regression — promote that flips `memoryLayer` MUST also re-stamp `assertionGraph` (the #1 silent-bug surface).

### SUBSTRATE-3 — index-driven discovery read (kill `listGraphs`)  *(L)*  — `dependsOn: SUBSTRATE-2`
- Replace `discoverGraphsByPrefix`/`listGraphs` scan (`dkg-query-engine.ts:517,576`) and the `graphPrefixes` prefix-FILTER routing (`:82` WM, `:158` VM) with a bounded `_meta` query (bind `dkg:contextGraph`,`dkg:memoryLayer`,`prov:wasAttributedTo`,`dkg:subGraphName`; follow `dkg:assertionGraph`) returning the EXACT graph list, fed into the existing `wrapWithGraph` bound path (`:439/:448`).
- Retire the other two `listGraphs` scans: `dkg-publisher.ts:3432/3666`, `dkg-agent-cg-registry.ts:904`.
- **Keep the per-agent ACL constraint** (`constrainGraphVariablesToAllowedSet`, `:1050`, invoked `:291/:397`): the `_meta` discovery query MUST include the `wasAttributedTo` constraint, else other agents' WM leaks into the bound set.
- **Tests:** `_meta`-index discovery unit tests (returns exact graph list, no `listGraphs` call — spy it to assert 0 calls); ACL test (agent B can't enumerate agent A's WM graphs).

### D1 — identity-at-create (one UAL)  *(M)*  — `dependsOn: SUBSTRATE-1` (parallel to substrate)
- Move `kaNumberAllocator.allocate(author)` + the per-author reconcile gate from finalize (`dkg-agent-publish.ts:1808-1830`) to `assertionCreate` (`dkg-publisher.ts:4068`, which already carries `kaId`/`reservedUal` via `A2_PRESERVE_PREDS`).
- Collapse the seal-subject (`assertionUri`, `dkg-agent-publish.ts:2550-2554`) and the lifecycle-subject onto the **one UAL**; demote `{addr}/{name}` + the lifecycle URN from identities; keep `assertionName` as a `dkg:assertionName` label only.
- **HARD AC:** port the re-allocation guard (req. #2). **HARD AC:** sealed-quad invariance (req. #3).
- **Tests:** "create mints a stable reservedUal"; "draft re-open does NOT re-allocate" (the guard); "sealed quad set byte-identical before/after D1" (merkle invariance).

### D2 — atomic create+finalize  *(M)*  — `dependsOn: D1`
- Add one create-and-seal orchestration method (create→write→finalize reusing the seal/merkle compute, `dkg-agent-publish.ts:1480-1510`) + one route. Add the `>10MB` body-cap constant to gate normal create-and-seal vs the existing chunked path (`knowledge-assets-import.ts:836,1373`, left unchanged).
- **Tests:** "one-shot create-and-seal yields a sealed KA + UAL"; "oversized payload routes to the chunked path."

### Land in Wave 2 once SUBSTRATE-3 is green
- Independent mergeables **#1021 #1029 #1032 #1033 #1034 #1038**; **#1037** (now reading the index — **and add it to the D3b parser checklist**, req: it introduces NEW `/assertion/`-shape `assertionName`→WM routing); rebase **#1020**.

## Wave 3 — rc.17b (uniform naming + query model + SWM per-KA; ONE flagged unit)

### D3a — flip the 3 URI builders  *(L)*
`constants.ts`: → `did:dkg:context-graph:{cg}[/{sub}]/{_layer}/{addr}/{number}`, `{_layer} ∈ _working_memory|_shared_memory|_verifiable_memory`.
- `contextGraphAssertionUri` (WM, 235-238): `assertion/{addr}/{name}` → `_working_memory/{addr}/{number}`.
- `contextGraphVerifiableMemoryUri` (VM, 227-229): `_verifiable_memory/{vmId}` → `_verifiable_memory/{addr}/{number}` + **gain `subGraphName` arg**.
- `contextGraphSharedMemoryUri` (SWM, 217-220): bucket → `_shared_memory/{addr}/{number}`.
- Thread `{addr,number}` through `graph-manager.ts` (38-56) facade + **~25 direct callers** (publisher/query/agent/import/memory).

### D3b — replace ~15 hardcoded `/assertion/`-shape parsers  *(M)*
`dkg-agent.ts:1936` regex; node-ui `sub-graph-uri.ts:40-46`, `useMemoryEntities.ts:243/291`; `sync-handler.ts:290/389` boundary filters; `openclaw.ts:1204/1226`; `shared-assertion-helpers.ts:286-291`; `dkg-agent-cg-registry.ts:903`; node-ui e2e helpers; **+ #1037's `assertionName`→WM resolver (16th site)**. Switch each to an `_meta`-index read or a layer-token-agnostic parse.

### D3c — SWM per-KA conversion (the single sync-breaking seam)  *(L)*  — `dependsOn: D3a, SUBSTRATE-3`
Re-point the SWM responder enumeration (`sync-handler.ts:131-194` + `registeredSubGraphSwmFilter` 141-161) and the boot re-arm `reconstructSharedMemoryOwnership` (`dkg-publisher.ts:3424-3450`) from bucket-URI-suffix shape (`/_shared_memory`) to the `_meta` index (`memoryLayer=SWM` + `assertionGraph`), extending the lifecycle-driven path at `sync-handler.ts:392`.

### D4 — query model (land WITH D3a/D3b)  *(L)*  — `dependsOn: SUBSTRATE-3, D3a`
CG content reads use `VALUES ?g {…} GRAPH ?g {}` (the existing `wrapWithGraph` bound path) sourced from the SUBSTRATE-3 index — **never a prefix-FILTER**. Replace the textual N-way `wrapWithGraphUnion` fan-out (`:452`) with the variable-graph+`VALUES` pattern. Denormalize hot aggregates into `_meta`; wire the per-subgraph Canon escape (§16.10/§17.6) for the analytics/traversal-heavy subgraph. (See `docs/rfcs/OT-RFC-46` query-model section.)

### D3d — off-chain data migration (consensus-safe)  *(L)*  — `dependsOn: D1, SUBSTRATE-3, D3a`
WM `…/assertion/{addr}/{name}` → `…/_working_memory/{addr}/{number}` (needs `name→number` from D1); VM `…/_verifiable_memory/{vmId}` → `…/_verifiable_memory/{addr}/{number}` (**`vmId` is a separate on-chain counter — non-trivial remap + `assertionGraph` backfill; highest-stakes row**); SWM bucket-split into N per-KA graphs keyed by owning KA. **Dual-read window** during cutover (req. #1).

## Wave 4 — rc.18 (unchanged)
Option-1 contracts **#975 #1019** (DRAFT, chain-gated); the per-subgraph Canon bucket for the traversal-heavy subgraph (§17.6) if needed.

---

## Devnet / test changes (the "update devnet tests in detail" ask)

Per the regression item (~63–120 test files reference old URI shapes / allocator-at-finalize):

| Area | Change |
|---|---|
| **Unit — URI shape** | every `toEqual([contextGraphSharedMemoryUri(CG)])`-style assertion (e.g. `get-views.test.ts:39-44`) → the new `{_layer}/{addr}/{number}` shape; `swm-subset-cleanup.test.ts`, `workspace.test.ts`, `shared-memory-publish-boundary.test.ts`. |
| **Unit — allocator** | move the "allocate at finalize" expectation to "allocate at create"; add the **re-allocation guard** test (draft re-open ≠ double-allocate). |
| **Unit — substrate** | new: `dkg:entity` on the URN (S-1); `assertionGraph` re-stamp WM→SWM→VM (S-2); `_meta`-index discovery returns exact list with **0 `listGraphs` calls** (S-3, spy); ACL leak test. |
| **Unit — query model** | bound `VALUES ?g {…}` content read; whole-CG aggregate over N graphs returns correct (and the prefix-FILTER path is gone). |
| **Devnet (`./scripts/devnet.sh`) — multi-node** | (1) **SWM per-KA sync round-trip**: peer A shares a KA, peer B (late-joiner) receives exactly that KA's per-KA graph via the `_meta`-index responder (the fail-silent seam — assert the received set, not just "no error"). (2) **WM→SWM→VM lifecycle** over the new uniform graph names, asserting `assertionGraph` re-points each hop. (3) **overlap**: two peers assert differing facts about one entity-as-subject in SWM → both coexist (D6 + per-KA), attributed. (4) **migration idempotency**: run the dual-read backfill twice → identical end state; assert **merkle roots unchanged** pre/post migration (consensus invariance). (5) **#184**: `{view, subGraphName}` returns the subgraph's KAs (via #1037 + the index). |
| **CI guard** | grep-fail on new `'/assertion/'` / `'/_shared_memory'` string literals (req. #4). |

> These devnet tests must be written **alongside** their implementation wave (they assert behavior that
> doesn't exist until the layout flips), and run under the real `pnpm`/`turbo`/`devnet.sh` harness — not
> in this throwaway clone.
