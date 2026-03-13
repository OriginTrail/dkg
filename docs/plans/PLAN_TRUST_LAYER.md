# V9 Trust Layer — Implementation Plan

Full spec: [docs/SPEC_TRUST_LAYER.md](../SPEC_TRUST_LAYER.md)

## Target Deployment: Base Sepolia (Chain ID 84532)

V8 contracts are already deployed. V9 adds new contracts to the existing Hub.

| Network | Environment | Hub Address | Status |
|---------|-------------|-------------|--------|
| `base_sepolia_dev` | devnet | `0xE043daF4cC8ae2c720ef95fc82574a37a429c40A` | V8 live, V9 pending deploy |
| `base_sepolia_test` | testnet | `0xf21CE8f8b01548D97DCFb36869f1ccB0814a4e05` | V8 live, V9 pending deploy |

Deployment data from V8: `packages/evm-module/deployments/base_sepolia_{dev,test}_contracts.json`

Deploy V9 contracts into the existing Hub:
```bash
cd packages/evm-module
npx hardhat deploy --network base_sepolia_dev --config hardhat.config.ts --tags v9
```

Full deployment guide: [docs/setup/DEPLOY_BASE_SEPOLIA.md](../setup/DEPLOY_BASE_SEPOLIA.md)

---

## V8 Backward Compatibility Rules

These rules apply to every milestone:

1. **Never rename or modify V8 storage contracts.** `StakingStorage`, `KnowledgeCollectionStorage`, `DelegatorsInfo`, `ShardingTableStorage`, `ParanetsRegistry` keep their names, layouts, and on-chain addresses. `KnowledgeCollectionStorage` becomes **legacy** (read-only) — V9 writes go to the new `KnowledgeAssetsStorage`.
2. **Never reorder struct fields.** New fields are appended at the end of structs only.
3. **Prefer new mappings over struct changes.** `DelegatorsInfo` uses flat mappings — add new mappings for conviction lock data instead of modifying `DelegatorData`.
4. **Logic contracts can be renamed and replaced.** They're registered in the Hub and upgraded by deploying a new version. `KnowledgeAssets.sol` replaces `KnowledgeCollection.sol` in the Hub.
5. **New storage contracts are fine.** `KnowledgeAssetsStorage`, `ParanetStakingStorage`, `PublishingConvictionAccount` are entirely new — no migration needed.
6. **1-epoch (≈30-day) stakers see no change.** The conviction multiplier evaluates to exactly 1.0x for 1-epoch locks, preserving V8 reward rates. Epochs are 30 days (same as V8 mainnet).

### Storage Contract → Logic Contract Mapping

```
LEGACY storage (V8, read-only — not written by V9 logic):
KnowledgeCollectionStorage.sol          ←    (legacy reads only)

V8 storage (UNCHANGED, on-chain state):
StakingStorage.sol                      ←    Staking.sol (+ stakeWithLock)
DelegatorsInfo.sol (+ new mappings)     ←    Staking.sol
ShardingTableStorage.sol                ←    ShardingTable.sol (+ per-paranet views)
ParanetsRegistry.sol (+ appended fields)←    Paranet.sol (+ node allocation)
AskStorage.sol                          ←    Ask.sol (+ per-paranet pricing)
RandomSamplingStorage.sol               ←    RandomSampling.sol (+ per-paranet scoring)

NEW storage (no migration):
KnowledgeAssetsStorage.sol              ←    KnowledgeAssets.sol (clean V9 storage)
ParanetStakingStorage.sol               ←    Staking.sol / Paranet.sol
PublishingConvictionAccount.sol              (self-contained)
FairSwapJudge.sol                            (self-contained)
ProtocolTreasury.sol                         (self-contained, governed by Hub owner)
```

---

## Milestone 1: Foundation ✅ COMPLETED

**Goal**: Get V8 contracts building inside the V9 monorepo and wire up a basic EVM adapter that can replace the mock adapter.

### Tasks

1. ✅ **Copy V8 contracts** from `dkg-evm-module/` into `packages/evm-module/`
   - Copied `contracts/`, `deploy/`, `test/`, `hardhat.config.ts`, relevant config
   - Set up as `@origintrail-official/dkg-evm-module` in the pnpm workspace
   - `npx hardhat compile` succeeds, 295 V8 tests pass
2. ✅ **Basic EVMChainAdapter**
   - Implemented in `packages/chain/src/evm-adapter.ts`
   - ethers.js v6, reads contract ABIs from `@origintrail-official/dkg-evm-module`
   - Methods: `registerIdentity`, `listenForEvents`, contract resolution from Hub
3. ✅ **Mock-to-real verification**
   - Integration tests pass against local Hardhat node
   - Mock adapter preserved for unit tests

---

## Milestone 2: UAL Pre-minting ✅ COMPLETED

**Goal**: Publishers can reserve UAL ranges and batch-mint KAs with pre-assigned IDs.

### Tasks

1. ✅ **Create KnowledgeAssetsStorage.sol** (new storage contract)
   - `contracts/storage/KnowledgeAssetsStorage.sol` — clean V9 storage with publisher namespace tracking
   - `contracts/libraries/KnowledgeAssetsLib.sol` — structs and errors
   - Registered in Hub as `"KnowledgeAssetsStorage"` via `deploy/040_deploy_knowledge_assets_storage.ts`
2. ✅ **Create KnowledgeAssets.sol** (logic contract)
   - `contracts/KnowledgeAssets.sol` — forked from `KnowledgeCollection.sol`, rewired to `KnowledgeAssetsStorage`
   - `reserveUALRange`, `batchMintKnowledgeAssets`, `updateKnowledgeAssets`, `extendStorage`
   - Registered as `"KnowledgeAssets"` in Hub via `deploy/041_deploy_knowledge_assets.ts`
3. ✅ **Update ChainAdapter interface**
   - V9 methods: `reserveUALRange`, `batchMintKnowledgeAssets`, `updateKnowledgeAssets`, `extendStorage`
   - Both `EVMChainAdapter` and `MockChainAdapter` implement full V9 interface
4. ✅ **Update publisher**
   - V9 flow: `reserveUALRange → batchMintKnowledgeAssets`, namespaced UALs (`did:dkg:{chainId}/{pubId}/{kaId}`)
5. ✅ **Integration tests** (9 passing — test count updated in M2b)
   - V8+V9 co-deployment, UAL reservation, batch minting with real ECDSA signatures + TRAC payment, V8/V9 coexistence
   - 295 V8 tests + 28 publisher tests + 54 agent tests — zero regressions

---

## Milestone 2b: Publishing Stack Overhaul ✅ COMPLETED

**Goal**: Overhaul the V9 publishing stack to support address-based publishing, single-transaction convenience, namespace transfer, real P2P signature collection, two-phase metadata with on-chain provenance, and proper tentative-to-confirmed lifecycle.

### Changes

1. **Address-based publishing**: Removed `publisherIdentityId` from all contracts. `msg.sender` is the sole publisher namespace key. Any EVM address can reserve UAL ranges and publish — no identity/profile required.
   - `KnowledgeAssetsLib.sol`: Removed `publisherIdentityId` from `KnowledgeBatch` struct, updated errors to use `address`
   - `KnowledgeAssetsStorage.sol`: All mappings/functions keyed by `address` instead of `uint72`
   - `KnowledgeAssets.sol`: `reserveUALRange(count)` uses `msg.sender`, no identity param

2. **Single-transaction publish**: New `publishKnowledgeAssets(kaCount, ...)` function auto-reserves UAL range and mints batch in one call. Returns `(batchId, startKAId, endKAId)`.

3. **Namespace transfer**: New `transferNamespace(newOwner)` transfers all reserved ranges, batch ownership, and future IDs to a new address.

4. **TypeScript adapters**: Updated `ChainAdapter`, `EVMChainAdapter`, and `MockChainAdapter` with new interfaces. Added `OnChainPublishResult` with txHash, blockNumber, blockTimestamp, publisherAddress.

5. **Two-phase metadata**: 
   - Phase 1 (tentative): Generated at P2P broadcast with `dkg:status "tentative"`
   - Phase 2 (confirmed): Added after on-chain finalization with transaction hash, block number, publisher address, batch ID, chain ID

6. **P2P signature flow**: `PublishHandler` now performs merkle verification, UAL consistency checks, and produces real ECDSA signatures. 10-minute tentative timeout for unconfirmed publishes.

7. **Protobuf updates**: `PublishRequestMsg` includes `publisherAddress`, `startKAId`, `endKAId`, `chainId`.

### UAL Format Change

```
V9 (M2):   did:dkg:{chainId}/{publisherIdentityId}/{localKAId}
V9 (M2b):  did:dkg:{chainId}/{publisherAddress}/{localKAId}
```

### What Changed
- `KnowledgeAssetsLib.sol`, `KnowledgeAssetsStorage.sol`, `KnowledgeAssets.sol` — address-based API
- `chain-adapter.ts`, `evm-adapter.ts`, `mock-adapter.ts` — new interfaces
- `metadata.ts` — two-phase metadata generation
- `dkg-publisher.ts` — address-based UALs, OnChainPublishResult
- `publisher.ts` — status + onChainResult in PublishResult
- `publish.ts` — protobuf schema updates
- `publish-handler.ts` — merkle verification, ECDSA signatures, tentative lifecycle

### What Doesn't Change
- V8 contracts untouched
- Core node identity system unchanged (identities still used for signature verification)
- Staking, paranets, FairSwap — all unchanged

---

## Milestone 3: Publishing Conviction Account

**Goal**: Publishers who lock TRAC long-term get discounted publishing fees. Flat discount based on initial lock.

### Tasks

1. **Implement PublishingConvictionAccount.sol** (entirely new contract)
   - Self-contained: manages its own state (no external storage contract)
   - Functions: `createAccount`, `addFunds`, `extendLock`, `addAuthorizedKey`, `removeAuthorizedKey`, `coverPublishingCost`, `withdraw`
   - **Flat** discount formula: `conviction = lockedTRAC × initialLockEpochs`, `discount = maxDiscount × conviction / (conviction + C_half)` where `C_half = 3,000,000`
   - Discount does NOT decay with remaining lock time — fixed for duration
   - Locked TRAC is the spending balance — each publish deducts from it at the discounted rate
   - Register in Hub
2. **Wire into KnowledgeAssets.sol**
   - `batchMintKnowledgeAssets` accepts optional `convictionAccountId`
   - If provided: calls PCA's `coverPublishingCost` which applies discount
   - If not: direct TRAC transfer at full price (existing Paymaster path still works)
   - Publishing cost = `stakeWeightedAverageAsk × publicByteSize × epochs / 1024` (public bytes only)
3. **Update EVM adapter**
   - Add `createConvictionAccount`, `getConvictionDiscount`, `addConvictionFunds`, `extendConvictionLock` methods
   - Update `batchMintKnowledgeAssets` to accept conviction account
4. **Deploy script** for PCA
5. **Gas coverage (stretch goal)**: Explore ERC-4337 paymaster integration so PCA can cover gas fees for authorized keys

### What Changes

- New contract: `PublishingConvictionAccount.sol`
- `KnowledgeAssets.sol` updated to accept PCA
- ChainAdapter interface extended

### What Doesn't Change

- V8 Paymaster still works (not removed, just supplemented)
- All storage contracts untouched
- Publishing without conviction account works exactly as before

---

## Milestone 4: Staking Conviction

**Goal**: Stakers who lock for longer earn up to 3x rewards. V8's 1-epoch (30-day) baseline = 1x.

### Tasks

1. **Add lock tracking to DelegatorsInfo.sol** (new mappings only, no struct changes)
   ```solidity
   mapping(uint72 => mapping(address => uint40)) public delegatorLockEpochs;
   mapping(uint72 => mapping(address => uint40)) public delegatorLockStartEpoch;
   ```
   - `DelegatorsInfo` already uses flat mappings (not structs), so appending is safe
2. **Add `stakeWithLock` to Staking.sol** (logic contract, upgradeable)
   - `stakeWithLock(uint72 identityId, uint96 amount, uint40 lockEpochs)`
   - Existing `stake()` calls `stakeWithLock(id, amount, 1)` — V8-compatible default (1 epoch ≈ 30 days ≈ V8's 28-day delay)
   - Lock validation: cannot withdraw until `lockStartEpoch + lockEpochs`
   - Can extend lock, can add more stake with same or longer lock
3. **Implement conviction multiplier** in reward calculation
   - In `claimDelegatorRewards`: compute `multiplier(originalLockEpochs)` using formula (flat — uses original lock, not remaining)
   - Apply as `effectiveScore = baseScore × multiplier`
   - Formula:
     - `lockEpochs == 0`: `multiplier = 0`
     - `lockEpochs >= 1`: `min(3.0, 1 + (18/7) × (lockEpochs - 1) / (lockEpochs - 1 + 22/7))`
   - Fixed-point: K = 18/7 scaled to 1e18, H = 22/7 scaled to 1e18, cap = 3e18
   - Calibration targets: 1 epoch = 1x, 3 epochs = 2x, 12 epochs = 3x
4. **Update EVM adapter**
   - Add `stakeWithLock` method
   - Update `stake` to call `stakeWithLock` with 1-epoch default
5. **Migration**: Existing V8 stakers are treated as having 1-epoch lock (1x multiplier). No on-chain migration needed — the new Staking logic checks if lock data exists, and if not, uses 1-epoch default.

### What Changes

- New mappings appended to `DelegatorsInfo.sol`
- `Staking.sol` logic updated (deployed as upgrade)
- `ChainAdapter` interface extended

### What Doesn't Change

- `StakingStorage.sol` struct layouts untouched
- `DelegatorsInfo.sol` existing mappings untouched
- Existing delegator scores, rewards, withdrawal requests all preserved
- 1-epoch stakers earn exactly the same as before

---

## Milestone 5: Paranet Sharding (Option A — Allocate from Existing Stake)

**Goal**: Nodes allocate portions of their stake to specific paranets. Rewards, pricing, scoring, and challenges are all per-paranet.

### Design: Option A

- Each node allocates portions of total stake to paranets
- Minimum total stake: 50K TRAC per node (no minimum per paranet)
- Reallocation cooldown: 1 epoch (30 days)
- System paranets (`agents`, `ontology`): same mechanics as all other paranets (no exemptions). `dkg init` auto-subscribes as a client convenience.
- Unallocated stake: earns from global pool (10% of all fees) only
- **No paranet operator fee** — operators participate by running nodes and allocating stake

### Tasks

1. **Create ParanetStakingStorage.sol** (entirely new storage contract)
   ```solidity
   mapping(uint72 => mapping(bytes32 => uint96)) public paranetStakeAllocations;
   mapping(uint72 => mapping(bytes32 => uint40)) public lastReallocationEpoch;
   mapping(uint72 => uint96) public totalAllocatedStake;
   mapping(bytes32 => uint96) public totalParanetStake;
   mapping(bytes32 => uint72[]) public paranetNodeList;
   ```
   - No changes to existing `StakingStorage` — allocations are tracked separately
2. **Add paranet staking to Staking.sol**
   - `stakeToParanet(uint72 identityId, bytes32 paranetId, uint96 amount)`
   - `unstakeFromParanet(uint72 identityId, bytes32 paranetId, uint96 amount)` (with 1-epoch cooldown)
   - Validation: `totalAllocatedStake[id] <= nodes[id].stake`
   - Validation: `totalStake[id] >= 50K` (minimum per node, no per-paranet minimum)
3. **Per-paranet sharding table**
   - Extend `ShardingTable.sol` to query per-paranet node lists from `ParanetStakingStorage`
   - Node appears in paranet's table if it has any allocation to that paranet
   - Keep global sharding table intact for backward compat
4. **Per-paranet ask pricing in Ask.sol**
   - `recalculateParanetActiveSet(bytes32 paranetId)`: computes ask from paranet's allocated nodes
   - Existing global `recalculateActiveSet()` unchanged (used for global pool pricing)
5. **Per-paranet scoring in RandomSampling.sol**
   - Challenges run every proof period (30 minutes), scoped to paranet
   - Node score tracked per-paranet: `nodeParanetScore[identityId][paranetId]`
   - Conviction multiplier applied: `effectiveScore = nodeParanetScore × convictionMultiplier`
6. **Reward distribution**
   - Publishing fee split: 85% paranet pool, 10% global, 5% protocol treasury (no operator fee)
   - Per-paranet epoch pool in `EpochStorage` (new mapping, appended)
7. **ProtocolTreasury.sol** (new contract)
   - Accumulates 5% of publishing fees and 5% of FairSwap sales
   - Governed by Hub owner (withdrawal, parameter adjustment)
8. **Update Paranet.sol**
   - Add `getParanetNodes`, `getParanetTotalStake` views
9. **Update EVM adapter and ChainAdapter**
   - `stakeToParanet`, `unstakeFromParanet`, `getParanetStake`, `getParanetNodes`

### What Changes

- New contracts: `ParanetStakingStorage.sol`, `ProtocolTreasury.sol`
- Logic contracts updated: `Staking.sol`, `ShardingTable.sol`, `Ask.sol`, `RandomSampling.sol`, `Paranet.sol`
- `ParanetsRegistry.sol`: fields appended to `Paranet` struct
- `EpochStorage`: new mapping for per-paranet pools

### What Doesn't Change

- `StakingStorage.sol` layout untouched (allocations tracked in new contract)
- `ShardingTableStorage.sol` layout untouched (per-paranet views computed from ParanetStakingStorage)
- Global sharding table, global ask, global rewards all still work for unallocated stake / global pool
- Existing paranet data in `ParanetsRegistry` preserved

---

## Milestone 5b: FairSwap Judge (Private Knowledge Exchange)

**Goal**: Enable trustless exchange of private knowledge between agents using the FairSwap protocol.

### Tasks

1. **Implement FairSwapJudge.sol** (entirely new contract)
   - Buyer calls `initiatePurchase` (deposits TRAC)
   - Seller calls `fulfillPurchase` (commits encrypted data root + key commitment)
   - Seller calls `revealKey` (publishes decryption key)
   - Buyer calls `disputeDelivery` if data doesn't match (O(log n) merkle proof)
   - Timeout-based resolution: if buyer doesn't dispute, seller claims payment
   - 5% protocol fee → `ProtocolTreasury`, 95% → seller
   - Reuses KC merkle roots from `KnowledgeAssetsStorage` (V9) or `KnowledgeCollectionStorage` (legacy V8)
   - Register in Hub
2. **Update ChainAdapter interface**
   - Add `initiatePurchase`, `fulfillPurchase`, `revealKey`, `disputeDelivery`, `claimPayment` methods
3. **Update EVM adapter**
4. **Integration with x402**: The FairSwap flow can be triggered via x402 payment requests

> **Note**: Detailed protocol flow (timeouts, encoding scheme, proof structure) follows the [FairSwap paper](https://eprint.iacr.org/2018/740.pdf) and will be fully specified during implementation.

### What Changes

- New contract: `FairSwapJudge.sol`
- ChainAdapter interface extended

### What Doesn't Change

- All existing contracts untouched
- Publishing flow unchanged — FairSwap is a separate, opt-in flow for private knowledge

---

## Milestone 5c: Permanent Publishing (Arweave-style)

**Goal**: Enable "publish forever" by paying a one-time fee allocated across 100 epochs with declining distribution.

### Tasks

1. **Add permanent publishing to KnowledgeAssets.sol**
   - `batchMintKnowledgeAssetsPermanent(kaIds, merkleRoot, paranetId)`
   - Cost = `annualCost × ENDOWMENT_MULTIPLIER` (default 10, governance-adjustable)
   - Tokens pre-allocated across 100 epochs with geometric decay (`0.97^i`)
2. **Implement per-paranet endowment pool** (new storage or extend EpochStorage)
   - Each epoch: release pre-allocated amount as rewards for nodes storing permanent KAs
   - After 100 epochs: storage becomes part of base-layer commitment (marginal cost → 0)
3. **Update EVM adapter and ChainAdapter**
4. **Governance**: `ENDOWMENT_MULTIPLIER` adjustable by Hub owner

### What Changes

- `KnowledgeAssets.sol` updated with new function
- New endowment pool mappings
- ChainAdapter interface extended

### What Doesn't Change

- Standard time-limited publishing works exactly as before
- All existing storage contracts untouched

---

## Milestone 5d: Knowledge Updates and Storage Extension ✅ COMPLETED (in M2)

**Goal**: Publishers can update KCs (new merkle root) and extend storage duration.

Implemented as part of Milestone 2 — `updateKnowledgeAssets` and `extendStorage` are already in `KnowledgeAssets.sol` and the `ChainAdapter` interface.

### Implemented

1. ✅ `updateKnowledgeAssets(batchId, newMerkleRoot, newPublicByteSize)` — publisher-only, 10% fee if size ≤ original, full rate on excess
2. ✅ `extendStorage(batchId, additionalEpochs, tokenAmount, paymaster)` — extends storage duration with additional TRAC
3. ✅ `ChainAdapter.updateKnowledgeAssets()` and `ChainAdapter.extendStorage()` in both adapters

---

## Milestone 6: V9 Integration and Deployment

**Goal**: Wire everything into the V9 TypeScript layer and deploy to Base Sepolia.

### Target Chain: Base Sepolia (Chain ID 84532)

V8 contracts already deployed:
- **Devnet Hub**: `0xE043daF4cC8ae2c720ef95fc82574a37a429c40A`
- **Testnet Hub**: `0xf21CE8f8b01548D97DCFb36869f1ccB0814a4e05`

V9 deployment adds `KnowledgeAssets` + `KnowledgeAssetsStorage` to the existing Hub via `--tags v9`.

### Tasks

1. **Update publisher** (`packages/publisher/src/dkg-publisher.ts`)
   - ✅ Full chain integration: reserve UALs → publish → finalize on-chain (done in M2)
   - Support conviction account for discounted publishing
   - Support permanent publishing
   - FairSwap integration for selling private knowledge
2. **Update agent** (`packages/agent/src/dkg-agent.ts`)
   - `stakeToParanet()`, `unstakeFromParanet()`
   - `createConvictionAccount()`, `fundConvictionAccount()`
   - Chain-aware paranet creation (registers on-chain)
   - Event listener for on-chain confirmations
   - `buyPrivateKnowledge()` — initiates FairSwap flow
3. **Update CLI** (`packages/cli/src/cli.ts`)
   - `pnpm dkg stake <node> <amount> [--lock <epochs>]`
   - `pnpm dkg stake paranet <paranet> <amount>`
   - `pnpm dkg conviction create <amount> <lock-epochs>`
   - `pnpm dkg conviction info`
   - `pnpm dkg chain status` (show connected chain, contract addresses, epoch)
   - `pnpm dkg publish --permanent` (permanent publishing option)
   - `pnpm dkg update <kc-id> <file>` (knowledge update)
   - `pnpm dkg extend <kc-id> <epochs>` (storage extension)
4. **Update network config** (`network/testnet.json`)
   - Add `chain.rpcUrl`, `chain.hubAddress`, `chain.chainId`
   - Point at Base Sepolia devnet Hub (`0xE043daF4cC8ae2c720ef95fc82574a37a429c40A`)
5. **Deploy V9 to Base Sepolia**
   - Run `npx hardhat deploy --network base_sepolia_dev --config hardhat.config.ts --tags v9`
   - Requires Hub owner private key (same wallet that deployed V8)
   - V9 contracts register in the existing Hub alongside V8
   - Verify: `Hub.getContractAddress("KnowledgeAssets")` returns non-zero
   - Full guide: [docs/setup/DEPLOY_BASE_SEPOLIA.md](../setup/DEPLOY_BASE_SEPOLIA.md)
6. **End-to-end verification on Base Sepolia**
   - init → register identity → reserve UALs → publish → query → verify on-chain state
7. **Update docs**
   - Update `docs/setup/JOIN_TESTNET.md` with chain setup steps
   - Update `docs/SPEC_TRUST_LAYER.md` with deployed addresses

---

## Multi-Chain Portability (EVM + Solana)

All design decisions preserve Solana portability:

- **ChainAdapter interface is chain-agnostic**: `string` for account IDs, `bigint` for amounts, `Uint8Array` for signatures
- **Economic formulas are spec-level math**: documented in [SPEC_TRUST_LAYER.md](../SPEC_TRUST_LAYER.md), not embedded in Solidity
- **No EVM imports leak into publisher/agent/CLI**: all chain interaction through the adapter
- **UAL format is chain-aware**: `did:dkg:{chainId}/...` disambiguates across chains

A future Milestone 7 (Solana) would:

- Implement Anchor programs mirroring EVM contract logic
- Create `SolanaChainAdapter` implementing the same `ChainAdapter` interface
- Require zero changes to publisher, agent, or CLI code
