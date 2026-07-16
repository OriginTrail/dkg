# OT-RFC-49 "Hosting Follows Access" — Catalog Cutover Runbook

Activation procedure + hazards for switching a live network from the private
**ciphertext** commitment model to the public **`_catalog`** commitment model
(random-sampling proof target moves from `ciphertextChunksRoot` → `catalogRoot`).

> Status: this runbook covers **activation** (a coordinated on-chain redeploy).
> It is **separate** from the code merge (PR #1203). The code can merge before
> the redeploy is scheduled; nothing activates until the contracts below are
> redeployed and the Hub re-points to them.

> ⚠️ Read "Known gaps at cutover" (bottom) BEFORE scheduling. In particular, the
> curated **UPDATE** path is not yet cut over to the catalog model.

---

## 1. What changes on-chain

| Contract | Version | Change |
|---|---|---|
| `RandomSamplingLib` (library) | — | `Challenge` struct grew two fields: `challengeLeafCount` (uint32, packs into the `solved`/`isCurated` slot) + `challengeRoot` (bytes32, fresh slot) — the WS-B proof-race snapshot. **Append-compatible** layout, but it is a library so consumers recompile. |
| `RandomSamplingStorage` | `10.0.2 → 10.1.0` | Holds the grown `Challenge` (`nodesChallenges`) + all accumulated reward/score state. Adds `clearOutstandingChallenges(uint72[])` (`:414`, owner/multisig). |
| `RandomSampling` (logic) | `10.0.4 → 10.1.0` | `submitProof` rewritten to verify against the **pinned** `challengeRoot`/`challengeLeafCount` snapshot (no live re-read); `createChallenge` resolves the curated vs public surface. Version bumped in this PR so the redeploy is not read as a no-op (live `base_sepolia` is `10.0.4`). |
| `DKGKnowledgeAssets` | — | Catalog commitment fields (`catalogRoot`/`catalogLeafCount` per KA) + getters. |
| `KnowledgeAssetsLifecycle` | — | Publish/update catalog gates: `CuratedCGRequiresCatalogCommitment`, `IncompleteCatalogCommitment`, `PublicCGCannotHaveCatalogCommitment`. |

These contracts are **non-proxy**. A bytecode change (the grown struct) therefore
requires deploying to a **new address** and re-pointing the Hub — there is no
in-place upgrade.

---

## 2. The two hazards a new-address `RandomSamplingStorage` creates

### 2a. Accumulated reward/score state is zeroed
All of the following live in `RandomSamplingStorage` and do **not** carry to a
new address (no state-migration script exists):
`nodeEpochScore`, `allNodesEpochScore`, `nodeEpochProofPeriodScore`,
`epochNodeValidProofsCount`, `nodeEpochIndex`/`scorePerStake36` checkpoints,
`epochNodeDelegatorScore`, and the delegator settle checkpoints.

**Consequence:** every node's in-progress epoch score + every delegator's
unsettled score-per-stake is lost at the cut. Claims computed off these are not
recoverable from the new contract.

**Mitigation — pin the cut to an exact epoch boundary:**
1. Announce the cutover epoch to operators.
2. Let the **current epoch finalize** so all proof-period scores for it are
   written and claimable from the OLD `RandomSamplingStorage`.
3. Ensure every node + delegator **claims** outstanding rewards from the old
   contract before the cut (the old contract stays readable, but its Hub
   wiring is gone — claims may need to target the old address directly).
4. Execute the redeploy in the gap **between** the finalized epoch and the
   first proof period of the next epoch, so the new contract's score state
   legitimately starts at 0 for a fresh epoch.

### 2b. `clearOutstandingChallenges` is a no-op against a fresh deploy
`clearOutstandingChallenges(identityIds)` sweeps `nodesChallenges` **in the
contract it is called on**. A brand-new `RandomSamplingStorage` has an empty
`nodesChallenges`, so calling it on the new address does nothing; the
old-model (ciphertext) challenges remain only in the **old** contract, which is
abandoned.

**Therefore, under the new-address model the fresh deploy IS the challenge
clear** — no node carries a ciphertext-era challenge into the catalog era.
`clearOutstandingChallenges` is only needed if a future cutover keeps the
storage address (logic-only redeploy); in that case run it, on the kept
storage, for the full set of active `identityIds` immediately after re-pointing
the Hub and before the first new proof period.

> Decision to confirm before executing: **fresh `RandomSamplingStorage`
> (simpler, but zeroes 2a)** vs **keep storage + logic-only redeploy + run
> `clearOutstandingChallenges` (preserves rewards, but only valid because the
> `Challenge` struct change is append-compatible — verify the new struct's slot
> packing against the existing on-chain layout with a storage-layout diff before
> trusting it).**

---

## 3. Deploy mechanics (version-keyed `deployed` flag)

`hre.helpers.deploy` (`utils/helpers.ts:148`) reuses an existing contract when
`contractDeployments.contracts[name].deployed === true` — it does **not**
compare source/bytecode versions. To force a redeploy you must flip `deployed`
to `false` (or remove the entry) for each cutover contract in the target
network's `deployments/<network>_contracts.json`, then run the deploy.

The post-deploy `updateDeploymentsJson` records `version()` into the manifest.
This is why the `RandomSampling._VERSION` bump in this PR matters: without it,
the manifest would show `10.0.4 → 10.0.4` after redeploying changed behavior,
hiding the change from anyone diffing deployment manifests.

Cutover contracts to flip + redeploy (respect the dependency order encoded in
`deploy/active/`): `RandomSamplingStorage` (022) → `RandomSampling` (031) →
`KnowledgeAssetsLifecycle` / `DKGKnowledgeAssets` as applicable.

---

## 4. Ordered procedure

1. **Freeze** new curated publishes on the network (operator coordination).
2. **Finalize the current epoch** (2a step 2); confirm all scores written.
3. **Settle claims** from the old `RandomSamplingStorage` (2a step 3).
4. Within the epoch-boundary gap:
   a. Flip the `deployed` flags for the cutover contracts (§3).
   b. Run the deploy; verify new addresses + `version()` (`10.1.0` for
      `RandomSampling` and `RandomSamplingStorage`).
   c. Confirm the Hub now resolves the new addresses for every cutover contract.
   d. If keeping storage (the §2b alt path), run `clearOutstandingChallenges`
      for all active identity ids.
5. **Internal auth review** of the ACK signer + catalog-host paths (carried from
   the PR's open items) — do this before re-opening publishes.
6. **Unfreeze**; partner re-publish of a curated KC.
7. Run §5 validation.

---

## 5. Post-cutover validation

- `scripts/devnet-test-rfc49-catalog-sampling.sh` semantics, against the live
  net where feasible: a curated publish lands a non-zero `getCatalogRoot` /
  `getCatalogLeafCount`; cores hold **zero** private ciphertext + hold the
  public `_catalog`; a core submits a random-sampling proof against the
  `_catalog`.
- `rfc49-catalog-parity.e2e` parity (rebuilt catalog root == on-chain root).
- Confirm a fresh epoch's scores accrue on the new `RandomSamplingStorage`.

---

## 6. Known gaps at cutover (do NOT skip)

- **Curated UPDATE is not cut over to the catalog model.** The publisher builds
  / prices / ships no catalog on update, and the core ACK handler does not
  rebuild/verify it. A value-adding curated **update** will revert on-chain
  (`CuratedCGRequiresCatalogCommitment`), and cores won't re-host an updated
  curated catalog. Until this is built (separate follow-up), **curated KCs are
  effectively publish-then-immutable** on the catalog model — communicate this
  to partners. (See PR #1203 thread.)
- **Curator restart re-confirmation gap** (M2-b): a curator does not re-confirm
  its own private CG after a restart. Independent of the catalog cutover; filed
  on #1201. Operators should avoid curator restarts during the cut window.
- **Strip-OFF host-mode custody hatch**: the devnet discriminator did not engage
  in-window; the legacy `stripCiphertext:false` custody path is unverified
  post-reconciliation. Shipped behavior is strip-ON (cores hold zero), which is
  validated; do not rely on the strip-OFF hatch.
