# Upgrading from `v10.0.0-rc.11` to `v10.0.0-rc.13`

**Audience:** builders and operators who were running `v10.0.0-rc.11` and skipped rc.12. This is the consolidated guide for jumping straight to **rc.13**.

**The one thing you must internalise:** rc.13 is an off-chain stabilization release with **no contract changes since rc.12** — but the jump from **rc.11 → rc.12 was a hard, forward-only breaking change**: the move to the **simplified single Knowledge Asset model** (replacing the old multi-asset "Knowledge Collection" batch), plus a testnet redeploy. If you are on rc.11, you inherit **all** of that in one hop. There are no shims and no fallback resolvers. Your node will not boot against rc.13 contracts, and your integration code will not compile or publish, until you do the work below.

This is not a cosmetic terminology change. It came directly out of feedback from the red-team builders integrating against the DKG, and it buys two concrete things: a **better build-time UX** (one asset per publish, one stable identifier that survives updates — no more "collection vs asset" mental overhead) and a **performance win** (lower on-chain cost and less operational complexity per publish). The work on your side happens to be largely mechanical, but the change itself is a model improvement, not a search-and-replace for its own sake.

> If you have already migrated to rc.12, the rc.12 → rc.13 delta is small and additive — skip to [§7 rc.13 deltas](#7-whats-new-in-rc13-on-top-of-rc12). Everything in §2–§6 is the rc.11→rc.12 work you still owe.

The good news: ~95% of the integration-side churn is a mechanical search-and-replace, and the whole thing is well-bounded. The fastest path is to hand this document to your coding agent and let it drive — see the next section.

---

## 0. Use this guide as an agent prompt

Most of you build with an AI agent (Cursor, Claude Code, Codex CLI, or any `AGENTS.md`-honouring tool). Don't hand-migrate. Point the agent at this doc and your repo. There are **two** prompts below because there are two separable jobs: **(A) upgrade the node/runtime** and **(B) migrate your integration logic** (the old Knowledge Collection model → the new Knowledge Asset model). Run A first if you operate a node; run B for any code that talks to the DKG.

### Prompt A — upgrade the node / runtime (operators)

```
You are upgrading a DKG node from @origintrail-official/dkg v10.0.0-rc.11 to
v10.0.0-rc.13. Read docs/UPGRADE_RC11_TO_RC13.md from the dkg repo
(https://github.com/OriginTrail/dkg/blob/main/docs/UPGRADE_RC11_TO_RC13.md)
end to end before doing anything.

Then:
1. Confirm whether this is an Edge node or a Core node (check nodeRole in
   ~/.dkg/config.json). Edge nodes update via npm; Core nodes via the git-build
   path. Do NOT git pull on an npm-managed node.
2. Stop the daemon.
3. Bump @origintrail-official/dkg to 10.0.0-rc.13 (npm: `npm install -g
   @origintrail-official/dkg@10.0.0-rc.13`).
4. Because we are crossing the rc.12 chainResetMarker (v10-rc12-ka-rename),
   first boot wipes per-node chain-derived state and re-derives it against the
   redeployed Base Sepolia contracts. This is expected — do NOT treat the
   re-sync as data loss. Staked positions (conviction NFTs) are preserved.
5. Start the daemon, then run `dkg doctor` and confirm it is green and
   /api/build-info reports 10.0.0-rc.13.
6. Confirm rs.tick.data-corrupted is zero on the updated-KA cohort (Core nodes).

Report the before/after version, the doctor output, and anything that looks off.
```

### Prompt B — migrate your integration logic (builders)

```
You are upgrading a DKG integration from @origintrail-official/dkg v10.0.0-rc.11
to v10.0.0-rc.13. Read docs/UPGRADE_RC11_TO_RC13.md from the dkg repo
(https://github.com/OriginTrail/dkg/blob/main/docs/UPGRADE_RC11_TO_RC13.md) end
to end before changing any code. The headline change is conceptual, not just a
rename: the old "Knowledge Collection" (an ERC-1155 batch of many assets per
publish) is GONE. The new unit is a single "Knowledge Asset" — exactly one
ERC-721 per publish, with a stable UAL and owner-sealed updates. Treat every
place your code assumed "a collection of N assets" as now meaning "one asset".

Do this in order:
1. Bump every @origintrail-official/dkg* dependency in every package.json in this
   workspace to ^10.0.0-rc.13.
2. Apply the mechanical TypeScript renames in §3 (Knowledge Collection ->
   Knowledge Asset). Use a workspace-wide case-sensitive search-and-replace
   (the regex sweep is in §3.3), then run tsc to find the residual call sites.
3. Migrate publish/update logic to the greenfield KA model in §4: one KA per
   publish; kaId == the ERC-721 tokenId; UAL is
   did:dkg:{chainId}/{DKGKnowledgeAssetsAddress}/{kaId} and is STABLE across
   updates; every update needs a fresh precomputedUpdateAttestation signed by the
   CURRENT ERC-721 owner. Remove any kcSize / batch-of-N assumptions.
4. Enforce the economic floor in §5: every tokenAmount you send must be >= 1.
   Zero-cost / "free publish on a dust CG" flows now revert.
5. If you call the Solidity surface directly (ethers/viem/subgraph), re-fetch
   ABIs from packages/chain/abi/ at rc.13 — every renamed function has a new
   4-byte selector and old calldata reverts (§3.4).
6. Update any SPARQL that reads publish receipts: publishedAtKcId ->
   publishedAtKaId (§3.5).
7. Review the rc.13 behavioural deltas in §7 — in particular, publishes that
   don't specify a lifetime now default to 12 epochs.
8. Run the integration's full test suite against a freshly-upgraded daemon or
   local devnet. For each failure, find the matching row in the §3 rename tables
   before debugging — most breakage is rename-induced.

When done, summarise every change and flag any site where the right migration
was ambiguous (especially anywhere the old code assumed multiple assets per
publish).
```

---

## 1. Why this is breaking even though rc.13 "changed no contracts"

rc.13's own changelog says, correctly, *"No Solidity changes since rc.12 … no contract redeploy is required. Nodes upgrade in place; no local-state wipe."* That sentence is written **relative to rc.12**. Coming from **rc.11**, you cross the rc.12 cutover on the way through:

- The Base Sepolia (chainId 84532) contract surface was fully redeployed at rc.12. The `chainResetMarker` is `v10-rc12-ka-rename-2026-06-01`. Your first boot on rc.13 crosses that marker and **wipes per-node chain-derived state** to re-derive it against the new contracts. (Stakes/identities are preserved — see §6.)
- The on-chain and off-chain API was renamed (`KnowledgeCollection*` → `KnowledgeAsset*`) with **no compatibility layer**.
- The KA lifecycle model changed shape (ERC-1155 batch → single ERC-721).
- A `tokenAmount >= 1` economic floor was added; zero-cost publishes revert.

So: treat this as "do the entire rc.12 migration, then pick up the rc.13 niceties." This guide folds both into one pass.

---

## 2. TL;DR breaking-change matrix (rc.11 → rc.13)

| # | Area | Change | Affects | Source RC |
|---|------|--------|---------|-----------|
| 1 | Model + API | Simplified single **Knowledge Asset** model replaces the old multi-asset "Knowledge Collection"; type/method/property names and the API surface change to match, on-chain and off-chain | Everyone: TS, Solidity, ABIs, predicate URIs, daemon API | rc.12 |
| 2 | KA model | Greenfield: exactly **one** ERC-721 KA per publish; stable UAL; owner-sealed updates via `precomputedUpdateAttestation` | Publishers, updaters | rc.12 |
| 3 | Solidity ABI | New 4-byte selectors on every renamed function; old calldata reverts | Direct chain consumers (scripts, dApps, subgraphs) | rc.12 |
| 4 | Hub resolution | Legacy `KnowledgeAssetsV10` fallback resolver removed; adapter raises if V10.1 surface isn't registered | Operators on older Hub deploys | rc.12 |
| 5 | Economic | Strict-positive `tokenAmount >= 1` floor; zero-cost publishes revert | Any caller sending `tokenAmount: 0` | rc.12 |
| 6 | Economic | Protocol treasury fee skim (default 300 bps = 3%, dormant until governance enables) | Stakers (net reward); publishers pay gross | rc.12 |
| 7 | Profile | `Profile.recreateProfile` drops `initialOperatorFee` arg | Operator recovery scripts | rc.12 |
| 8 | Chain | Base Sepolia full contract redeploy; first-boot state wipe | Operators; chain readers caching addresses | rc.12 |
| 9 | Behaviour | Default publish lifetime is now **12 epochs** when none is specified | Publishers not setting an explicit lifetime | **rc.13** |
| 10 | Sync | Core-preferred sync + chain-driven verified-memory reconciliation | Operators (re-sync behaviour) | **rc.13** |

Rows 1–8 are the rc.12 work. Rows 9–10 are the rc.13 deltas. The rest of this doc is the concrete migration.

---

## 3. API surface migration (mechanical, ~95% of builder churn)

The model change in §1 surfaces in your code as updated type, method, and property names. This part is genuinely mechanical: a workspace-wide case-sensitive search-and-replace, then let `tsc` find the rest. (The *why* behind the change is in §1 and §4 — this section is just the code-level sweep.)

### 3.1 Identifier rename table

| rc.11 | rc.13 | Where |
|-------|-------|-------|
| `ChainAdapter.createKnowledgeAssetsV10` | `ChainAdapter.createKnowledgeAssets` | `@origintrail-official/dkg-chain` |
| `ChainAdapter.getKnowledgeAssetsV10Address` | `ChainAdapter.getKnowledgeAssetsLifecycleAddress` | `@origintrail-official/dkg-chain` |
| `ChainAdapter.getKCContextGraphId` | `ChainAdapter.getKAContextGraphId` | `@origintrail-official/dkg-chain` |
| `NodeChallenge.knowledgeCollectionId` | `NodeChallenge.knowledgeAssetId` | `@origintrail-official/dkg-random-sampling` |
| `PublishResult.kcId` | `PublishResult.kaId` | `@origintrail-official/dkg-publisher` |
| `ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_KC_ID` | `…PUBLISHED_AT_KA_ID` | `@origintrail-official/dkg-publisher` |
| RDF predicate `<…/publishedAtKcId>` | `<…/publishedAtKaId>` | Any receipt-triple consumer |

### 3.2 Method / param renames

| rc.11 | rc.13 |
|-------|-------|
| `createKnowledgeCollection(...)` | `createKnowledgeAsset(...)` |
| `getKnowledgeCollection(...)` | `getKnowledgeAsset(...)` |
| `updateKnowledgeCollection(...)` | `updateKnowledgeAsset(...)` |
| `extendKnowledgeCollectionLifetime(...)` | `extendKnowledgeAssetLifetime(...)` |
| `isPartOfKnowledgeCollection(...)` | `isPartOfKnowledgeAsset(...)` |
| `isOwnerOfKnowledgeCollection(...)` | `isOwnerOfKnowledgeAsset(...)` |
| `kcId` | `kaId` |
| `knowledgeCollectionId` | `knowledgeAssetId` |

### 3.3 The regex sweep

```bash
# CASE-SENSITIVE — preserves TitleCase / camelCase / SCREAMING_SNAKE
git grep -l 'KnowledgeCollection'  | while IFS= read -r f; do perl -pi -e 's/KnowledgeCollection/KnowledgeAsset/g' "$f"; done
git grep -l 'knowledgeCollection'  | while IFS= read -r f; do perl -pi -e 's/knowledgeCollection/knowledgeAsset/g' "$f"; done
git grep -l 'KNOWLEDGE_COLLECTION' | while IFS= read -r f; do perl -pi -e 's/KNOWLEDGE_COLLECTION/KNOWLEDGE_ASSET/g' "$f"; done
git grep -l 'kcId'                 | while IFS= read -r f; do perl -pi -e 's/\bkcId\b/kaId/g' "$f"; done
git grep -l 'KCId'                 | while IFS= read -r f; do perl -pi -e 's/\bKCId\b/KAId/g' "$f"; done
git grep -l 'publishedAtKcId'      | while IFS= read -r f; do perl -pi -e 's/publishedAtKcId/publishedAtKaId/g' "$f"; done
```

`BOUND_CONTRACT_INVALIDATORS` and `ERROR_ABI_CONTRACTS` (in `@origintrail-official/dkg-chain`) dropped their legacy entries. If you extended those maps, drop the `KnowledgeAssetsV10` / `KnowledgeCollectionStorage` keys.

### 3.4 Solidity / ABI

If you call contracts directly (ethers / viem / web3.js / subgraphs): every renamed function has a fresh 4-byte selector and **old calldata reverts**. Active V10.1 lives on **`KnowledgeAssetsLifecycle`** (call surface) and **`DKGKnowledgeAssets`** (ERC-721 mint/storage), both resolved via `Hub.getContractAddress(...)`. The legacy `KnowledgeAssetsV10.sol`, `KnowledgeCollectionStorage.sol`, and the V8 `KnowledgeCollection.sol` are **deleted**. Re-fetch ABIs at rc.13:

```bash
ls packages/chain/abi/
cat packages/chain/abi/KnowledgeAssetsLifecycle.json
cat packages/chain/abi/DKGKnowledgeAssets.json
```

Config-key renames in `deployments/parameters.json`: `KnowledgeCollectionStorage.knowledgeCollectionSize` → `DKGKnowledgeAssets.knowledgeAssetBatchSize`; `ContextGraphStorage.kcToContextGraph` → `kaToContextGraph`; `registerKnowledgeCollection` → `registerKnowledgeAsset`.

### 3.5 SPARQL predicate

| rc.11 | rc.13 |
|-------|-------|
| `<…/publishedAtKcId>` | `<…/publishedAtKaId>` |

Other on-chain-derived RDF surfaces (`dkg:authoredBy`, `dkg:trustLevel`, …) are unchanged.

---

## 4. Greenfield Knowledge Asset model (the conceptual change)

This is the heart of the release, and the reason for everything in §3. It came out of red-team builder feedback: the old "a publish creates a Knowledge Collection that batches N assets (ERC-1155)" model added mental overhead and on-chain cost without buying integrators much. The new model trades it for one asset per publish with a stable identifier — simpler to reason about, cheaper to publish, and less to operate.

### 4.1 What's new

- **One KA per publish** — `publish` mints exactly one ERC-721 `DKGKnowledgeAssets` token. `knowledgeAssetsAmount == 1` is the only valid value. ERC-1155 batching is gone.
- **Stable UAL** — `did:dkg:{chainId}/{DKGKnowledgeAssetsAddress}/{kaId}`, where `kaId` equals the ERC-721 `tokenId`. The UAL **no longer changes when the KA is updated.**
- **ERC-721 minted to the author at publish** — the author (recovered from the EIP-712 author attestation) holds the NFT; the publisher pays TRAC.
- **Owner-sealed updates** — only the current ERC-721 holder can update. Every update needs a fresh EIP-712 `UpdateAuthorAttestation(kaId, newMerkleRoot, authorAddress, schemeVersion)` (domain `KnowledgeAssetsLifecycle` v2.0.0), passed as `precomputedUpdateAttestation` on the same `publisher.update(kaId, options)` call. `newMerkleRoot` is recomputed from the update's quads, so seals aren't reusable across updates. The publisher (any node operator) does the chain write; the chain validates the seal against `ownerOf(kaId)`.

### 4.2 Code shape

```ts
// rc.11: ERC-1155 batched, kcId
const result = await publisher.publish({ kcSize: 1, /* ...old fields */ });
const kcId = result.kcId;

// rc.13: ERC-721 singleton, kaId, stable UAL
const result = await publisher.publish({ /* knowledgeAssetsAmount fixed at 1 */ });
const kaId = result.kaId;                 // == ERC-721 tokenId
const ual = buildKnowledgeAssetUal(chainId, dkgKnowledgeAssetsAddress, kaId);

// rc.13: every update needs a fresh owner-signed attestation
const precomputedUpdateAttestation = await signUpdateAuthorAttestation({
  kaId, quads: updateQuads, privateQuads: updatePrivateQuads,
  owner: ownerWallet,                     // CURRENT ERC-721 owner of kaId
});
await publisher.update(kaId, {
  contextGraphId, quads: updateQuads, privateQuads: updatePrivateQuads,
  precomputedUpdateAttestation,
});
```

Use the canonical UAL builder `buildKnowledgeAssetUal(chainId, dkgKnowledgeAssetsAddress, kaId)` from `@origintrail-official/dkg-chain` rather than templating the URN yourself. Reference: `packages/evm-module/docs/greenfield-ka-ual.md`. Devnet smokes: `pnpm test:devnet:greenfield-10min`, `pnpm test:devnet:rich-scenario`.

---

## 5. Economic floors (mandatory)

- **`tokenAmount >= 1` — BREAKING.** Direct-spend reverts `InvalidTokenAmount(1, 0)` on `tokenAmount == 0`; the PCA branch floors a truncated `discountedCost` at 1 wei TRAC when `baseCost > 0`. **Every off-chain caller must encode `tokenAmount >= 1`.** Any "free publish on a dust CG" pattern is gone. Same floor applies to `update` and `extendKnowledgeAssetLifetime`.
- **Protocol treasury fee — dormant by default.** A governance-set bps cut (default 300 bps = 3%, capped at 1000 bps) skims from the staker-bound TRAC on paid publish/update/extend. The publisher pays the same gross price; the fee comes out of the staker reward pool. `treasury == address(0) ⇒ fee == 0`, so it's inert until governance opts in. If you display estimated staker yield, net the fee out once enabled.
- **Reentrancy guard.** `publish` / `update` / `extendKnowledgeAssetLifetime` carry `nonReentrant` (~50 gas/call). Decode `ReentrancyGuardReentrantCall()` in any error-surfacing UI.

---

## 6. Node operator upgrade

1. **Edge vs Core.** Edge nodes update via `npm install -g @origintrail-official/dkg@10.0.0-rc.13`. Core nodes retain the git-build path. Do **not** `git pull` on an npm-managed node — set `autoUpdate.source: "npm"` if a stray `.git` is routing you down the git path.
2. **First-boot state wipe is expected.** Crossing the rc.12 `chainResetMarker` (`v10-rc12-ka-rename-2026-06-01`) wipes per-node chain-derived state and re-derives it against the redeployed Base Sepolia surface. **Stakers with V10 conviction NFTs are unaffected** — positions live on `ConvictionStakingStorage` keyed by `identityId`, which is preserved across the contract-address rotation.
3. **Hub registration (self-hosted only).** `KnowledgeAssetsLifecycle` and `DKGKnowledgeAssets` are the *only* V10.1 entries the daemon resolves. The legacy `KnowledgeAssetsV10` fallback resolver is removed — the adapter now **raises on init** if the V10.1 surface isn't registered. Re-deploy/re-register the V10.1 surface before upgrading. (Base Sepolia on the OriginTrail-managed Hub is already done — just bump and restart.)
4. **Verify.** `dkg doctor` green; `/api/build-info` reports `10.0.0-rc.13`; on Core nodes, `rs.tick.data-corrupted` is zero on the updated-KA cohort (the GH #842 fix makes updated KAs provable again).

Unchanged sanity anchors: Base Sepolia **Hub** `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` and **Token** `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8`; the MCP tool surface for AI agents (`dkg_memory_search`, `dkg_assertion_create/write/promote`, `dkg_query`, …); and the EIP-712 domain hash pinned at `KnowledgeAssetsLifecycle@2.0.0` so prior author attestations keep verifying.

---

## 7. What's new in rc.13 (on top of rc.12)

Additive unless flagged. If you're already on rc.12, this section *is* your upgrade.

### 7.1 Default publish lifetime is now 12 epochs (behavioural)

Publishes that don't specify a lifetime now default to **12 epochs** instead of the previous default. If you relied on the old implicit lifetime, set the lifetime explicitly or budget for 12 epochs of TRAC.

### 7.2 Core-preferred sync + chain-driven verified-memory reconciliation

The sync path now prefers Core peers and reconciles verified-memory against on-chain state, including host-mode catch-up. Operator-visible as healthier catch-up; no action required.

### 7.3 Kafka route-plugin MVP (`@origintrail-official/kafka-plugin`)

A new daemon **route plugin** that registers Kafka **stream metadata** as private-by-default `dkg-streams:KafkaStream` Knowledge Assets and exposes discovery endpoints under `/api/kafka/streams`. Note: it registers/discovers stream *descriptors* (name, bootstrap URL, topic, format) — it does not itself connect to brokers or move messages. Enable via `routePlugins` + `kafka.contextGraphId` in your daemon config. Demo: `demo/kafka-streams/`.

### 7.4 Publish / SWM / sync runtime hardening

Single-root SWM publish boundary, plaintext SWM for on-chain-public CGs with an allowed-agent list, sub-graph SWM catch-up + approve-time race fixes, sender-key setup after joined-CG approval, publish ACK / allowance race fixes, per-publish allowance auto-replenish, and a SPARQL parse-error classifier. All daemon-side; no caller action.

### 7.5 Node UI fixes

Canonical-triple derivation unification, WM Assertions subtab fix, markdown-import root partitioning, several QA-found bug fixes, and a settings-page cleanup.

---

## 8. Verification checklist

- [ ] `pnpm tsc` (or your build) is clean — no residual `kcId` / `KnowledgeCollection*`.
- [ ] Test suite passes against a freshly-upgraded daemon or local devnet.
- [ ] Every `tokenAmount` you send is `>= 1`.
- [ ] Update flow signs `precomputedUpdateAttestation` with the **current ERC-721 owner's** key, not the publisher's.
- [ ] No code path still assumes multiple assets per publish (`kcSize` / batch semantics removed).
- [ ] Operators: `dkg doctor` green, `/api/build-info` = `10.0.0-rc.13`, `rs.tick.data-corrupted` zero on updated KAs.
- [ ] Chain-error UIs handle `InvalidTokenAmount`, `ReentrancyGuardReentrantCall`, `OperationalWalletDuplicate`.
- [ ] SPARQL receipt queries use `publishedAtKaId`.
- [ ] Publishes either set an explicit lifetime or are budgeted for the new 12-epoch default.

---

## 9. Where to get help

- **Full per-PR detail:** [`CHANGELOG.md`](../CHANGELOG.md), sections `[10.0.0-rc.12]` and `[10.0.0-rc.13]`.
- **The focused rc.11 → rc.12 guide** (deeper on each rename row): [`docs/UPGRADE_RC11_TO_RC12.md`](UPGRADE_RC11_TO_RC12.md).
- **Greenfield KA reference:** [`packages/evm-module/docs/greenfield-ka-ual.md`](../packages/evm-module/docs/greenfield-ka-ual.md).
- **Kafka plugin:** [`packages/kafka-plugin/README.md`](../packages/kafka-plugin/README.md) and [`demo/kafka-streams/`](../demo/kafka-streams/).
- **GitHub issues:** [`OriginTrail/dkg`](https://github.com/OriginTrail/dkg/issues) — tag with `rc.13-upgrade` so we can triage as a group.
- **Discord** `#builders` — maintainers monitor it for upgrade questions.

If you hit a snag this doc doesn't cover, open an issue or PR against this file so the next builder benefits.
