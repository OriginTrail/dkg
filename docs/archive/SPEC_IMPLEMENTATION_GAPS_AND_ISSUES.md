# DKG V9 — Spec vs Implementation Gaps and Issues

This document summarizes gaps between [SPEC_TRUST_LAYER.md](./SPEC_TRUST_LAYER.md) and the current implementation, and lists identified issues, mocks, and bugs.

---

## 1. Spec vs Implementation Gaps

### 1.1 ChainAdapter interface (Spec §11)

The **spec** defines a full `ChainAdapter` with:

- **Publishing**: `reserveUALRange`, `publishKnowledgeAssets`, `batchMintKnowledgeAssets`, `updateKnowledgeAssets`, `extendStorage`, `transferNamespace` ✅ *Implemented*
- **Staking**: `stakeWithLock`, `stakeToParanet` ❌ *Not in ChainAdapter interface or EVM adapter*
- **Publishing Conviction Account**:
  - `createConvictionAccount(amount, lockEpochs)`
  - `coverPublishingCost(accountId, baseCost)`
  ❌ *Not in interface or implementation*
- **FairSwap (private knowledge)**:
  - `initiatePurchase`, `fulfillPurchase`, `revealKey`, `disputeDelivery`, `claimPayment`
  ❌ *Not in interface or implementation*

**Implementation status**: The TypeScript `ChainAdapter` in `packages/chain/src/chain-adapter.ts` and `EVMChainAdapter` implement only publishing + paranet placeholders. Staking conviction, PCA, and FairSwap are planned in PLAN_TRUST_LAYER (Milestones 3, 4, 5, 5b) but not yet implemented.

---

### 1.2 EVM Paranet integration

- **Spec**: Publishing targets a paranet; pricing is per-paranet (`stakeWeightedAverageAsk` per paranet).
- **Implementation**:
  - `KnowledgeAssets.sol` uses `askStorage.getStakeWeightedAverageAsk()` (likely global ask), not a per-paranet ask.
  - `createParanet` and `submitToParanet` in the EVM adapter **throw** with "not yet implemented on EVM adapter (Milestone 5)".
- **Gap**: Paranet-scoped publishing and per-paranet pricing are not wired in the EVM flow; paranet operations on real chain are stubs.

---

### 1.3 Contracts not yet implemented (per plan)

| Contract / feature              | Spec reference | Status |
|---------------------------------|----------------|--------|
| **PublishingConvictionAccount** | §6             | Not implemented (Milestone 3) |
| **FairSwapJudge**               | §5             | Not implemented (Milestone 5b) |
| **ProtocolTreasury**           | §9, §10        | Not implemented (Milestone 5) |
| **Staking conviction**         | §7 (`stakeWithLock`, multiplier) | Not implemented (Milestone 4) |
| **Paranet staking**             | §8 (allocate stake to paranets) | Not implemented (Milestone 5) |
| **Permanent publishing**       | §4 (`batchMintKnowledgeAssetsPermanent`) | Not implemented (Milestone 5c) |

---

### 1.4 Reward and fee split (Spec §9)

- **Spec**: Publishing fee → 85% paranet pool, 10% global pool, 5% protocol treasury. No paranet operator fee.
- **Implementation**: `KnowledgeAssets.sol` and `ParanetIncentivesPool.sol` use different fee/oracle logic (e.g. operator/voter percentages). The exact 85/10/5 split and ProtocolTreasury are not clearly implemented as specified.

---

### 1.5 Address-based publishing (V9.1)

- **Spec**: Any EVM address can reserve UAL ranges and publish; no on-chain identity required for the publisher; `msg.sender` is the namespace key.
- **Implementation**: Contracts use `msg.sender` for namespace and reservation. TypeScript still passes `publisherNodeIdentityId` and `receiverSignatures` for **storage agreement** (nodes that will store data). This is consistent with the spec (core node identities are for signature verification only).

---

## 2. Bugs and Incorrect Behavior

### 2.1 Agent `broadcastPublish`: hardcoded UAL and chainId (BUG)

**File**: `packages/agent/src/dkg-agent.ts` (around lines 581–596)

When the agent broadcasts a `PublishRequest` after publishing:

- **UAL** is hardcoded to `did:dkg:mock:31337/...` (or `did:dkg:mock:31337/${result.kcId}` when no on-chain result).
- **chainId** is set to `''`.

So even when using a real EVM chain (e.g. Base Sepolia), the P2P message contains a mock UAL and empty chainId. Receiving nodes will then:

- See the wrong UAL format for the actual chain.
- Have `expectedChainId` empty in `PublishHandler`, which can break confirmation matching and verification.

**Fix**: Use the adapter’s chain ID and build UAL from it and `onChainResult`:

- `ual`: `did:dkg:${this.chain.chainId}/${onChain.publisherAddress}/${onChain.startKAId}` (and analogous for the fallback case).
- `chainId`: `this.chain.chainId`.

---

### 2.2 ~~Publisher handler: optional on-chain range check not implemented~~ (FIXED)

**File**: `packages/publisher/src/publish-handler.ts`

Receivers now verify that the claimed `publisherAddress` owns the UAL range `startKAId..endKAId` when a chain adapter with `verifyPublisherOwnsRange` is configured. The optional `ChainAdapter.verifyPublisherOwnsRange(publisherAddress, startKAId, endKAId)` is implemented on `MockChainAdapter` (in-memory ranges) and `EVMChainAdapter` (via `KnowledgeAssetsStorage.getPublisherRangesCount` / `getPublisherRange`). If the check returns false, the handler rejects with a clear reason.

---

## 3. Mocks and Test-Only Code

### 3.1 MockChainAdapter

- **Location**: `packages/chain/src/mock-adapter.ts`
- **Usage**: Used across publisher, agent, and chain tests to avoid a real chain.
- **Note**: This is intentional for unit/integration tests. The EVM adapter is used for real chain (e.g. `evm-e2e.test.ts`).

### 3.2 Hardcoded `mock:31337` in tests and agent

- Tests and the **agent** (see bug above) use `mock:31337` for UAL/chainId when no real chain is used. In the agent this is incorrect when a real chain adapter is configured.

### 3.3 NoChainAdapter

- **Location**: `packages/chain/src/no-chain-adapter.ts`
- **Purpose**: All methods throw; used when the node is configured without a chain (e.g. read-only or testing). Documented as “NOT a mock” and is appropriate.

---

## 4. TODOs and Deferred Work (from codebase)

| Location | TODO / comment |
|----------|-----------------|
| `packages/publisher/src/publish-handler.ts` | Query chainAdapter to verify publisherAddress owns startKAId..endKAId |
| `packages/evm-module/utils/helpers.ts` | Reinitialize only if any dependency contract was redeployed |
| `packages/evm-module/test/integration/Paranet.test.ts` | Fund the pools and check rewards |
| `packages/evm-module/test/integration/Staking.test.ts` | Fix manual reward calculation — delegator accumulates score across multiple proof periods |
| `packages/evm-module/test/unit/RandomSamplingStorage.test.ts` | Fails because hubOwner is not a multisig (setW1/setW2 access control tests commented out) |
| `packages/evm-module/test/unit/RandomSampling.test.ts` | Test access control when multisig is properly set up; test fails because hub owner is not the multisig |
| `packages/evm-module/contracts/libraries/RandomSamplingLib.sol` | Smaller data structure for chunkId |
| `packages/evm-module/contracts/paranets/Paranet.sol` | “Why is this 1 element array” (expectedAccessPolicies) |
| `packages/evm-module/contracts/paranets/ParanetIncentivesPool.sol` | Should there be some check of this value? |

---

## 5. Implemented and Aligned with Spec

- **UAL format**: `did:dkg:{chainId}/{publisherAddress}/{localKAId}` — implemented in contracts and publisher.
- **Reserve + batch mint**: `reserveUALRange`, `batchMintKnowledgeAssets`, `publishKnowledgeAssets` (single-tx) — implemented.
- **Updates and extension**: `updateKnowledgeAssets` (10% rule for size), `extendStorage` — implemented.
- **Namespace transfer**: `transferNamespace` — implemented.
- **Tentative → confirmed lifecycle**: 10-minute timeout (`TENTATIVE_TIMEOUT_MS = 10 * 60 * 1000`), promotion on chain event — implemented.
- **Two-phase metadata**: Tentative vs confirmed metadata with provenance — implemented.
- **V8 compatibility**: Legacy storage and events preserved; V9 uses new KnowledgeAssetsStorage.

---

## 6. Recommended Next Steps

1. ~~**Fix agent UAL/chainId bug**~~ ✅ Done: `broadcastPublish` now uses `this.chain.chainId` for UAL and `chainId` in the PublishRequest.
2. ~~**Implement on-chain range check**~~ ✅ Done: `verifyPublisherOwnsRange` on ChainAdapter; handler rejects when publisher does not own the range.
3. **Implement missing ChainAdapter methods**: As per PLAN_TRUST_LAYER milestones: staking conviction, PCA, FairSwap, and paranet operations on EVM.
4. **Clarify fee split**: Implement or document the 85/10/5 split and ProtocolTreasury in line with the spec.
5. **Resolve TODOs**: Address the listed TODOs (multisig/hub owner tests, reward calculation, Paranet.sol/ParanetIncentivesPool comments) as part of normal cleanup and test hardening.
