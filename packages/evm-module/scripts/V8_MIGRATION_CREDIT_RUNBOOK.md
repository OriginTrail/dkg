# V8→V10 migration conviction credit — rollout runbook

End-to-end procedure for rehearsing the migration credit feature on a
testnet (Base Sepolia) and then mirroring it on mainnet.

This is the runbook produced after the local devnet rehearsal that lives
in `scripts/devnet-credit-smoke.ts` (4/4 scenarios pass against
`hardhat node`).

## What this rolls out

1. New contract `V8MigrationEligibility` (registry of `(identityId, delegator)`
   pairs that earned the 60-day conviction credit on V8).
2. `ConvictionStakingStorage` 4.0.0 → **4.1.0** — `createPosition` gains an
   `expiryShortenedBy` parameter that shortens the V10 lock duration.
3. `StakingV10` 3.0.0 → **3.1.0** — wires the registry and applies the
   credit inside `_convertToNFT` only for tier 6 / tier 12 migrations of
   eligible pairs.

The off-chain pipeline:

```
snapshot_v8_eligibility.ts  →  simple CSV  →  upload_v8_eligibility.ts
   (dkg-evm-module repo)        identityId,            (this repo,
                                 delegator,            scripts/)
                                 eligibleAmount
```

---

## Phase 0 — prerequisites

- `dkg-evm-module` repo cloned at the same level as `dkg/`. The snapshot
  script lives there.
- `RPC_BASE_SEPOLIA_V10` set to a Base Sepolia RPC with archival logs
  (the public `https://sepolia.base.org` works but is rate-limited).
- `EVM_PRIVATE_KEY_BASE_SEPOLIA_V10` in `.env` (this repo) — the wallet
  must be Hub.owner on the Base Sepolia V10 deployment.
- A test delegator wallet with positive V8 stake on Base Sepolia (we'll
  use it later to verify `selfMigrateV8` applies the credit).

---

## Phase 1 — deploy the new contracts

From `packages/evm-module/`:

> **IMPORTANT — version bumps do NOT auto-redeploy.** `hre.helpers.deploy()`
> short-circuits on any contract already marked `"deployed": true` in
> `deployments/<network>_contracts.json` (`isDeployed()` reads that flag and
> never compares the on-disk `version`). On the existing Base Sepolia V10
> deployment `ConvictionStakingStorage` (4.0.0) and `StakingV10` (3.0.0) are
> already `deployed: true`, so a plain `npx hardhat deploy` would **reuse the
> old bytecode** and silently skip the 4.1.0 / 3.1.0 bumps. You must flip
> their `deployed` flag to `false` first so the helper redeploys the new
> bytecode and re-registers it in the Hub. `V8MigrationEligibility` is a brand
> new contract (absent from the JSON), so it deploys fresh with no edit.

```bash
# 1. Compile with the abi exporter so deploy can read abi/V8MigrationEligibility.json
npx hardhat compile

# 2. Force-redeploy the two version-bumped contracts: set their `deployed`
#    flag to false in deployments/base_sepolia_v10_contracts.json. The helper
#    only redeploys contracts whose flag is false (or that are absent).
node -e '
  const fs = require("fs");
  const p = "deployments/base_sepolia_v10_contracts.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const name of ["ConvictionStakingStorage", "StakingV10"]) {
    if (!j.contracts[name]) throw new Error(`${name} missing from ${p}`);
    j.contracts[name].deployed = false;
  }
  fs.writeFileSync(p, JSON.stringify(j, null, 4) + "\n");
  console.log("Marked ConvictionStakingStorage + StakingV10 for redeploy.");
'

# 3. Deploy. With the flags cleared, the helper deploys 4.1.0 / 3.1.0,
#    re-registers them in the Hub, and queues reinitialization;
#    V8MigrationEligibility is deployed fresh.
npx hardhat deploy --network base_sepolia_v10
```

Confirm in `deployments/base_sepolia_v10_contracts.json`:

```jsonc
"ConvictionStakingStorage": { "version": "4.1.0", ... }
"StakingV10":               { "version": "3.1.0", ... }
"V8MigrationEligibility":   { "version": "1.0.0", ... }
```

Sanity check on chain:

```bash
# Each call should return the version in the JSON above.
cast call <CSS_ADDR>     'version()(string)' --rpc-url $RPC_BASE_SEPOLIA_V10
cast call <STAKINGV10>   'version()(string)' --rpc-url $RPC_BASE_SEPOLIA_V10
cast call <REGISTRY>     'version()(string)' --rpc-url $RPC_BASE_SEPOLIA_V10
cast call <REGISTRY>     'frozen()(bool)'    --rpc-url $RPC_BASE_SEPOLIA_V10  # → false
cast call <REGISTRY>     'eligibleCount()(uint256)' --rpc-url $RPC_BASE_SEPOLIA_V10  # → 0
cast call <STAKINGV10>   'v8MigrationEligibility()(address)' --rpc-url $RPC_BASE_SEPOLIA_V10
# Last call must equal <REGISTRY> address.
```

---

## Phase 2 — snapshot V8 eligibility

`base_sepolia` was added to `dkg-evm-module/scripts/snapshot_v8_eligibility.ts`.
The 60-day window is a wall-clock duration tied to the V8 launch
schedule, so it is the SAME on every network. The off-chain snapshot
script accepts `--window-seconds` only for forward-compat / regression
testing; in production every rollout (devnet, testnet, mainnet) uses
the same 60-day window.

Run the snapshot from `dkg-evm-module/` (default `--window-seconds`
is 60d = 5184000):

```bash
cd ../../dkg-evm-module   # adjust path to where the V8 module lives
export RPC_BASE_SEPOLIA_V10=<archival rpc>
npx ts-node scripts/snapshot_v8_eligibility.ts \
  --network base_sepolia \
  --concurrency 4
```

Outputs go to `snapshots/v8-eligibility-base_sepolia-<ts>.{csv,json}` plus
a sibling `-rich.csv` audit report.

Review the rich CSV before uploading. Fields to spot-check:

- `eligible=true` rows have `stakeEligibleForBonusTRAC > 0`.
- `reason` is human-readable and matches the `lastStakeChangeAt` /
  `windowStakeChanges` columns.
- A few sampled `(identityId, delegator)` pairs match what you expect
  from holding a stake position long enough on Base Sepolia.

---

## Phase 3 — upload to the registry

From `packages/evm-module/`:

```bash
# 1. Dry run — prints what would be uploaded, no transactions.
npx ts-node --esm scripts/upload_v8_eligibility.ts \
  --network base_sepolia_v10 \
  --csv ../../dkg-evm-module/snapshots/v8-eligibility-base_sepolia-<ts>.csv \
  --dry-run

# 2. Real run, larger chunks (Base Sepolia is cheap, but pace gas).
npx ts-node --esm scripts/upload_v8_eligibility.ts \
  --network base_sepolia_v10 \
  --csv ../../dkg-evm-module/snapshots/v8-eligibility-base_sepolia-<ts>.csv \
  --chunk 500
```

The script:

- Reads `deployments/base_sepolia_v10_contracts.json` for the registry
  address.
- Skips pairs already on chain (idempotent — safe to resume after a
  failed batch).
- Verifies `eligibleCount` equals `before + uploaded` at the end.

---

## Phase 4 — freeze the registry

DO NOT freeze until you've spot-checked at least 5 random rows from the
CSV with `cast call <REGISTRY> 'isEligible(uint72,address)' <id> <addr>`
and they all return `true`. Freeze is irreversible.

```bash
npx ts-node --esm scripts/upload_v8_eligibility.ts \
  --network base_sepolia_v10 \
  --csv ../../dkg-evm-module/snapshots/v8-eligibility-base_sepolia-<ts>.csv \
  --freeze
```

Verify:

```bash
cast call <REGISTRY> 'frozen()(bool)' --rpc-url $RPC_BASE_SEPOLIA_V10  # → true
```

---

## Phase 5 — exercise `selfMigrateV8`

For each of the test cases below, capture: `tokenId`, `expiryTimestamp`,
and the block timestamp at the migration tx. Compare:

```
expected default expiry = tsAtMigrate + tierDurationSeconds(tier)
expected with credit    = expected default expiry - 60 days  (5184000 seconds)
```

| Case | Eligible? | Tier | Expected `expiryShortenedBy` |
| --- | --- | --- | --- |
| A | yes | 12 | `60 days` (5184000s) |
| B | yes |  6 | `60 days` (5184000s) |
| C | yes |  3 | 0 (lower tier) |
| D | no  | 12 | 0 |

The contract requires the registry to be `frozen()` before any tier-6/12
migration tx — otherwise `selfMigrateV8` / `adminMigrateV8` revert with
`V8 eligibility not frozen`. Verify the freeze gate by attempting a
tier-12 migration BEFORE Phase 4 and confirming the revert.

`tierDurationSeconds`: tier 1 = 30d, tier 3 = 90d, tier 6 = 180d, tier 12 = 366d.

```bash
# Migrate from the test wallet.
cast send <DKG_NFT_ADDR> 'selfMigrateV8(uint72,uint40)' <identityId> <tier> \
  --rpc-url $RPC_BASE_SEPOLIA_V10 \
  --private-key <TEST_DELEGATOR_KEY>

# Look up the resulting token's expiry.
cast call <CSS_ADDR> 'getPosition(uint256)' <tokenId> \
  --rpc-url $RPC_BASE_SEPOLIA_V10
# expiryTimestamp is the third tuple field.
```

This is the same shape as the local devnet smoke test
(`scripts/devnet-credit-smoke.ts`), which you can re-run any time
against a fresh `hardhat node`.

---

## Rollback

If anything in phases 1–4 looks wrong **before freeze**, you can:

- Re-run `upload_v8_eligibility.ts` with a corrected CSV — already-on-chain
  entries are no-ops, additions are idempotent.
- If the wrong pair was added, redeploy the registry and start fresh
  (cheap on testnet; don't do this on mainnet).

After freeze, the registry is immutable. The only safety hatch is to
redeploy the entire registry contract (and re-run the rest of the
pipeline against the new address).

---

## Mainnet checklist

When testnet passes end-to-end, mirror Phases 1–5 on mainnet:

- Phase 1: the same "version bumps do NOT auto-redeploy" caveat applies —
  flip `deployed` to `false` for `ConvictionStakingStorage` and `StakingV10`
  in `deployments/base_mainnet_contracts.json` (not the `*_v10` file) before
  `npx hardhat deploy --network base_mainnet`, otherwise the bumped bytecode
  is skipped.
- Phase 2 default window = 60 days = `5,184,000` seconds (omit
  `--window-seconds`; literal is independent of the target network's
  `epochLength`).
- Phase 2 should be re-run as close to V10 launch as possible to keep
  the snapshot fresh (re-runs are idempotent — same CSV → same on-chain
  state).
- Phase 4 freeze immediately before V10's user-facing migration window
  opens.
