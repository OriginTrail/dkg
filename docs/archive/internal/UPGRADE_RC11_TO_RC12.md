# Upgrading from `v10.0.0-rc.11` to `v10.0.0-rc.12`

**Audience:** builders integrating with the DKG node (`@origintrail-official/dkg` and friends) — SDK callers, dApp authors, Obsidian-style note integrations, agent frameworks, chain consumers.

**Compatibility posture:** this is a **forward-only, breaking release**. There are no shims, no fallback resolvers, and no compatibility codepaths. Every package in the workspace upgrades in lockstep; testnet (Base Sepolia) and devnet are intentionally broken by this change and must be redeployed.

If your project pins `@origintrail-official/dkg@10.0.0-rc.11`, you need to do the work below before the daemon will boot against rc.12 contracts. The good news: the surface area is well-bounded and most of it is mechanical search-and-replace.

---

## Use this guide as an agent prompt

The fastest way to upgrade an existing integration is to point an AI coding agent at this document and your codebase. Drop the block below into Cursor, Claude Code, Codex CLI, or any AGENTS.md-honouring tool, then let it run:

```
You are upgrading a DKG integration from @origintrail-official/dkg v10.0.0-rc.11
to v10.0.0-rc.12. Read docs/UPGRADE_RC11_TO_RC12.md from the dkg repository
(https://github.com/OriginTrail/dkg/blob/main/docs/UPGRADE_RC11_TO_RC12.md) end
to end before changing any code.

Then, in this order:

1. Bump the @origintrail-official/dkg* dependency versions in every package.json
   in this workspace to ^10.0.0-rc.12.
2. Apply the mechanical TypeScript renames in §2 (Knowledge Collection → Knowledge
   Asset). Use a workspace-wide search-and-replace, then run tsc to catch the
   residual call sites that need follow-up.
3. If this integration calls the Solidity surface directly (custom scripts,
   ethers contracts, subgraphs), apply §3 (ABI + selector changes). Re-fetch ABIs
   from packages/chain/abi/ at the new version.
4. If this integration publishes Knowledge Assets, apply §4 (greenfield KA
   model) — exactly one KA per publish; owner-sealed updates via
   precomputedUpdateAttestation; UAL is now did:dkg:{chainId}/{contract}/{kaId}.
5. If this integration sends any tokenAmount or relies on PCA discounts, apply §5
   (economic floors). Zero-cost publishes now revert.
6. Apply any §6 chain adapter / Hub registration changes if you operate a node.
7. Read §8 (new capabilities) and surface any that are relevant.
8. Run the integration's own test suite. For any failure, locate the matching
   row in the §2/§3 rename tables before debugging further — most rc.11→rc.12
   breakage is rename-induced.

When you're done, summarise the changes you made and call out any sites where
you weren't sure about the right migration.
```

---

## 1. TL;DR breaking-change matrix

| # | Area | Change | Affects |
|---|------|--------|---------|
| 1 | Terminology | `KnowledgeCollection` → `KnowledgeAsset` rename, on-chain and off-chain | Everyone. TS, Solidity, ABIs, predicate URIs, daemon API |
| 2 | Solidity ABI | 4-byte selectors on `DKGKnowledgeAssets` and `ContextGraphStorage` change for every renamed function | Direct chain consumers (custom scripts, dApps, subgraphs) |
| 3 | Hub resolution | Legacy `KnowledgeAssetsV10` fallback resolver removed | Operators on older Hub deploys |
| 4 | KA model | Greenfield: exactly one ERC-721 KA per publish, stable UAL, owner-sealed updates via `precomputedUpdateAttestation` | Publishers, updaters |
| 5 | Economic | Strict-positive `tokenAmount >= 1` floor; zero-cost publishes now revert | Any caller sending `tokenAmount: 0` |
| 6 | Economic | Protocol treasury fee skim (default 300 bps = 3%) on publish/update/extend; dormant by default | Stakers (net reward), publishers (caller pays gross) |
| 7 | Profile | `Profile.recreateProfile` drops the `initialOperatorFee` argument | Operator recovery scripts |
| 8 | Storage | `nonReentrant` perimeter on KAV10 entrypoints | ERC-1155 receiver hooks (~50 gas/call) |
| 9 | RS | Updated Knowledge Assets are now provable by Random Sampling (GH #842) | Cores running RS; observable as the disappearance of `rs.tick.data-corrupted` |
| 10 | Chain | Testnet contract redeploy required on Base Sepolia | Operators; chain readers caching addresses |

The rest of this document is the concrete migration for each row.

---

## 2. TypeScript SDK migration (the rename)

This is mechanical and covers ~95% of builder-side churn. Do it with a workspace-wide search-and-replace, then let `tsc` find the rest.

### 2.1 Identifier rename table

| rc.11 | rc.12 | Where it surfaces |
|-------|-------|-------------------|
| `ChainAdapter.createKnowledgeAssetsV10` | `ChainAdapter.createKnowledgeAssets` | `@origintrail-official/dkg-chain` |
| `ChainAdapter.getKnowledgeAssetsV10Address` | `ChainAdapter.getKnowledgeAssetsLifecycleAddress` | `@origintrail-official/dkg-chain` |
| `ChainAdapter.getKCContextGraphId` | `ChainAdapter.getKAContextGraphId` | `@origintrail-official/dkg-chain` |
| `NodeChallenge.knowledgeCollectionId` | `NodeChallenge.knowledgeAssetId` | `@origintrail-official/dkg-random-sampling` |
| `PublishResult.kcId` *(was already `kaId` in publisher; alias dropped)* | `PublishResult.kaId` | `@origintrail-official/dkg-publisher` |
| `ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_KC_ID` | `ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_KA_ID` | `@origintrail-official/dkg-publisher` |
| Predicate URI `<…/publishedAtKcId>` (RDF) | `<…/publishedAtKaId>` (RDF) | Any consumer of assertion-publish receipt triples |
| Adapter handles `knowledgeAssetsV10` / `knowledgeCollectionStorage` | `knowledgeAssetsLifecycle` / `knowledgeAssetStorage` | Internal to adapter, but exposed via debug surfaces |

### 2.2 Property / param renames inside structs

If your code constructs request bodies by hand (e.g. through `fetch`), update these keys:

| rc.11 | rc.12 |
|-------|-------|
| `kcId` | `kaId` |
| `knowledgeCollectionId` | `knowledgeAssetId` |
| `createKnowledgeCollection(...)` | `createKnowledgeAsset(...)` |
| `getKnowledgeCollection(...)` | `getKnowledgeAsset(...)` |
| `extendKnowledgeCollectionLifetime(...)` | `extendKnowledgeAssetLifetime(...)` |
| `isPartOfKnowledgeCollection(...)` | `isPartOfKnowledgeAsset(...)` |
| `isOwnerOfKnowledgeCollection(...)` | `isOwnerOfKnowledgeAsset(...)` |
| `updateKnowledgeCollection(...)` | `updateKnowledgeAsset(...)` |

### 2.3 Mechanical search-and-replace

If your codebase is small enough to risk a single pass, this regex sweep covers 95% of cases (re-run `tsc` after; expect a handful of context-sensitive holdouts):

```bash
# CASE-SENSITIVE — preserve TitleCase / camelCase / SCREAMING_SNAKE
git grep -l 'KnowledgeCollection' | while IFS= read -r f; do perl -pi -e 's/KnowledgeCollection/KnowledgeAsset/g' "$f"; done
git grep -l 'knowledgeCollection' | while IFS= read -r f; do perl -pi -e 's/knowledgeCollection/knowledgeAsset/g' "$f"; done
git grep -l 'KNOWLEDGE_COLLECTION' | while IFS= read -r f; do perl -pi -e 's/KNOWLEDGE_COLLECTION/KNOWLEDGE_ASSET/g' "$f"; done
git grep -l 'kcId'                | while IFS= read -r f; do perl -pi -e 's/\bkcId\b/kaId/g' "$f"; done
git grep -l 'KCId'                | while IFS= read -r f; do perl -pi -e 's/\bKCId\b/KAId/g' "$f"; done
git grep -l 'publishedAtKcId'     | while IFS= read -r f; do perl -pi -e 's/publishedAtKcId/publishedAtKaId/g' "$f"; done
```

The legacy V10.0 fallback resolver is **gone** — if `KnowledgeAssetsLifecycle` doesn't resolve from the Hub, `EVMChainAdapter.init` now raises instead of silently trying `KnowledgeAssetsV10`. Make sure your operator Hub has the V10.1 surface registered before pointing the daemon at it (see §6).

### 2.4 Property renames you can't grep for

`BOUND_CONTRACT_INVALIDATORS` and `ERROR_ABI_CONTRACTS` (in `@origintrail-official/dkg-chain`) drop their legacy entries. If you've extended these maps in your own code, drop the corresponding keys (`KnowledgeAssetsV10`, `KnowledgeCollectionStorage`).

---

## 3. Solidity / ABI migration

This affects you if you call the contracts directly (ethers, web3.js, viem, custom scripts, subgraphs).

### 3.1 Contract renames

| rc.11 Solidity name | rc.12 Solidity name |
|---|---|
| `KnowledgeCollectionLib.sol` | `KnowledgeAssetLib.sol` |
| `struct KnowledgeCollection` | `struct KnowledgeAsset` |
| `error KnowledgeCollection*` (all) | `error KnowledgeAsset*` |
| `event KnowledgeCollection*` (all) | `event KnowledgeAsset*` |
| `KnowledgeAssetsV10.sol` (legacy V10.0 contract) | **DELETED** |
| `KnowledgeCollectionStorage.sol` (legacy V10.0 storage) | **DELETED** |
| `KnowledgeCollection.sol` (V8 archive) | **DELETED** |

### 3.2 Active V10.1 surface

Active V10.1 lives on these two contracts (look them up via `Hub.getContractAddress(...)`):

- `KnowledgeAssetsLifecycle` (formerly the call surface on `KnowledgeAssetsV10`)
- `DKGKnowledgeAssets` (the ERC-721 storage / mint surface)

### 3.3 Selector changes

Every renamed function has a fresh 4-byte selector. Old calldata reverts. Rebuild against the new ABIs:

```bash
# In the dkg repo at the rc.12 tag:
ls packages/chain/abi/

# Pull the JSON for whichever contract you bind to:
cat packages/chain/abi/KnowledgeAssetsLifecycle.json
cat packages/chain/abi/DKGKnowledgeAssets.json
cat packages/chain/abi/ContextGraphs.json
cat packages/chain/abi/ContextGraphStorage.json
cat packages/chain/abi/ParametersStorage.json
```

The `packages/chain/test/abi-pinning.test.ts` pinned digests reflect the rename. If you've pinned ABI hashes downstream, regenerate them.

### 3.4 Storage / config renames

`deployments/parameters.json` config keys:

- `KnowledgeCollectionStorage.knowledgeCollectionSize` → `DKGKnowledgeAssets.knowledgeAssetBatchSize`
- `ContextGraphStorage.kcToContextGraph` (mapping name) → `kaToContextGraph`
- `registerKnowledgeCollection` → `registerKnowledgeAsset`

### 3.5 Predicate URIs in RDF / SPARQL

If you write SPARQL against published assertions, update predicate IRIs:

| rc.11 predicate | rc.12 predicate |
|---|---|
| `<…/publishedAtKcId>` | `<…/publishedAtKaId>` |

Other on-chain-derived RDF surfaces (`dkg:authoredBy`, `dkg:trustLevel`, etc.) are unchanged.

---

## 4. Greenfield Knowledge Asset model

The headline new feature in rc.12, and the reason for the rename: a unified, simplified KA lifecycle.

### 4.1 What's new

- **One KA per publish** — `publish` mints exactly one ERC-721 `DKGKnowledgeAssets` token. `knowledgeAssetsAmount == 1` is now the only valid value. ERC-1155 batching is gone.
- **Stable UAL** — `did:dkg:{chainId}/{DKGKnowledgeAssetsAddress}/{kaId}`. `kaId` equals the ERC-721 `tokenId`. The UAL no longer changes when the KA is updated.
- **ERC-721 minted to author at publish** — the author (recovered from EIP-712 author attestation) holds the NFT; the publisher pays TRAC.
- **Owner-sealed updates** — only the current ERC-721 holder can update. Every update needs a fresh EIP-712 `UpdateAuthorAttestation(kaId, newMerkleRoot, authorAddress, schemeVersion)` (domain `KnowledgeAssetsLifecycle` v2.0.0), passed as `precomputedUpdateAttestation` on that same `publisher.update(kaId, options)` call. The `newMerkleRoot` is recomputed from the update's `quads` / `privateQuads`, so seals are not reusable across later updates. The publisher (which can be any node operator) does the chain write; the attestation is the seal that the chain validates against `ownerOf(kaId)`.
- **No ERC-1155 mint/burn on update** — updates only refresh the merkle root + leaf count; the ERC-721 stays bound to the same `kaId`.

### 4.2 Code changes

```ts
// rc.11: ERC-1155 batched, kcId, batched signing
const result = await publisher.publish({
  kcSize: 1,
  // ... old fields
});
const kcId = result.kcId;

// rc.12: ERC-721 singleton, kaId, stable UAL
const result = await publisher.publish({
  // knowledgeAssetsAmount is implicit / fixed at 1
  // ... new fields
});
const kaId = result.kaId; // also the ERC-721 tokenId
const ual = `did:dkg:${chainId}/${dkgKnowledgeAssetsAddress.toLowerCase()}/${kaId}`;

// rc.12: every update requires a fresh precomputedUpdateAttestation
const updateQuads = [
  // ... complete replacement public quads for this KA
];
const updatePrivateQuads = [
  // ... optional replacement private quads for this KA
];
// Your signing helper must compute expectedNewMerkleRoot over these exact
// updateQuads/updatePrivateQuads using the publisher's V10 root rules.
const precomputedUpdateAttestation = await signUpdateAuthorAttestation({
  kaId,
  quads: updateQuads,
  privateQuads: updatePrivateQuads,
  owner: ownerWallet, // current ERC-721 owner of kaId
});
const updateResult = await publisher.update(kaId, {
  contextGraphId,
  quads: updateQuads,
  privateQuads: updatePrivateQuads,
  precomputedUpdateAttestation, // signed by ownerOf(kaId) for these exact quads
});
```

The canonical UAL builder is `buildKnowledgeAssetUal(chainId, dkgKnowledgeAssetsAddress, kaId)` exported from `@origintrail-official/dkg-chain`. Use it instead of templating the URN yourself.

### 4.3 Verifying the surface

```bash
pnpm test:devnet:greenfield-10min   # the 10-minute happy-path smoke
pnpm test:devnet:rich-scenario      # mixed publish / update / extend scenarios
```

See `packages/evm-module/docs/greenfield-ka-ual.md` for the canonical reference.

---

## 5. Economic changes (mandatory)

### 5.1 `tokenAmount >= 1` floor — **BREAKING**

Both branches of the publish flow now charge a non-zero economic cost regardless of input rounding:

- **Direct-spend** path: `tokenAmount == 0` reverts with `InvalidTokenAmount(1, 0)`.
- **PCA (Publishing Conviction Account)** path: when the discount math would truncate to `discountedCost == 0` but `baseCost > 0`, the cost is floored at **1 wei TRAC** so the active-sink reward distribution and `windowSpent` accounting always fire.

**What you have to do:** every off-chain caller MUST encode `tokenAmount >= 1`. Zero-cost publish flows are no longer permitted. If your integration was relying on a "free publish on dust CG" pattern, that's gone.

The same floor applies to `update` and `extendKnowledgeAssetLifetime` — they enforce the floor in both the direct-spend and conviction branches.

### 5.2 Protocol treasury fee — new, dormant by default

A governance-set bps cut (default **300 bps = 3 %**, capped at **1000 bps = 10 %**) is skimmed from the staker-bound TRAC on every paid publish, update, and lifetime-extension and routed to a treasury address.

- **The publisher pays the same gross price.** The fee comes out of what would otherwise flow into the staker reward pool.
- **Dormant by default**: `treasury == address(0)` ⇒ `fee == 0`, so a fresh deploy is unchanged until governance opts in. (`ProtocolTreasurySet` is emitted when the treasury address changes.)
- New `ParametersStorage` fields: `protocolTreasuryFee` (bps), `protocolTreasury` (address), `MAX_PROTOCOL_TREASURY_FEE` (1000 bps cap).
- Event surface:
  - `setProtocolTreasury(address)` emits `ParametersStorage.ProtocolTreasurySet(address indexed treasury)`.
  - `setProtocolTreasuryFee(uint16)` still emits `ParameterChanged("protocolTreasuryFee", fee)`.

If you display "estimated staker rewards" in your UI, you'll want to net out the treasury fee from the displayed reward yield once governance enables it. The fee is `0` until then.

`PublishingConviction` accumulates the fee across active sink + every passive window sweep + final dust/topUp tail, and pays it via a single `CSS.transferStake` after all state writes (so the permissionless `settle()` stays reentrancy-safe). The lifetime invariant is now `pool + treasury == committed + topUps`.

### 5.3 Reentrancy guard on KAV10 entrypoints

`publish` / `update` / `extendKnowledgeAssetLifetime` now carry OZ `ReentrancyGuard.nonReentrant` as a defense-in-depth perimeter against the ERC-1155 receiver-hook callback path. Cost is ~50 gas per call. Failing this guard reverts with `ReentrancyGuardReentrantCall()` — surface that error in any UI that decodes contract errors.

---

## 6. Chain adapter & Hub registration

This only affects you if you operate a node or maintain a custom deploy of the V10 contract stack.

### 6.1 Hub registration

`KnowledgeAssetsLifecycle` and `DKGKnowledgeAssets` are the **only** V10.1 entries the rc.12 daemon looks up. Hub deployments that still expose `KnowledgeAssetsV10` or `KnowledgeCollectionStorage` will be silently ignored — the daemon won't resolve them.

**Required action for self-hosted deploys:** re-deploy and re-register the V10.1 contract surface against your Hub before upgrading the daemon. For Base Sepolia operators on the OriginTrail-managed Hub, the redeploy is already done; just bump your daemon to `v10.0.0-rc.12` and let the chain-reset wipe re-derive state on first boot.

### 6.2 Legacy fallback resolver removed

`EVMChainAdapter.init` previously fell back to `KnowledgeAssetsV10` if `KnowledgeAssetsLifecycle` didn't resolve. That fallback is gone. The adapter raises on init if the V10.1 surface isn't registered — fail-fast instead of silently running on the wrong contract.

### 6.3 ABI re-pin

`packages/chain/abi/` is regenerated for every renamed contract. If you have a downstream pin (e.g. you've forked the chain package), regenerate it:

```bash
pnpm --filter @origintrail-official/dkg-evm-module build
git add packages/evm-module/abi packages/chain/abi
```

CI gates this via the `abi-freshness` workflow.

### 6.4 Profile recovery signature change

`Profile.recreateProfile` drops the `uint16 initialOperatorFee` argument. The recovered profile is seeded at `operatorFee = 0`; the admin sets the real value via the cooldown-gated `updateOperatorFee` path. If you have an operator recovery script (a la `scripts/recreate-profile.ts`), drop the fourth argument and follow up with a separate `updateOperatorFee` call.

### 6.5 Operational-wallet validation rewire

`Identity.addOperationalWallets` is now the single source of truth for op-wallet validation. Same-identity collisions surface as `OperationalWalletDuplicate(wallet)`; cross-identity collisions still fire `OperationalKeyTaken(key)`; admin/operational overlap surfaces as the existing `KeyAlreadyAttached(key)`. `Profile.createProfile`'s pre-flight validation loop is removed — atomic-revert semantics make the prior "fail-fast at the entrypoint" rationale moot. Identity bumps to `v1.1.0`, Profile to `v1.4.2`.

### 6.6 CEI ordering on staking withdrawal

`DKGStakingConvictionNFT.withdraw` now burns the receipt NFT **before** `StakingV10.withdraw` drives the CSS teardown + TRAC payout. `StakingV10.withdraw` gates on the CSS position (`pos.identityId == 0`), not NFT existence, so the CSS teardown is unaffected. If you have a staking dashboard subscribing to `Transfer`/`Withdrawn` events, expect the burn event to land before the TRAC transfer event for a given withdrawal.

---

## 7. Random Sampling proof health (GH #842 fix)

If you operate a Core node, this is the change you'll see in your logs:

**Before rc.12:** every *updated* Knowledge Asset became permanently unprovable by Random Sampling, producing a steady stream of `rs.tick.data-corrupted` on core nodes once any KA was updated. The defect was a race between two writers to the per-cgId materialization partition (publish-promotion and update-promotion), with no version guard.

**After rc.12:** updated KAs stay provable. Three changes:

1. **Full label-graph restatement on both update paths** (publisher `storeUpdatedQuads` and gossip `UpdateHandler`).
2. **Per-KA `dkg:materializedVersion` (`block:txIndex`) guard** stamped on the KC's `<ual>` in the meta graph. Every canonical writer (publisher promotion, update promotion, receiver `FinalizationHandler`) refuses to apply a state older than what's already materialised.
3. **Deterministic UAL fallback** in `UpdateHandler` so a gossip receiver that hasn't yet materialised the `dkg:batchId` edge still promotes instead of silently skipping.

**What you have to do:** nothing — it's purely a daemon-side fix. The `rs.tick.data-corrupted` metric should drop to zero on the updated cohort once you upgrade. The fix is fully described in [`gh842-rs-update-race-analysis.md`](investigations/gh842-rs-update-race-analysis.md) if you want the deep-dive.

---

## 8. New capabilities (non-breaking, but builders should know)

### 8.1 Blazegraph + SPARQL-HTTP external triple-store support (RFC 120)

The daemon's persistence layer can now point at an external Blazegraph or generic SPARQL-HTTP endpoint instead of (or in addition to) the embedded Oxigraph store. Useful for large-scale deployments and for integrations that want to share a query backend with other services.

Configure via `~/.dkg/config.json`:

```json
{
  "store": {
    "backend": "sparql-http",
    "options": {
      "queryEndpoint": "http://localhost:9999/blazegraph/namespace/kb/sparql",
      "updateEndpoint": "http://localhost:9999/blazegraph/namespace/kb/sparql"
    }
  }
}
```

For a fresh config, `dkg init --store sparql-http --store-url <SPARQL_URL>` pre-fills and validates the same `store` block. Setup flows that expose `--store` / `--store-url` persist the same shape after their normal setup completes. See `docs/setup/STORAGE_SPARQL_HTTP.md` for the manual operator runbook.

If you choose the Blazegraph-specific backend instead of generic `sparql-http`, the config shape is `store.backend = "blazegraph"` with `store.options.url = "<SPARQL_URL>"`.

### 8.2 `dkg doctor`

A new operator command that diagnoses common install/upgrade issues. Run `dkg doctor` after upgrading to confirm the install is healthy. The default output is human-readable; use `dkg doctor --json` when upgrade automation needs the structured six-check report + state summary.

### 8.3 Legacy install migration to npm

`dkg migrate-to-npm` is no longer a CLI command in rc.12. Edge nodes with a legacy `~/.dkg/releases/` tree migrate automatically on first `dkg start` and keep `~/.dkg/previous-version` populated for rollback continuity. Core operators still running from a git checkout should follow the manual path in `docs/archive/MIGRATE_TO_NPM.md`; use `dkg doctor --json` before and after the upgrade to verify the active install layout.

### 8.4 `/api/build-info` + `/api/status` `relay` block

- New `/api/build-info` endpoint surfaces `{ version, commit, installMode, builtAt }` so monitoring can correlate daemon behaviour with build provenance.
- `/api/status` now includes a uniform `relay` block on every node (edge + core): `isCore`, `reservationsHeld`, `reservationCapacity`, `activeCircuits`, `bytesIn`, `bytesOut` (stringified BigInt), `natStatus`, `listenAddresses`, `announcedAddresses`.

### 8.5 RFC-41 Bundle B — Edge node npm-only update path

Edge nodes now update via `npm install -g @origintrail-official/dkg` rather than a git-clone build. Git-based updates are hard-refused at user-facing entry points for edges. Core nodes retain the git-build path for now (will follow in a later RC).

### 8.6 Node UI — Context Graph Overview (S2 + S3 polish)

The Node UI's Context Graph view ships a redesigned overview with a Root mini-card, cross-layer pills, mini-graph colors, and de-duplication. The notifications pane is membership-scoped with inline join-approve/deny actions.

### 8.7 Ethers polling subscriber fix

The chain adapter now forces ethers' `PollingEventSubscriber` to stop the `FilterId` CPU spin that was producing 100% single-core utilization on long-uptime daemons.

---

## 9. Things that did NOT change (sanity check)

- **Hub address** (Base Sepolia): `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` — unchanged.
- **Token address** (Base Sepolia v9TRAC): `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8` — unchanged.
- **Storage layout** of upgradeable contracts — no migration is required; rc.12 doesn't preserve state across the V10 redeploy-and-reinit pattern anyway.
- **MCP tool surface** for AI agents (`dkg_memory_search`, `dkg_assertion_create/write/promote`, `dkg_query`, `dkg_send_message`, etc.) — V10 tool surface is unchanged from rc.11.
- **EIP-712 domain hash** on `KnowledgeAssetsLifecycle` — pinned at `v2.0.0` so previously-signed author attestations keep verifying across the `v2.0.0 → v2.0.1` patch bump.
- **Chat / agent-to-agent messaging** wire format — `/dkg/10.0.1/*` protocol surface from rc.9 is unchanged.

---

## 10. Verification checklist for builders

After upgrading, run through this list:

- [ ] `pnpm tsc` (or your TS build) is clean — no residual `kcId` / `KnowledgeCollection*` references.
- [ ] Your test suite passes against a local devnet or a freshly-upgraded daemon.
- [ ] Any `tokenAmount` values your integration sends are `>= 1`.
- [ ] Your update flow signs a `precomputedUpdateAttestation` with the **current ERC-721 owner's** key, not the publisher's.
- [ ] If you operate a node: `dkg doctor` is green, `/api/build-info` reports `10.0.0-rc.12`, and `rs.tick.data-corrupted` is zero on the updated-KA cohort.
- [ ] If you decode chain errors in a UI: you handle `InvalidTokenAmount`, `ReentrancyGuardReentrantCall`, `OperationalWalletDuplicate`, and the new `Profile` error surface.
- [ ] Your SPARQL queries against publish-receipts use `publishedAtKaId`, not `publishedAtKcId`.

---

## 11. Where to get help

- **Full per-PR detail:** [`CHANGELOG.md`](../CHANGELOG.md) under the `[10.0.0-rc.12]` section.
- **Greenfield KA reference:** [`packages/evm-module/docs/greenfield-ka-ual.md`](../packages/evm-module/docs/greenfield-ka-ual.md).
- **Random Sampling update fix deep-dive:** [`gh842-rs-update-race-analysis.md`](investigations/gh842-rs-update-race-analysis.md).
- **CG memory model (the design that made edge-curator publishing possible):** [`docs/specs/SPEC_CG_MEMORY_MODEL.md`](specs/SPEC_CG_MEMORY_MODEL.md).
- **GitHub:** issues on [`OriginTrail/dkg`](https://github.com/OriginTrail/dkg/issues) — tag with `rc.12-upgrade` so we can triage them as a group.
- **The DKG node Discord** — the maintainers monitor #builders for upgrade questions.

If you hit an upgrade snag this document doesn't cover, please open an issue or PR against this file so the next builder benefits.
