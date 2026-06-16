# V8 → V10 sweep driver (OT-RFC-50 cutover)

`scripts/v8-sweep-driver.ts` drains **every** V8 delegator's stake (+ pending
withdrawals) into their V10 migration credit, by enumerating `(delegator, node)`
pairs and calling `DKGStakingConvictionNFT.adminDrainBatch` in gas-sized chunks
signed by the Hub owner.

Because OT-RFC-50 rev 5 removed self-service `startMigration`, **this driver is
the only path that empties V8** — so completeness is the whole game.

## Why it's complete (not "enumerate and hope")

- **Fast path:** `DelegatorsInfo.getDelegators(id)`. The V8 `Staking` contract
  registers a delegator (`addDelegator`) **in lockstep with every `stakeBase`
  increase** — including operator self-stake — so this is complete for *active*
  stake.
- **The one gap:** a delegator who fully withdrew (`stakeBase → 0`, no
  current-epoch score) is **removed** from `getDelegators` but may still hold a
  **pending withdrawal**, whose TRAC is *excluded* from `getNodeStake` /
  `getTotalStake`. The driver recovers these by scanning `DelegatorsInfo`
  **`DelegatorAdded(id, address)`** logs (the complete historical address
  universe) — but only when the pre-sweep vault decomposition shows pending
  actually exists.
- **Correctness oracle = the vault balance.** Stranded stake/pending physically
  sits in the `StakingStorage` TRAC vault until `transferStake` moves it, so it
  is *always* inside `balanceOf(SS)`. The drain moves stake+pending SS→CSS but
  **not** operator fees, so at completion `balanceOf(SS) == Σ getOperatorFeeBalance`.
  This oracle **cannot be falsely-green** for migrant funds — its only failure
  mode is falsely-red. The driver snapshots the decomposition pre-sweep so
  `expectedResidual` (= Σ operator fees) is a named number, and the plan also
  flags an **enumeration gap** (vault-implied drainable vs enumerated) up front.
- **Idempotent:** `drainV8ToCredit` zeroes the V8 slot and returns 0 on re-drain;
  `adminDrainBatch` skips zero pairs. So chunks are re-run-safe across
  crashes/reorgs — no progress file is needed for correctness.

## Run (per chain)

Plan first (no transactions — enumerate + decompose + report):

```bash
MODE=plan \
TARGET_HUB=0x<freezeHub> \
npx hardhat run scripts/v8-sweep-driver.ts --network <chain>
```

The plan prints the vault decomposition (active stake / pending / operator fees),
the drainable pair count, the chunk count, and — if anything is unenumerable —
a 🔴 **ENUMERATION GAP**. Resolve any gap before executing.

Then execute (signer **must** be the Hub owner / multisig owner):

```bash
MODE=execute [CHUNK_SIZE=150] \
TARGET_HUB=0x<freezeHub> \
npx hardhat run scripts/v8-sweep-driver.ts --network <chain>
```

It submits the chunks, then verifies: per-node `getNodeStake(id)==0` for all ids,
the vault oracle `balanceOf(SS)==expectedResidual`, and reconciles drained vs
pre-sweep drainable. It prints `✅ SWEEP COMPLETE` only when all three hold;
otherwise `❌ INCOMPLETE` with the exact residual (re-run — idempotent — or widen
`EVENT_SCAN_FROM`).

**Hard prerequisite:** deploy onto each chain's **V8-stake-holding freeze Hub**
(Base `0x99Aa…` / Gnosis `0x882D…` / NeuroWeb), not a fresh Hub — else there's
no V8 stake to read. Address overrides (`TARGET_SS`, `TARGET_NFT`,
`TARGET_DELEGATORS_INFO`, `TARGET_IDENTITY_STORAGE`, `TARGET_TOKEN`) are accepted
when contracts aren't resolvable via the Hub.

## Cutover sequence

1. Deploy the migration contracts (CSS, StakingV10, DKGStakingConvictionNFT) onto
   the freeze Hub; set `convictionCreditSeconds`.
2. `MODE=plan` per chain — review the decomposition, resolve any enumeration gap.
3. `MODE=execute` per chain — sweep to `✅ COMPLETE`.
4. **Only then** unregister the V8 `Staking` contract (the completion oracle
   `getTotalStake()==0` + vault==Σfees is the gate).

## Limitations / not done

- **Signing:** the driver uses an **EOA** (`accounts[0]`). Production's Hub owner
  is a Custodian **multisig** — `buildCalldata` is intentionally separated from
  `submitChunk` so a propose-to-Safe adapter swaps in without a rewrite.
- **Validated on a local node only** (multi-delegator/multi-node incl. a
  recovered pending-only delegator, and a deliberately-injected unenumerable
  delegator that the oracle correctly flags INCOMPLETE). Measured ~98k gas/pair
  on cold storage — real freeze-Hub drains get SSTORE refunds, so lower.
- **NOT run against production.** Deploy onto the real freeze Hubs + an external
  audit remain a gate before this moves real TRAC.
