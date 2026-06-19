# V8→V10 stake migration — testnet migration rehearsal (Base Sepolia)

Rehearse the V8→V10 **admin-push** migration on Base Sepolia using a **real
mainnet delegator's position** as the data shape. The protocol/admin drains
every wallet's V8 stake into migration credit (`adminDrainBatch`); the user only
signs `allocate`. There is no self-service `startMigration`.

## What this validates (and what's already covered)

| Layer | Where it's verified |
|---|---|
| Contract logic (drain → credit → allocate, universal 6/12 lock-credit, collateralization incl. D8 pending, tier-0 recovery) | ✅ 20 hardhat tests (`test/v10-pool-migration.test.ts`) |
| Deployed V8 StakingStorage exposes the exact drain interface | ✅ selector probe vs Base-mainnet `0x57307C87…` (all 7 selectors present, no drift) |
| The 12 `StakingV10.initialize()` deps exist on the freeze Hub | ✅ probe of Base freeze Hub `0x99Aa…` (only CSS missing — the new storage we deploy) |
| The migration **tooling** end-to-end: deploy → MINTER_ROLE vault funding → seed → set credit → **admin drain** (`adminDrainBatch`) → wallet-signed `allocate` (target ≠ source) → NFT mint, plus the tier-0 recover-to-wallet path | ✅ local `hardhat node` run with a **real mainnet position** (`0x<MAINNET_DELEGATOR>`, <N> TRAC) mirrored under a controlled wallet — see "Local end-to-end" below |
| **`allocate`'s tail against a REAL ~59-node active set** (sharding insert, `ask.recalculateActiveSet`) + registration on a live chain | ⬇️ **this Sepolia rehearsal** (or the anvil fork) — the one thing a fresh local/fixture deploy can't fake |

> A local mainnet-**fork** pre-flight (`scripts/fork-rehearsal.ts`) would catch
> the same `allocate`-tail breakage before spending testnet effort, but
> hardhat 2.28.6's bundled EDR cannot fork Base (no hardfork history for
> chainId 8453). It runs against an **anvil** fork instead — see the bottom
> section. If Foundry isn't installed, this Sepolia rehearsal is the gate.

## Prerequisites

- A **deployer key = Hub owner** for the testnet deployment (the deployer of a
  fresh deploy is automatically the Hub owner). Set as `accounts[0]` via
  `BASE_SEPOLIA_V10` in your `.env` (see `utils/network.ts`).
- A **delegator wallet you control** on Base Sepolia (`TARGET_PK`), funded with
  a little Sepolia ETH for gas. You cannot sign as a scanned mainnet address, so
  the real position is mirrored *under this wallet*.
- A Base **mainnet** RPC (read-only) to source the real position from.
- A real mainnet delegator to mirror. A known clean one (single position):
  `0x<MAINNET_DELEGATOR>` — a node, **<N> TRAC**,
  no pending withdrawal. (Found via DelegatorsInfo `0xbc50dAB30f…`.)

## Steps

### 1. Deploy the V10 stack (incl. the 3 migration contracts) to Base Sepolia

```bash
cd packages/evm-module
pnpm deploy:testnet     # hardhat deploy --network base_sepolia_v10
```

`base_sepolia_v10` sets `saveDeployments:false`, so **copy these addresses from
the deploy output** (you'll pass them to the next steps):
`Hub`, `StakingStorage`, `Token`, `DKGStakingConvictionNFT`.

### 2. Make sure an allocate target profile exists

`allocate(targetNode, …)` requires `targetNode` to be an **existing profile**.
A fresh deploy has none — create one (the `Profile.createProfile` path the
tests use in `test/helpers`, or reuse an existing Sepolia node id) and note its
`identityId`. The migration *source* node (3) is just seeded storage and needs
no profile; only the allocate *target* does.

### 3. Mirror the real mainnet position under your wallet + admin-drain

```bash
DELEGATOR=0x<MAINNET_DELEGATOR> \
TARGET_DELEGATOR=0x<your-testnet-wallet> \
SOURCE_RPC=https://<base-mainnet-rpc> \
SOURCE_STAKING_STORAGE=0x57307C87E95a372C5D94BCC372bb7304505A739D \
TARGET_HUB=0x<Hub> TARGET_SS=0x<StakingStorage> TARGET_TOKEN=0x<Token> \
TARGET_NFT=0x<DKGStakingConvictionNFT> \
CREDIT_SECONDS=6048000 \
npx hardhat run scripts/mirror-mainnet-delegator.ts --network base_sepolia_v10
```

This reads the delegator's real V8 stake from mainnet, seeds the same amounts
under `TARGET_DELEGATOR` on Sepolia, sets `convictionCreditSeconds` (70d, the
universal tier-6/12 lock-credit), and then **admin-drains** (`adminDrainBatch`)
the seeded stake into `TARGET_DELEGATOR`'s migration credit — so the wallet
starts with credit ready to allocate. The script asserts `accounts[0] ==
Hub.owner()` up front.

### 4. Allocate, signed by your wallet

The admin drain in step 3 already populated your migration credit, so the wallet
only allocates:

```bash
TARGET_NFT=0x<DKGStakingConvictionNFT> \
TARGET_PK=0x<your-testnet-wallet-private-key> \
TARGET_NODE=<existing profile id from step 2> \
LOCK_TIER=12 \
npx hardhat run scripts/migrate-as-wallet.ts --network base_sepolia_v10
```

Runs `allocate(targetNode, <full credit>, 12)`. (Use `LOCK_TIER=0` for an
immediately-withdrawable position — the recover-to-wallet path.)

### 5. Verify

The script prints: credited == seeded base, a minted conviction NFT owned by
your wallet, and remaining credit 0. Cross-check on a Base Sepolia explorer:
- `DKGStakingConvictionNFT.migrationCredit(you)` → 0
- `ownerOf(tokenId)` → your wallet
- `ConvictionStakingStorage.nodeStakeV10(targetNode)` increased by the amount

## Local end-to-end (no testnet, no Foundry) — validated

This exact flow was run on a local `hardhat node` and passed; use it to smoke
the tooling before spending Sepolia gas. It uses default hardhat accounts (so
the private keys are known: account[2] PK
`0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a`).

```bash
cd packages/evm-module
# 1. persistent dev node (environment=development → deployer gets MINTER_ROLE + 10M TRAC)
npx hardhat node --config hardhat.node.config.ts &        # serves 127.0.0.1:8545

# 2. deploy the migration stack to it (saveDeployments → scripts resolve via getContract)
npx hardhat deploy --network localhost --config hardhat.node.config.ts \
  --tags DKGStakingConvictionNFT,StakingV10,Profile

# 3. create an allocate-target profile (≠ the source node)
npx hardhat run scripts/create-profile.ts --network localhost --config hardhat.node.config.ts   # → IDENTITY_ID=1

# 4. mirror a real mainnet position under a wallet you control (reads mainnet, seeds + admin-drains locally)
DELEGATOR=0x<MAINNET_DELEGATOR> \
TARGET_DELEGATOR=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
SOURCE_RPC=https://<base-mainnet-rpc> \
SOURCE_STAKING_STORAGE=0x57307C87E95a372C5D94BCC372bb7304505A739D LAST_IDENTITY_ID=3 \
CREDIT_SECONDS=6048000 \
npx hardhat run scripts/mirror-mainnet-delegator.ts --network localhost --config hardhat.node.config.ts
# (getContract resolves addresses from deployments/localhost; TARGET_* overrides optional here)

# 5. allocate, signed by that wallet (step 4's mirror already admin-drained the credit)
TARGET_NFT=$(node -e "console.log(require('./deployments/localhost/DKGStakingConvictionNFT.json').address)") \
TARGET_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a \
TARGET_NODE=1 LOCK_TIER=12 \
npx hardhat run scripts/migrate-as-wallet.ts --network localhost --config hardhat.node.config.ts
```

Expected tail: `migrationCredit <N>` then `minted conviction NFT tokenId 1
→ owner 0x3C44…`, `remaining credit 0.0`.

## Optional: local mainnet-fork pre-flight (needs Foundry/anvil)

Highest fidelity, no testnet gas — runs the full flow against the **real
deployed** Base contracts + real stake + real active set:

```bash
# install Foundry once: https://getfoundry.sh  (curl -L https://foundry.paradigm.xyz | bash; foundryup)
anvil --fork-url https://<base-mainnet-rpc> --port 8545 &
npx hardhat run scripts/fork-rehearsal.ts --network localhost
```

`fork-rehearsal.ts` deploys the 3 contracts onto the forked freeze Hub
(`0x99Aa…`), wires them as the impersonated Hub owner, then has the Hub owner
**admin-drain** real delegator `0x<MAINNET_DELEGATOR>` (`adminMigrateToCredit`) and the
delegator `allocate(3, …, 12)` — asserting the drain/credit/collateralization/
mint invariants. This is the recommended gate before the live Sepolia run when
Foundry is available.
