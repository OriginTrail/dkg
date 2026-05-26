# Testnet reset runbook (V10 RandomSampling + staking consolidation)

Procedure for resetting the DKG testnet (Base Sepolia) onto the V10-only
contract layout shipped in PR #357. Covers the three roles involved
(maintainer, contracts deployer, node operators) and what each one
actually has to do — most of the operator-facing pain is handled by the
daemon's built-in auto-update + supervised-restart.

The reset is the simplest cutover path because it lets us drop V8
`Staking` + `DelegatorsInfo` + the dual-store coupling completely
instead of running a wholesale state migration. Tradeoff: any node-side
state that references the old chain entities (oxigraph triple store,
publish journal, RandomSampling WAL) needs a one-time wipe per node
because the chain-side anchors no longer exist.

## What this resets and what it preserves

| Preserved | Reset |
|---|---|
| `Hub` contract address | Every other contract gets a new address |
| `Token` contract address | All on-chain stake / TRAC custody |
| Operator wallet keystore (same private key) | On-chain `identityId` for that wallet (re-derived clean by `ensureProfile`) |
| | All published Knowledge Collections + Context Graphs |
| | Per-node oxigraph store, publish journal, RandomSampling WAL |

Net effect for a core operator: same wallet, fresh on-chain identity
auto-derived on next boot, zero KCs to start, agent auto-stakes 50k TRAC
into a V10 NFT position via `ensureProfile`, prover idle until first KC
is published, score non-zero from the first proof period after that.

## Daemon auto-update is built-in (operators don't have to upgrade manually)

`packages/cli/src/daemon/auto-update.ts` + `daemon/lifecycle.ts:802-869` +
`cli.ts:163,210` implement a polling auto-update with supervised restart.
The testnet config (`network/testnet.json`) sets:

```json
"autoUpdate": {
  "enabled": true,
  "repo": "OriginTrail/dkg",
  "branch": "main",
  "checkIntervalMinutes": 5
}
```

### What each install mode polls (this matters for the cutover)

`isStandaloneInstall()` (config.ts) decides at boot which polling
backend the daemon uses, and the two backends look at completely
different remote sources:

| Install mode | Detect | Polls | Triggered by |
|---|---|---|---|
| **Standalone** (`npm install -g @origintrail-official/dkg`) | no monorepo ancestor on disk | `https://registry.npmjs.org/@origintrail-official/dkg` (`dist-tags.latest` + pre-release tags) | a new **npm publish** of `@origintrail-official/dkg` |
| **Monorepo** (operator runs from a git checkout) | monorepo ancestor present | `OriginTrail/dkg@main` via the GitHub commits API | a new **commit on `main`** of `OriginTrail/dkg` |

`network/testnet.json#autoUpdate.repo+branch` is **only** consulted by
the monorepo backend. Standalone daemons ignore it — they go straight
to npm. On testnet most operators run standalone, so **merge-to-main
alone does not roll the cutover out to them**: the npm publish is what
moves the standalone fleet.

After update on either backend, the daemon exits with
`DAEMON_EXIT_CODE_RESTART`; the CLI parent
(`runForegroundSupervisor` / background variant) catches that exit
code and respawns the daemon against the new code (or the new npm
version's code).

**Operators do nothing for the code update** — they only do the one-time
state wipe in Phase C, which is itself automatic.

## Phase A — Maintainer release (one-shot)

1. Make sure `network/<env>.json#chainResetMarker` is bumped to a fresh
   value in the PR that you're about to merge (suggested format:
   `<purpose>-<yyyy-mm-dd>`, e.g. `v10-rs-staking-consolidation-2026-04-30`).
   This is what triggers Phase C's auto-wipe on every operator's daemon
   AFTER they pick up the new code.
2. **Merge the PR to `main`**. This is the trigger for monorepo-install
   operators only — their daemons swap slots within ≤ 5 min and pick
   up both the new code and the new marker. **Standalone operators
   are NOT updated by this step** (see install-mode table above).
3. **Tag the merge commit and publish to npm.** This is what rolls the
   cutover out to the standalone-install majority on testnet. **Not
   optional** for a testnet reset — without it the chainResetMarker
   never reaches standalone fleets and Phase C doesn't fire.
   ```bash
   git tag v10.x.y
   git push origin v10.x.y
   ```
   The `release.yml` workflow builds binaries + creates the GitHub
   Release; the npm publish is a manual step per `docs/RELEASE.md`.
   Once the new npm version is up, standalone daemons pick it up on
   their next 5-min poll, run `npm install <pkg>@<version>` into the
   inactive slot, and swap.
4. (Optional helper) Operators who want to skip the wait and pull the
   update right now can run `dkg update` — same code path as the
   poll, just on demand. Works for both install modes.
5. From this point on (≤ 5 min after the npm version is up), all
   testnet nodes — standalone and monorepo alike — are running the
   new build with the bumped marker, and Phase C's auto-wipe has
   already fired during their respawn.

## Phase B — Contracts deploy (deployer)

The deploy helper at `packages/evm-module/utils/helpers.ts:148-162`
short-circuits on contracts whose `deployed: true` flag is set in the
network deployments JSON. To force a fresh deploy of every contract
except `Hub` and `Token`, edit the snapshot before running.

**Prerequisites — deployer environment:**
- `RPC_BASE_SEPOLIA_V10` — Base Sepolia RPC URL (only needed if the
  default `https://sepolia.base.org` is rate-limited / unhealthy).
- `EVM_PRIVATE_KEY_BASE_SEPOLIA_V10` — private key of the deployer EOA.
  Must hold the Base Sepolia ETH for ~45 deployment txs.

**Hub ownership:** `Hub.setAndReinitializeContracts` (the call that
registers all the new addresses in a single batch — see
`deploy/998_initialize_contracts.ts`) is gated by
`onlyOwnerOrMultiSigOwner`. Two paths:
- **Deployer EOA == Hub owner (or a MultiSig owner):** the deploy
  pipeline calls `setAndReinitializeContracts` directly at the end and
  you're done.
- **Deployer EOA is neither:** the deploy pipeline still emits the
  `newContracts` array to the console + saves the new addresses to
  the deployments JSON, but the final `setAndReinitializeContracts`
  tx will revert. Capture the JSON, hand it to whoever holds Hub
  ownership, and have them call `setAndReinitializeContracts` from
  their wallet (or queue it through the MultiSig UI).

**Deploy procedure:**

1. Open `packages/evm-module/deployments/base_sepolia_v10_contracts.json`.
2. For every entry **except** `Hub` and `Token`, set `deployed: false`:
   ```bash
   node -e '
     const fs = require("fs");
     const path = "packages/evm-module/deployments/base_sepolia_v10_contracts.json";
     const j = JSON.parse(fs.readFileSync(path, "utf8"));
     for (const [name, c] of Object.entries(j.contracts)) {
       if (name !== "Hub" && name !== "Token") c.deployed = false;
     }
     fs.writeFileSync(path, JSON.stringify(j, null, 4));
   '
   ```
   Do **not** commit this edit yet — it's a one-shot scratch state for
   the deploy run. The deploy pipeline rewrites the file with the new
   addresses + `deployed: true` flips back on each contract via
   `999_save_deployments.ts`, and *that* is the file you commit after
   the deploy lands successfully.
3. Run hardhat-deploy on Base Sepolia. **The hardhat network name is
   `base_sepolia_v10`** (matches the deployments JSON filename):
   ```bash
   pnpm --filter @origintrail-official/dkg-evm-module \
     exec hardhat deploy --network base_sepolia_v10
   ```
   The pipeline:
   - Skips `Hub` and `Token` (still `deployed: true`).
   - Deploys the other ~45 contracts (steps `003_*` → `055_*`).
   - Calls `Hub.setAndReinitializeContracts(newContracts, newAssetStorageContracts, contractsToReinitialize, [])` at the end (`998_initialize_contracts.ts`).
     If the deployer doesn't own Hub, this final tx reverts — see
     above for the manual fallback.
   - Writes the updated deployments JSON via `999_save_deployments.ts`.
4. After the addresses land in Hub, every node — even ones still
   running the old release — re-resolves the new addresses on its
   next contract call (per-call resolution for V10 staking contracts)
   or after its next restart (boot-cached contracts; auto-update will
   trigger this within ≤ 5 min anyway).
5. One-shot bootstrap from the Hub owner / MultiSig owner:
   - `DKGStakingConvictionNFT.finalizeMigrationBatch(currentEpoch)` to
     set the `v10LaunchEpoch` marker on `ConvictionStakingStorage`.
   - **No** `Hub.transferTokens(StakingStorage, newCSS)` is needed on a
     true reset — there is no V8 TRAC to drain (the V8 staking
     contracts are unregistered, the testnet starts empty).
6. Commit the rewritten `base_sepolia_v10_contracts.json` to `main` so
   subsequent operator clones / CI builds embed the correct addresses.

## Phase C — Per-node state wipe (automatic, no operator action)

**As of PR #357 this is fully automatic for every operator on a current
release.** The maintainer's `chainResetMarker` bump in Phase A is the
trigger.

What runs:

1. Operator's daemon picks up the new commit via auto-update (≤ 5 min).
2. Daemon respawns into the new code.
3. On boot, before the agent opens its store, the chain-reset hook
   (`packages/cli/src/daemon/chain-reset-wipe.ts`) compares the bundled
   `network.chainResetMarker` against the one persisted in
   `<dataDir>/.network-state.json`.
4. If they differ (or no marker is persisted yet — the rollout case) →
   wipe `store.nq` + `store.nq.tmp` + `random-sampling.wal` + every
   `publish-journal.*` file. Save the new marker. Continue boot.
5. Agent runs as normal — calls `hub.getContractAddress(...)` for every
   contract, finds no identity for this wallet on the fresh chain,
   auto-creates a profile via `Profile.createProfile`, auto-stakes 50k
   TRAC via `DKGStakingConvictionNFT.createConviction(identityId, 50_000e18, lockTier=1)`,
   mounts the RandomSampling prover bind (cores only), resumes auto-update polling.

What's preserved across the wipe:

- `wallets.json` (operator keystore — same wallet, same private key)
- `auth.token` (local API token)
- `config.json` (operator preferences)
- `node-ui.db` (dashboard chat history, notifications, slot history)
- `files/` (uploaded files queued for publishing)
- Auto-update markers (`.current-version`, `.update-pending.json`, etc.)

**Operators do nothing.** If you used to wipe state by hand on previous
testnet resets, you don't need to anymore — and doing so anyway is
harmless (the hook is idempotent).

**Manual escape hatch (rarely needed):** if the auto-wipe ever fails
(e.g. exotic data dir, permission denied), the daemon will log the
error and continue to boot with stale state. Operator can fall back to
the legacy procedure:

```bash
dkg stop
NODE_DATA_DIR="${DKG_HOME:-$HOME/.dkg}"
rm -rf \
  "$NODE_DATA_DIR/store.nq" \
  "$NODE_DATA_DIR/store.nq.tmp" \
  "$NODE_DATA_DIR/publish-journal."* \
  "$NODE_DATA_DIR/random-sampling.wal" \
  "$NODE_DATA_DIR/.network-state.json"
dkg start
```

**Why the wipe is needed at all** (whether auto or manual):
- Old `store.nq` references CG IDs and KC merkle roots that don't exist
  on the new chain. The agent will gossip them to peers; peers will
  attempt on-chain validation; validation fails; entries get dropped
  one by one. Faster + cleaner to wipe upfront than to rely on
  self-healing.
- Old `publish-journal.*` may carry idempotency keys that collide with
  fresh publish attempts.
- Old `random-sampling.wal` records challenges (epoch + period start
  block) from the old chain; the prover may try to resubmit a "stuck"
  challenge that doesn't exist on the new chain.

The keystore is intentionally preserved so the wallet identity stays
constant — operators don't have to re-fund their wallet, and the new
on-chain `identityId` is auto-derived on first start with no operator
intervention.

## Phase D — Smoke verification (any operator with publish authority)

After enough cores have come back online (≥ 2 for a meaningful
RandomSampling smoke), run the same E2E that gates the local devnet
smoke. This is normally run from a developer machine pointed at the
testnet's RPC + a node's API — NOT something each operator runs.

```bash
# From a checkout matching the deployed release tag:
HARDHAT_PORT=<base_sepolia_rpc_port_proxy> \
  RS_TIMEOUT=180 \
  ./scripts/devnet-test-random-sampling.sh
```

Expected output:
```
[rs-test] === Random Sampling devnet smoke: PASS ===
[rs-test]   on-chain solved:      true
[rs-test]   on-chain score:       <non-zero>
```

A non-zero score from `RandomSamplingStorage.getNodeEpochProofPeriodScore`
is the canonical "the consolidation works" signal. A zero score with
`solved=true` would point at the same V8/V10 stake-vault split we
chased on devnet — reach for `ConvictionStakingStorage.getNodeStakeV10`
and the `StakingV10` deploy address before anything else.

## Rollback

A reset is destructive — there's no real rollback path; "redeploy V8"
isn't really one. The conservative mitigation is to walk through Phase B
on a stage testnet first if there's any doubt; the smoke pins the V10
staking + RS pipeline in under a minute.

## Cross-references

- `packages/cli/src/daemon/chain-reset-wipe.ts` — the auto-wipe hook
  invoked in Phase C (no operator action needed).
- `packages/cli/src/daemon/auto-update.ts` — the polling auto-updater.
- `packages/cli/src/daemon/lifecycle.ts:735-781` — the
  `setInterval(runCheck, checkIntervalMs)` loop.
- `packages/cli/src/cli.ts:163,210` — the `DAEMON_EXIT_CODE_RESTART`
  catch in the supervisor.
- `packages/evm-module/utils/helpers.ts` — the deploy helper +
  short-circuit logic used in Phase B.
- `packages/chain/src/evm-adapter.ts:ensureProfile` — the auto-stake
  path each node runs at boot in Phase C.
- `scripts/devnet-test-random-sampling.sh` — the smoke test invoked
  in Phase D (works against any RPC + auth token, not devnet-only).
- `docs/RELEASE.md` — the npm + GitHub release process used in Phase A.
