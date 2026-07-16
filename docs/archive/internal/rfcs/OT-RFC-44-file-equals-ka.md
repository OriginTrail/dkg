# OT-RFC-44: File = Knowledge Asset — decouple entity count from KA count (Design B) and unblock multi-entity publish

| Field | Value |
|-------|-------|
| **RFC** | OT-RFC-44 |
| **Title** | File = Knowledge Asset — decouple entity count from KA count (Design B) and unblock multi-entity publish |
| **Status** | Draft (for discussion) |
| **Created** | 2026-06-03 |
| **Track** | Protocol Core (publish pipeline, cross-node ACK, random-sampling proofs) |
| **Packages** | `publisher`, `agent`, `core` |
| **Chain change** | **None.** Off-chain + data-model only; the greenfield contract already mints exactly one KA per `createKnowledgeAsset`. |
| **Parent** | [OT-RFC-43 — Deterministic KA identity & the SWM→VM publish model](OT-RFC-43-deterministic-ka-identity.md) (§2.1, §3, §10.1, §10.2, §10.4, §11) |
| **Related** | [OT-RFC-45 — Update authority is owner-only](OT-RFC-45-update-authority-owner-only.md), [03_PROTOCOL_CORE.md](../03_PROTOCOL_CORE.md), [06_PUBLICATION_PIPELINE.md](../06_PUBLICATION_PIPELINE.md) |

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

> **Why this is its own RFC.** This is the urgent, user-facing bug fix carved out of [OT-RFC-43](OT-RFC-43-deterministic-ka-identity.md) so it can ship **without waiting on the identity model, the contract change, or the HTTP API redesign**. It carries **no chain risk** and is the consensus/data-model floor for v10.0 (RFC-43 §11.0). The deterministic-UAL platform work (RFC-43 Option 1) and the contract-doc correction ([RFC-45](OT-RFC-45-update-authority-owner-only.md)) are independent and tracked separately.

---

## 1. Problem

The V10 publish pipeline **hard-rejects any file containing more than one RDF entity.** A logical file with N entities cannot be published as one Knowledge Asset (KA): it is either blocked outright or split into N single-entity KAs (N transactions, N UALs, N owners) — both of which contradict the "a KA is a file" model that users (and the contract) already hold.

The user-facing symptom is the node-UI error **"V10 publish requires exactly one root entity per request."** *(Verified present in `packages/node-ui/src/ui/api.ts`, `.../views/project/components/layer-widgets.tsx`, and `.../views/MemoryLayerView.tsx` on `main`@`1ae3ffd7`.)*

The root cause is a **conflation of entity count with KA count**:

- `autoPartition` ([packages/publisher/src/auto-partition.ts](https://github.com/OriginTrail/dkg/blob/main/packages/publisher/src/auto-partition.ts)) skolemizes blank nodes under their parent entity and returns a `Map<entity, Quad[]>` — *an index by entity*, not a partition into KAs. *(Verified: return type `Map<string, Quad[]>`.)*
- Every consumer reads `kaMap.size` as "the number of KAs" instead of "the number of entities in this one KA's entity list."
- The greenfield publisher then enforces that misreading with a guard that throws when `kaCount !== 1` ([packages/publisher/src/dkg-publisher.ts](https://github.com/OriginTrail/dkg/blob/main/packages/publisher/src/dkg-publisher.ts) ~1773): *"V10 greenfield publish requires exactly one Knowledge Asset per transaction (got N)."* `kaCount` is computed as `manifestEntries.length`. *(Verified line ~1773.)*

Meanwhile the on-chain greenfield contract **already mints exactly one KA per `createKnowledgeAsset` call** (`knowledgeAssetsAmount != 1` reverts; `_safeMint(author, kaId)` — verified [DKGKnowledgeAssets.sol](https://github.com/OriginTrail/dkg/blob/main/packages/evm-module/contracts/storage/DKGKnowledgeAssets.sol) ~190–220). **The chain wants one KA per tx; only the off-chain pipeline fights it.**

## 2. The fix: Design B — one file/lifecycle = one KA, any entity count

Two candidate implementations were considered (RFC-43 §3.0):

- **Design A — collapse to one synthetic "anchor" entity.** *Rejected — consensus-breaking.* Three code paths scope an assertion's triples by its entity set (`?s = <entity> OR STRSTARTS(?s, "<entity>/.well-known/genid/")`): publish-time `validation.ts` Rules 2/3, the SWM gather in `workspace-resolution.ts`, and random-sampling proof reconstruction in `ka-extractor.ts`. Replacing the real entities with one anchor makes every real subject fall **outside** those filters → publish validation rejects the data, the SWM gather returns nothing, and **the RS prover reconstructs an empty leaf set and every proof fails** (leaf-count mismatch).
- **Design B — decouple entity count from KA count.** *Adopted.* Keep the N real entities as **first-class member entities** of the one KA. The Merkle root is already computed flat over the whole skolemized set (`computeFlatKCRoot`), so the version hash is unchanged. **Only the count/identity bookkeeping moves: N → 1.** No synthetic anchor; the Merkle / gather / proof machinery is untouched.

> **Design B in one sentence:** one file/lifecycle maps to one KA whose member entities are all the entities in the current assertion, with the Merkle root computed exactly as today; only the "how many KAs per file" decision changes (N → 1).

`autoPartition` itself is **unchanged** under Design B — the skolemization is load-bearing for consensus and the grouping is just an index. The bug is in the *callers*, not the function.

## 3. Sites that conflate entity-count with KA-count (must change together)

None of these touch Merkle leaf computation; they are all count/identity bookkeeping. They MUST change in lockstep, because the receiving side asserts equality the sending side will now violate.

| Site | Today's assumption | Change |
|------|--------------------|--------|
| `dkg-publisher.ts` publish guard (~1773) | `kaCount !== 1` throws (`kaCount = manifestEntries.length`) | one **assertion** per publish; `kaCount = 1` with any number of entities |
| `validation.ts` Rules 2/3 | each entity is its own manifest entry / own KA | entities are members of one KA; rule validates "subject ∈ assertion's entity set or skolem child" — same check, one manifest entry |
| `storage-ack-handler.ts` (~804) | `intent.kaCount > 0 && rootSubjects.size !== intent.kaCount` → receiver **refuses to ACK** | decouple: `kaCount = 1`; entity count is independent and not asserted equal to it |
| `ka-extractor.ts` (RS proof) | loops entities, each its own KA under the UAL | unchanged loop, but all entities resolve under **one** `kaId`/UAL |
| `metadata.ts` `generateKCMetadata` (~153) | emits one KA node **per entity** | emits one KA node; entities are its `dkg:entity` members |

> **The receiver guard is the dangerous one.** `storage-ack-handler.ts` asserts `rootSubjects.size === intent.kaCount`. Today the publisher's `kaCount !== 1` guard means this has *only ever run with one subject and `kaCount = 1`*. Under Design B the receiver sees **N subjects with `kaCount = 1`**, so `N === 1` fails and **the receiver refuses to ACK** — the publisher gets a confirmed chain tx and zero peer ACKs. This is invisible to single-node tests (see §6). *(Verified: the real condition is `intent.kaCount > 0 && rootSubjects.size !== intent.kaCount` at line ~804.)*

## 4. Companion renames (chain-irrelevant, ship in the same window)

Three names in the lifecycle vocabulary actively mislead readers (and LLMs writing patches) into re-entrenching the bug. They are **not** required for the count fix, but they are cheap, chain-irrelevant, and remove the trap, so they SHOULD ship in the same release window via dual-read/dual-write migrations.

- **`dkg:rootEntity` / `dkg:assertionRootEntity` → `dkg:entity` / `dkg:assertionEntity`.** These predicates hold **graph entities, not Merkle roots** — the "root" in the name is a misnomer that produces "isn't `kaCount` the root count?" patches. *(Verified: values are entity IRIs, e.g. emitted as `<${root}>` in [assertion-seal.ts](https://github.com/OriginTrail/dkg/blob/main/packages/core/src/assertion-seal.ts) ~138 and [metadata.ts](https://github.com/OriginTrail/dkg/blob/main/packages/publisher/src/metadata.ts) ~157.)* Dual-read/dual-write per RFC-43 §10.1. **Consensus caution:** `ka-extractor.ts` feeds Merkle proof reconstruction; the dual-read MUST land on every node *before* any node writes only the new name, or a lagging verifier reconstructs an empty leaf set and proofs fail.
- **`autoPartition` → `skolemizeByEntity`.** It does not partition into KAs; it skolemizes and indexes by entity. Pure off-chain refactor, no on-disk artefact, so the old name can be dropped as soon as all call sites compile against the new one (no fleet-ordering constraint). RFC-43 §10.4.

> **Why rename now and not later:** the misnomers are *the* reason fresh readers keep concluding "kill `autoPartition`" or "isn't the root the KA count?" and writing patches that break proof reconstruction. Fixing the count bug while leaving the trap-names in place invites a regression.

## 5. Backwards compatibility

The change is **forward-only**; nothing already on chain is rewritten.

- **Existing per-entity KAs stay valid and immutable.** Already-minted single-entity KAs keep their ids, owners, and proofs. The file=KA model applies to **new publishes only**; we do not (and cannot, without owner consent) collapse historical KAs.
- **Mixed graphs resolve fine.** A CG can hold both old per-entity KAs and new file KAs simultaneously; RS samples both by index into the per-CG list (`getContextGraphKCAt`), resolution works for both, and the entity-scoping filter is identical.
- **Re-publish, don't migrate.** A user who wants an old multi-KA file consolidated re-finalizes and publishes a fresh file KA (new id, new lineage) — an explicit action, not an automatic rewrite.
- **The publish-guard flip is the only hard switch.** Softening `kaCount !== 1` changes behaviour for new publishes; it has no effect on existing KAs.

## 6. Test plan — the cross-node tests are the ones that matter

Single-node tests pass even when the model is wrong; every dangerous failure here is multi-node / consensus shaped. Mandatory coverage:

- **Cross-node Storage ACK (the sneaky one).** A publisher node publishes a file KA with N entities (N>1); a *separate* receiving node MUST ACK it. Assert ACK **succeeds** with `kaCount = 1` and `entities = N`. *This cannot be caught on one node* — today a multi-entity publish never reaches a receiver because the publisher's guard blocks it first, so the receiver's `rootSubjects.size === intent.kaCount` check has never run with `N > 1`.
- **RS proof on a multi-entity file KA.** A challenger samples a published file KA and reconstructs the Merkle proof on a *different* node via `ka-extractor.ts`. Assert the leaf set = all N entities' triples (+ skolem children) and the proof verifies. Run on a CG that **also** contains legacy per-entity KAs to prove mixed graphs sample correctly.
- **Dual-read predicate window.** Write `_meta` with only legacy `dkg:rootEntity`; run validation + gather + RS on a node that emits only `dkg:entity`; assert all three still resolve the entity list (`UNION` read). Then the reverse. Guards the §4 ordering constraint.
- **Share → publish boundary survives flattening.** Share (WM→SWM) a multi-entity assertion; confirm the entity set is recoverable from the seal + `ShareTransition` records; publish and confirm exactly one KA with all entities.
- **Mixed-fleet sync.** A node on new code and a node on old code in the same CG: assert neither corrupts the other's view.

## 7. Rollout

| Phase | Scope | Chain change? | Gate |
|-------|-------|---------------|------|
| **0 — Predicate rename** | `dkg:rootEntity`/`dkg:assertionRootEntity` → `dkg:entity`/`dkg:assertionEntity`, dual-read/write fleet-wide | No | All nodes on dual-read; RS proofs pass on a mixed-data CG |
| **1 — Design B** | §3 guard/identity changes + function rename `autoPartition`→`skolemizeByEntity`; supersede PR #925 | No | New publish mints 1 KA / N entities; cross-node ACK + RS proof pass; no internal caller imports `autoPartition` |

Both phases are the user-facing fix and carry **no chain risk**, so they should not be gated behind any of the identity/contract/API work in RFC-43.

## 8. Open questions

1. Drop-the-dual-read timing for the predicate rename: how long to keep the `UNION`, and eager backfill vs lazy dual-read only?
2. Confirm `skolemizeByEntity` as the target name (alternatives: `skolemizeAndIndexByEntity`, `groupByEntity`) and the deprecation grace period for external test/script consumers.
3. Resolution semantics: entities become member entities of one KA and are no longer independently minted/dereferenceable as their own KAs (they remain addressable graph subjects) — acceptable? (RFC-43 Open #5.)
4. Governance sign-off to supersede PR #925 and soften the `kaCount !== 1` posture.

> **Relationship to the clean HTTP API.** RFC-43 §10.5 proposes a GitHub-shaped resource model that is identity-agnostic and can ship in the same Phase 1 window as this RFC (RFC-43 §10.5.7, §11.0). It is kept in RFC-43 rather than duplicated here so this RFC stays scoped to the consensus/data-model fix.
