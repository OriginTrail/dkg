# DKG V9 Trust Layer Specification

We are entering an era of billions of AI agents. These agents will need to coordinate with each other — just as humans do — and coordination is impossible without shared knowledge: common facts, common definitions, and common truths. The Decentralized Knowledge Graph (DKG) is the infrastructure that provides this.

The Trust Layer is the blockchain component of the DKG. It creates the economic and cryptographic guarantees that make a shared knowledge network possible among agents that don't trust each other, operated by parties that may have competing interests.

This document explains the full design — from first principles through contract-level details — so that anyone can understand how and why it works, regardless of blockchain experience.

---

## Table of Contents

1. [The Knowledge Problem for AI Agents](#1-the-knowledge-problem-for-ai-agents)
2. [Why a Trust Layer?](#2-why-a-trust-layer)
3. [Core Concepts](#3-core-concepts)
4. [Publishing Knowledge](#4-publishing-knowledge)
5. [Buying Private Knowledge (FairSwap)](#5-buying-private-knowledge-fairswap)
6. [Publishing Conviction Accounts](#6-publishing-conviction-accounts)
7. [Staking and Conviction](#7-staking-and-conviction)
8. [ContextGraphs: Network Sharding](#8-contextGraphs-network-sharding)
9. [Scoring and Rewards](#9-scoring-and-rewards)
10. [Contract Architecture](#10-contract-architecture)
11. [Multi-Chain Support](#11-multi-chain-support)
12. [V8 Compatibility](#12-v8-compatibility)

---

## 1. The Knowledge Problem for AI Agents

### Agents need to coordinate

The world is moving toward massive multi-agent systems — not a single superintelligent model, but millions of specialized agents running on behalf of different people, organizations, and machines. A personal finance agent managing your portfolio. A supply-chain agent optimizing shipping routes. A research agent synthesizing scientific papers. A medical agent cross-referencing drug interactions.

These agents will need to work together. A supply-chain agent needs to know current tariff rates published by a trade compliance agent. A medical agent needs drug interaction data curated by a pharmaceutical research agent. A personal assistant needs to verify a restaurant recommendation from a local knowledge agent.

This is the coordination problem: **agents operated by different parties, with different goals, need to agree on shared facts and exchange knowledge reliably.** Without a common knowledge layer, every agent is an island — it can only act on what it personally knows, and has no way to discover, verify, or build on what other agents have learned.

### No agent can know everything

The total body of human knowledge is vast and growing exponentially. No single agent — no matter how powerful — can store and maintain a copy of everything. It's not just a storage problem; it's an economics problem. Running a large language model costs money. Storing embeddings costs money. Keeping datasets up to date costs money.

The practical solution is the same one humanity uses: **specialization and shared infrastructure**. Agents specialize in domains (climate data, legal precedent, market analysis, medical literature) and contribute their knowledge to a shared, queryable network. Any agent can find and access what it needs without duplicating the work of every other agent.

This is what the DKG provides — a **sharded knowledge database for AI agents**, partitioned into domain-specific contextGraphs (knowledge channels), where each agent contributes what it knows and queries what it needs.

### Shared knowledge must be verifiable

A shared knowledge layer only works if you can trust it. When one agent publishes a fact ("this drug interacts with that one"), other agents need to know:
- **Who published it?** Is it a reputable pharmaceutical research agent, or an anonymous unknown?
- **Has it been tampered with?** Is the data the same as what was originally published?
- **Is it actually being stored?** If I publish knowledge and pay for 1 year of storage, is the network actually keeping its promise?

In a centralized system (like a corporate database), these guarantees come from the operator. In a decentralized system with no operator, they must come from **cryptography and economics** — which is exactly what the Trust Layer provides.

### Public knowledge and private monetization

Not all knowledge should be free. An agent that spends hours analyzing satellite imagery, curating a dataset, or running expensive model inference has produced something valuable. The DKG supports both models:

**Public knowledge** is visible to everyone on the network. Any subscribed node stores it, any agent can query it. This is how agent profiles, skill directories, shared ontologies, and common reference data work — the "shared truths" that enable coordination.

**Private knowledge** is the agent's competitive edge. The public triples act as a storefront — they describe *what* the agent knows (e.g., "I have high-resolution climate analysis for Q4 2025"). The private triples contain the actual data. Other agents can discover the asset, verify it exists and hasn't been tampered with (via merkle proofs), and then pay to access it.

This private knowledge monetization aligns with the [x402 protocol](https://x402.org) — the HTTP-native payment standard where agents pay for resources programmatically. An agent discovers a knowledge asset on the DKG, sends an access request with payment (x402-style, using stablecoins or TRAC), and receives the private triples. The entire flow is autonomous — no accounts, no subscriptions, no human intervention.

The Trust Layer is what makes all of this possible. Without it, there's no way to guarantee that:
- Published knowledge hasn't been tampered with
- Storage nodes are actually keeping the data they promised to keep
- A buyer receives authentic, complete private triples after payment
- Contributors are compensated fairly for the value they provide

---

## 2. Why a Trust Layer?

The DKG is a peer-to-peer network run by independent operators with different incentives. Some run nodes for profit. Some are agents publishing knowledge for their users. Some may be adversarial. The core problems:

1. **Why would anyone store someone else's knowledge?** Storage costs money. Without compensation, rational nodes would free-ride — claiming to store data but discarding it to save resources.
2. **How do you prevent tampering?** A node could silently modify stored knowledge, serve outdated data, or selectively omit triples. In a decentralized network, there's no admin to audit.
3. **How do you ensure availability?** If a publisher pays for 1 year of storage, the knowledge must actually be available for 1 year — even if individual nodes come and go.
4. **How do you enable trusted exchange?** When an agent pays for private knowledge, it needs a guarantee that what it receives is exactly what was originally published — not a subset, not a modification.

The Trust Layer solves these with three mechanisms:

- **Economic commitment**: Publishers pay tokens to store knowledge. Storage nodes stake tokens as collateral. Both sides have skin in the game. If a node fails to honor its commitments, it earns no rewards — and the staked capital represents a real opportunity cost.
- **Cryptographic verification**: Every piece of published knowledge is hashed into a merkle tree. The root hash is recorded on a blockchain — an immutable, shared ledger. Anyone can verify that a node is storing exactly what was published — no more, no less. This is critical for private knowledge: buyers can verify they received the complete, unmodified dataset by checking the merkle proof against the on-chain commitment.
- **Incentive alignment**: Nodes that reliably store data and respond to proof challenges earn rewards proportional to their commitment. Nodes that fail earn nothing. The longer and more capital you commit, the more you earn. This creates a self-sustaining economy where it's more profitable to be honest than to cheat.

The blockchain acts as a shared, tamper-proof ledger that everyone agrees on. It doesn't store the actual knowledge (that would be too expensive and defeat the purpose of sharding) — it stores commitments (hashes) and manages the token economics that keep the network honest.

---

## 3. Core Concepts

### Knowledge Assets (KAs)

A Knowledge Asset is the atomic unit of knowledge in the DKG. It's an entity and all the RDF triples where that entity is the subject. For example, an AI agent that analyzed satellite imagery might publish a KA representing its analysis — with triples describing what region was analyzed, what methodology was used, a summary of findings (public), and the full dataset (private, available for purchase).

Each KA has a globally unique identifier called a **UAL** (Uniform Asset Locator). V9 uses publisher-namespaced UALs:

```
did:dkg:base:84532/0xA1B2...C3D4/42
        │     │         │        └─ Local KA ID (from publisher's reserved range)
        │     │         └────────── Publisher address (msg.sender)
        │     └──────────────────── Chain ID
        └────────────────────────── DKG method
```

Because UALs are namespaced per publisher **address**, IDs never collide across publishers. Publisher `0xA1B2`'s KA 42 is completely independent of Publisher `0xC3D4`'s KA 42.

KAs can contain both **public triples** (visible to everyone on the network) and **private triples** (stored only on the publisher's node, but their existence is provable via merkle proofs).

### Batch Minting

Publishers don't create one KA at a time. They batch-mint multiple KAs in a single blockchain transaction. This is more gas-efficient and mirrors how knowledge is naturally published (a dataset contains many entities).

The batch has a single merkle root on-chain that covers all KAs:

```
KC Merkle Root (on-chain)
├── KA 1 Root
│   ├── Public Root (hash of public triples)
│   └── Private Root (hash of private triples)
├── KA 2 Root
│   ├── Public Root
│   └── Private Root
└── KA 3 Root
    ├── Public Root
    └── Private Root
```

### ContextGraphs

A contextGraph is a domain-specific partition of the DKG. Think of it as a "channel" or "namespace" for knowledge. Examples: a "memes" contextGraph, an "AI research" contextGraph, a "climate data" contextGraph.

ContextGraphs matter because not every node can or should store all knowledge in the DKG. Nodes choose which contextGraphs to participate in, staking tokens to back their commitment. This is how the network scales — by sharding knowledge across contextGraphs.

### Epochs

Time on the DKG is measured in **epochs** (1 epoch = 30 days). Epochs are used for:
- Pricing knowledge storage ("store for 12 epochs" = 1 year)
- Distributing rewards to nodes
- Lock durations for staking and publishing conviction
- Scheduling proof challenges
- Reallocation cooldowns for contextGraph stake

### TRAC Token

TRAC is the utility token of the DKG. It flows in a cycle that powers the agent knowledge economy:

1. **Agents publish** — spend TRAC to commit knowledge on-chain and pay for network storage
2. **Tokens flow to reward pools** — distributed across epochs, scoped per contextGraph
3. **Storage nodes earn** — by reliably storing data, passing proof challenges, and serving queries
4. **Delegators participate** — stake TRAC to nodes they trust and earn a share of rewards
5. **Agents monetize** — other agents pay (TRAC or stablecoins via x402) to access private knowledge assets, creating a self-sustaining knowledge marketplace

---

## 4. Publishing Knowledge

### The Problem with Sequential IDs

In DKG V8, knowledge assets get their IDs from an on-chain counter that increments with each transaction. This means publishers must wait for their transaction to confirm before knowing their UAL. Other nodes must watch blockchain events to discover new content.

### Pre-minted UALs with Publisher Namespaces

V9 introduces **publisher-namespaced UAL ranges**. Instead of getting IDs one at a time, a publisher reserves a block of IDs up front:

```
Publisher A (0xA1B2...) reserves range [1..1000]
Publisher B (0xC3D4...) reserves range [1..500]

Publisher A's UALs:  did:dkg:base:84532/0xA1B2.../1
                     did:dkg:base:84532/0xA1B2.../2
Publisher B's UALs:  did:dkg:base:84532/0xC3D4.../1
```

Each publisher has their own namespace. IDs never collide across publishers.

**Why this matters:**
- Publishers can construct UALs immediately, without waiting for chain confirmation
- Nodes can verify a UAL's validity by checking: "does this publisher own this ID range?" — a simple on-chain lookup, no event scanning needed
- Enables offline-first publishing: prepare your KAs, pre-assign UALs, then batch-finalize on-chain when ready

Because ranges are namespaced per publisher key, they don't interfere with each other — Publisher A's ID 42 is completely independent of Publisher B's ID 42. The gas cost of the `reserveUALRange` transaction is sufficient to prevent squatting (no additional TRAC fee). Unused ranges **do not expire** — once reserved, those IDs belong to the publisher permanently.

> **Address-based publishing (V9.1)**: Any EVM address can reserve UAL ranges and publish — no on-chain identity or node profile is required. This enables edge nodes and lightweight agents to publish directly using their wallet address. Core node identities are only needed for signature verification (storage agreement). The `reserveUALRange` function takes only a `count` parameter; `msg.sender` is the namespace key.

### Publishing Flow

```
1. Reserve     Publisher calls reserveUALRange(count) on-chain
               → msg.sender's address is the namespace key
               → Gets back startId..endId

2. Prepare     Off-chain: assign KA IDs from reserved range,
               compute merkle tree (public + private roots per KA)

3. Broadcast   Send PublishRequest via GossipSub to subscribed contextGraph nodes
               → Nodes store public triples as TENTATIVE

4. Finalize    Publisher calls batchMintKnowledgeAssets on-chain
               with pre-assigned KA IDs, merkle root, token payment,
               storage duration (in epochs), target contextGraph

5. Confirm     Nodes observe on-chain event, verify merkle root matches
               → Triples become CONFIRMED and queryable by all
```

### Single-Transaction Publish

For convenience, V9 also offers `publishKnowledgeAssets` — a single-transaction function that auto-reserves a UAL range and mints the batch in one call. This simplifies the flow for publishers who don't need pre-minted UALs:

```
1. Prepare     Off-chain: compute merkle tree, collect node signatures
2. Publish     Call publishKnowledgeAssets(kaCount, ...) on-chain
               → Auto-reserves range, mints batch, returns (batchId, startKAId, endKAId)
3. Confirm     Nodes observe on-chain event, verify merkle root
```

### Namespace Transfer

A publisher can transfer their entire UAL namespace to a new address via `transferNamespace(newOwner)`. All reserved ranges, batch ownership, and future ID allocation move to the new owner. The old address loses all publishing rights. This enables key rotation and organizational handoffs without losing published knowledge.

### Tentative Data

Between steps 3 and 5, the data is in a **tentative** state:

- **Publisher's own node** can query tentative data immediately — the publisher trusts their own data and benefits from instant access while waiting for chain finalization.
- **Other nodes** store the data but do **not** serve it in query results until the on-chain finalization event arrives. This prevents unverified (or potentially fraudulent) data from polluting query results across the network.
- **10-minute timeout**: If no on-chain finalization event is observed within 10 minutes of receiving the broadcast, nodes discard the tentative data. This prevents nodes from accumulating unfinalized garbage data from misbehaving publishers.

> **Two-phase metadata**: When publishing, nodes generate metadata in two phases. **Phase 1 (tentative)** metadata is created at P2P broadcast time and includes `dkg:status "tentative"`, publisher peer ID, local timestamp, contextGraph, merkle root, and KA count. **Phase 2 (confirmed)** metadata is added after on-chain finalization and includes `dkg:status "confirmed"`, transaction hash, block number, authoritative chain timestamp, publisher address, batch ID, and chain ID. This provides a complete audit trail from initial broadcast to on-chain settlement.

### Knowledge Updates

A publisher can update a Knowledge Collection by submitting a **new merkle root** on-chain:

```solidity
function updateKnowledgeAssets(
    uint64 kcId,
    bytes32 newMerkleRoot,
    uint64 newPublicByteSize
) external;
```

**Update pricing:** Updates follow the same cost formula as initial publishing. However, if the new public byte size is **less than or equal to** the originally paid allocation, only a **10% fee** is charged (covering the cost of re-verification and re-distribution, but not full storage since the space was already paid for). If the new size exceeds the original allocation, the publisher pays the full rate for the excess bytes.

```
if newPublicByteSize <= originalPublicByteSize:
    updateCost = originalCost × 10%
else:
    updateCost = originalCost × 10% + fullRate × (newPublicByteSize - originalPublicByteSize) × remainingEpochs
```

The new merkle root replaces the old one. Nodes receive the updated triples via GossipSub (same tentative → confirmed flow as initial publishing). Old triples **may** be kept in a historical store but are not required to be — this is a node operator decision. The on-chain record reflects only the current version. The storage duration does not reset — updates apply to the remaining epochs of the original commitment.

### Storage Duration, Expiry, and Extension

When publishing, the publisher specifies the **storage duration** in epochs (1 epoch = 30 days). The cost covers this period.

- **After expiry**: Nodes **may** delete the data to free storage, but they may also choose to keep it if they consider it valuable (e.g., frequently queried data). The on-chain commitment remains as a permanent record regardless.
- **Extension**: A publisher can extend storage at any time by calling `extendStorage(kcId, additionalEpochs)` and paying the corresponding fee. This extends the window during which nodes are obligated (and incentivized) to store and serve the data.

### Permanent Publishing (Arweave-style)

For knowledge that should persist indefinitely, V9 offers a **permanent publishing** option modeled on the economic insight behind [Arweave](https://arweave.org): storage costs decline over time as hardware improves.

The core assumption: if the cost of storing 1 KB per year is $X today, it will be $X × (1 - declineRate) next year, $X × (1 - declineRate)² the year after, and so on. The sum of this infinite geometric series is finite:

```
permanentCost = annualCost / declineRate
```

With a conservative projected decline rate of 10% per year:

```
permanentCost = annualCost × ENDOWMENT_MULTIPLIER
ENDOWMENT_MULTIPLIER = 10  (governance-adjustable)
```

Rather than an open-ended endowment pool, the tokens are **pre-allocated across 100 epochs** (~8.3 years) with a **declining distribution** — early epochs receive more TRAC, later epochs receive less. This models the assumption that storage costs decrease over time, so less compensation is needed in the future.

```
Epoch distribution (geometric decay):
  epoch_share(i) = totalPayment × weight(i) / sum(weights)
  weight(i) = decayFactor ^ i       (e.g., decayFactor = 0.97)
```

After 100 epochs, the storage obligation becomes part of the network's base layer — nodes continue storing permanent KAs as part of their general commitment to the network, since the marginal cost approaches zero as storage technology improves.

```solidity
function batchMintKnowledgeAssetsPermanent(
    uint64[] calldata kaIds,
    bytes32 merkleRoot,
    bytes32 contextGraphId
) external;
```

Permanent KAs cannot expire. They are stored for as long as the network exists. The endowment multiplier is governance-adjustable — if storage cost decline accelerates (e.g., due to new storage technologies), the multiplier can be lowered for future publications.

### Publishing Cost

The cost to publish is:

```
cost = stakeWeightedAverageAsk × publicByteSize × epochs / 1024
```

Where:
- `stakeWeightedAverageAsk` is the contextGraph's price per KB per epoch, determined by the asks of active nodes weighted by their stake in that contextGraph
- `publicByteSize` is the size of the **public** triples only — private triples are not factored into cost because they stay on the publisher's node and do not burden the network's storage
- `epochs` is the storage duration (in 30-day epochs)

Tokens are distributed across the storage duration — each epoch gets its share of the payment, which is then distributed to nodes as rewards.

---

## 5. Buying Private Knowledge (FairSwap)

### The Problem

A buyer agent discovers a Knowledge Asset with private triples (the public triples describe what's available — e.g., "high-resolution market analysis for Q4 2025"). The buyer wants to pay and receive the private data. But in a decentralized system:

- The buyer can't pay first — the seller might take the money and never deliver.
- The seller can't deliver first — the buyer might take the data and never pay.
- A trusted middleman defeats the purpose of decentralization.

### The Solution: FairSwap Protocol

V9 uses the [FairSwap protocol](https://eprint.iacr.org/2018/740.pdf) — a cryptographic fair exchange protocol where a smart contract acts as an impartial judge, but only needs to do O(log n) work in the worst case.

The key insight: it's much cheaper to prove that someone *cheated* than to prove they were *honest*. The contract only gets involved if there's a dispute, and even then it only needs to verify a single merkle proof — not the entire dataset.

### How It Works (High-Level)

```
1. Initiate     Buyer calls initiatePurchase on the FairSwap judge contract,
                depositing payment (TRAC). References the KC/KA on-chain.

2. Fulfill      Seller encrypts private triples with key k, sends encrypted
                data to buyer off-chain, and commits c = H(k) to the contract.

3. Reveal       Seller publishes key k to the contract.
                Buyer decrypts and verifies against the on-chain merkle root.

4a. Accept      If valid (or timeout with no dispute): contract pays seller.
4b. Dispute     If invalid: buyer submits O(log n) proof of misbehavior.
                Contract verifies and refunds buyer.
```

A 5% protocol fee is deducted from the payment. The remaining 95% goes to the seller.

> **Note**: The detailed FairSwap protocol flow (timeouts, exact encoding scheme, proof structure) follows the [FairSwap paper](https://eprint.iacr.org/2018/740.pdf) and will be fully specified during implementation. The key property: dispute resolution costs O(log n) on-chain regardless of data size.

### Why FairSwap Fits DKG Perfectly

The DKG already commits a merkle root for every Knowledge Collection on-chain (during the publishing step). This merkle root covers both public and private triples. The FairSwap judge contract can reuse this existing on-chain commitment from `KnowledgeAssetsStorage` (or legacy `KnowledgeCollectionStorage` for V8 assets) — no additional setup needed.

The verification predicate φ(x) = 1 iff:
> "The received private triples, combined with the already-known public triples, produce a merkle root matching the on-chain commitment for this KC."

This means:
- **No new trust assumptions** — the merkle root was committed during publishing, long before the sale
- **Efficient disputes** — only a O(log n) merkle proof needs to go on-chain, even for gigabyte-scale private datasets
- **Atomic exchange** — either the buyer gets exactly what was committed and pays, or gets refunded
- **x402 compatible** — the buyer agent initiates the FairSwap flow via an x402 payment request, making the entire process autonomous

### Fee Split for Private Knowledge Sales

```
Private knowledge sale →
  95% → Seller (the publisher who owns the private triples)
   5% → Protocol treasury
```

Unlike publishing fees (which fund storage node rewards), private knowledge sales are direct value exchange between agents. The protocol takes a 5% fee for the treasury, and the seller receives the rest. There is no contextGraph pool or global pool cut — storage nodes are already compensated via the original publishing fees.

### Contract Interface

```solidity
function initiatePurchase(
    uint64 kcId,
    uint64 kaId,
    uint96 price
) external;                                                // called by buyer

function fulfillPurchase(
    uint256 purchaseId,
    bytes32 encryptedDataRoot,
    bytes32 keyCommitment
) external;                                                // called by seller

function revealKey(uint256 purchaseId, bytes32 key) external;  // called by seller
function disputeDelivery(uint256 purchaseId, bytes calldata proof) external;  // called by buyer
function claimPayment(uint256 purchaseId) external;        // seller claims after timeout
function claimRefund(uint256 purchaseId) external;         // buyer claims if seller no-shows
```

---

## 6. Publishing Conviction Accounts

### The Idea

Regular publishers pay the full network price for every batch. But publishers who are serious about the network — who commit significant capital long-term — should get better rates. This is similar to how cloud providers give volume discounts, but enforced by a smart contract.

A **Publishing Conviction Account** (PCA) is a funding pool where:
- An **admin** deposits TRAC and locks it for a duration (in epochs)
- **Authorized keys** (the admin's agents, team members, or bots) can spend from the pool to publish knowledge
- The locked TRAC **is the spending balance** — each publish deducts from it (at the discounted rate). When depleted, the account can no longer publish until `addFunds` is called
- The locked tokens cannot be *withdrawn* until the lock expires, but they *are* spent as publishing fees flow to reward pools
- The longer and larger the lock, the bigger the discount on publishing fees
- The conviction (and thus discount) is computed from the **initial deposit and lock duration** at creation time (or last extension/top-up), not from the current balance

### Discount Formula

The discount is based on **conviction** — a measure of commitment. The discount is **flat**: it's determined by the initial lock duration and amount at the time of creation (or last extension), **not** by remaining lock time. This eliminates the decay cliff that would otherwise incentivize publishers to constantly re-lock, and makes the economics predictable for the entire lock duration.

```
conviction = lockedTRAC × initialLockEpochs

discount = maxDiscount × conviction / (conviction + C_half)
```

- `maxDiscount` = 50% (governance-adjustable)
- `C_half` = 3,000,000 (calibration constant for 30-day epochs)

This is an asymptotic formula: conviction grows linearly, but the discount approaches the cap with diminishing returns.

**Example scenarios:**

| Locked TRAC | Lock Duration        | Conviction | Discount |
|-------------|----------------------|------------|----------|
| 100K        | 6 epochs (6 months)  | 600K       | ~8%      |
| 500K        | 6 epochs (6 months)  | 3M         | 25%      |
| 1M          | 12 epochs (1 year)   | 12M        | **40%**  |
| 2M          | 24 epochs (2 years)  | 48M        | 47%      |
| 5M          | 36 epochs (3 years)  | 180M       | 49.2%    |

**Key behaviors:**
- Discount is fixed for the lock duration — no decay, fully predictable publishing costs
- Multiple authorized keys can share one pool — useful for organizations running multiple agents
- The contract replaces the V8 `Paymaster` with richer economics
- Extending the lock or adding funds recalculates the conviction and may increase the discount

### Gas Coverage (Goal)

Ideally, the PCA should also cover **gas fees** for authorized keys, so that agents publishing knowledge don't need to hold the chain's native token (ETH, SOL, etc.) separately. This would work similarly to ERC-4337 paymasters or Solana fee payers — the PCA contract or a companion relay pays gas on behalf of the publisher, deducting from the locked TRAC balance (converted at an oracle rate).

This is a stretch goal that depends on the target chain's account abstraction support. On EVM chains with ERC-4337, this is feasible. On chains without native account abstraction, a meta-transaction relay can approximate it.

### Contract Interface

```solidity
function createAccount(uint96 amount, uint40 lockEpochs) external;
function addFunds(uint96 amount) external;
function extendLock(uint40 additionalEpochs) external;
function addAuthorizedKey(address key) external;
function removeAuthorizedKey(address key) external;
function coverPublishingCost(uint96 baseCost) external;  // applies flat discount
function withdraw(uint96 amount) external;                // only after lock expires
```

---

## 7. Staking and Conviction

### Basic Staking

To participate in the DKG as a storage node, you must stake TRAC. Staking is the node's collateral — a promise that it will behave honestly. If a node fails to store data or pass challenges, it doesn't earn rewards (and eventually gets removed from the network).

Anyone can **delegate** TRAC to a node they trust. Delegators earn a share of the node's rewards, proportional to their stake. Node operators take a configurable fee (0–100%) from the node's gross rewards before distributing to delegators.

### Conviction Multiplier

In V8, all stakers have a flat 28-day withdrawal delay. There's no incentive to commit for longer. V9 introduces a **conviction multiplier**: the longer you lock your stake, the more rewards you earn per token.

The multiplier is based on the **original lock duration** (not remaining time) — just like the PCA's flat discount. Once you lock for 12 epochs, you earn 3x for the entire lock period. This makes rewards predictable and avoids the need to constantly re-lock.

The multiplier is a piecewise function with 1 epoch (30 days, ≈ V8's 28-day baseline) as the reference point:

**Below 1 epoch** — no rewards (you must commit at least 1 epoch):
```
multiplier = 0
```

**1 epoch and above** — asymptotic growth from 1x toward 3x, hard-capped at 3x:
```
multiplier = min(3.0,  1 + (18/7) × (lockEpochs - 1) / (lockEpochs - 1 + 22/7))
```

| Lock Duration          | Epochs | Multiplier | What This Means |
|------------------------|--------|------------|-----------------|
| 0 (no lock)            | 0      | 0.00x      | No rewards — you must commit |
| **1 month**            | **1**  | **1.00x**  | **V8 baseline** — same as today |
| 2 months               | 2      | 1.62x      | 62% bonus for doubling commitment |
| **3 months**           | **3**  | **2.00x**  | Double rewards |
| 6 months               | 6      | 2.58x      | Approaching the cap |
| 9 months               | 9      | 2.85x      | Diminishing returns |
| **1 year**             | **12** | **3.00x**  | **Maximum** — triple rewards |
| 2+ years               | 24+    | 3.00x      | Cap reached, no additional benefit |

**Why this matters:**
- V8 stakers who migrate to V9 with 1-epoch (≈28-day) locks see zero change in their reward rate
- Operators who commit for a year earn 3x more per token — a massive incentive to lock
- Uncommitted stakers (0 lock) earn nothing, reducing sell pressure and volatility
- The cap at 3x prevents infinite advantage for extremely long locks

### How It Works On-Chain

```solidity
function stakeWithLock(uint72 identityId, uint96 amount, uint40 lockEpochs) external;
```

- The existing `stake()` function becomes `stakeWithLock(id, amount, 1)` — backward compatible (1 epoch ≈ V8's 28-day delay)
- Locked stake cannot be withdrawn until the lock expires
- Locks can be extended but not shortened
- The multiplier is applied when calculating the delegator's share of epoch rewards:

```
effectiveScore = baseScore × convictionMultiplier(originalLockEpochs)
```

The multiplier uses `originalLockEpochs` (the duration set when the lock was created or last extended), not remaining time. This means conviction-locked stakers earn a stable, predictable share of the epoch pool without needing to re-lock. The pool size stays the same — the multiplier just shifts rewards toward committed participants.

---

## 8. ContextGraphs: Network Sharding

### The Problem

If every node stores every piece of knowledge in the DKG, the network doesn't scale. A node on a Raspberry Pi can't store petabytes of data. We need a way to divide the network into manageable pieces.

### The Solution: ContextGraph-Scoped Staking (Option A)

Each node has a **total stake** and allocates portions of it to specific contextGraphs. The stake allocation is the node's commitment to store and serve knowledge for that contextGraph.

```
Node with 500K TRAC total stake:
  ├── 100K allocated to "agents" (system contextGraph)
  ├── 50K allocated to "ontology" (system contextGraph)
  ├── 200K allocated to "memes"
  ├── 100K allocated to "ai-research"
  └── 50K unallocated (earns from global pool only)
```

**Rules:**
- **Minimum total stake**: 50K TRAC per node to participate in the network at all. There is **no minimum per contextGraph** — a node can allocate any portion of its stake to any contextGraph, enabling small operators to participate in many contextGraphs without artificial barriers.
- **Reallocation cooldown**: 1 epoch (30 days) between reallocations (prevents yield farming and flash-allocation attacks)
- **System contextGraphs** ("agents", "ontology") follow the **same mechanics** as all other contextGraphs — nodes must explicitly allocate stake to participate. This keeps the economics uniform and avoids special-casing. During `dkg init`, the default configuration auto-subscribes nodes to system contextGraphs, but this is a client convenience — not a protocol-level exemption.
- **Unallocated stake** earns a small yield from the global pool (10% of all network fees)

### Why Allocation Creates a Healthy Market

This design creates a market where capital flows toward valuable knowledge:

**The virtuous cycle:**
1. A popular contextGraph has lots of publishers paying fees → large reward pool
2. Nodes notice the high yield and allocate stake to it → more security
3. More nodes means lower prices (more competition) → attracts more publishers
4. The contextGraph grows and becomes more reliable

**The natural correction:**
1. A dead contextGraph has no publishers → no fees → no rewards
2. Nodes reallocate their stake to productive contextGraphs
3. The dead contextGraph effectively shuts down (no data loss, just no active hosting)

**The niche equilibrium:**
1. A niche contextGraph has few publishers but specialized demand
2. Few nodes participate → higher prices → only committed publishers stay
3. Small but sustainable: the few nodes earn enough to justify hosting

### Per-ContextGraph Sharding Table

Each contextGraph has its own sharding table — a sorted list of nodes (by hash ring position) that are allocated to it. A node appears in a contextGraph's sharding table only if it has allocated at least the minimum stake.

This means:
- Publishing to a contextGraph is validated against that contextGraph's node set
- Challenges are scoped per contextGraph — nodes prove they store *that contextGraph's* data
- A node can participate in multiple contextGraphs simultaneously

### Per-ContextGraph Pricing

Each contextGraph has its own stake-weighted average ask price, computed from the asks of nodes allocated to it:

```
contextGraphPrice = sum(nodeAsk × nodeStakeInContextGraph) / sum(nodeStakeInContextGraph)
```

ContextGraphs with many competitive nodes have lower prices. Niche contextGraphs with few nodes are more expensive. The market sets the price.

### Cross-ContextGraph Queries

Although contextGraphs are separate storage partitions, agents can query across multiple contextGraphs using standard SPARQL mechanisms:

- **`FROM` clause**: A node that is subscribed to multiple contextGraphs can answer queries spanning them by specifying multiple named graphs:
  ```sparql
  SELECT ?agent ?meme WHERE {
    GRAPH <did:dkg:context-graph:agents> { ?agent a erc8004:Agent }
    GRAPH <did:dkg:context-graph:memes> { ?meme dkg:publishedBy ?agent }
  }
  ```
- **`SERVICE` keyword**: For contextGraphs hosted on different nodes, SPARQL federation allows delegating sub-queries to remote endpoints:
  ```sparql
  SELECT ?agent ?skill WHERE {
    GRAPH <did:dkg:context-graph:agents> { ?agent erc8004:hasCapability ?skill }
    SERVICE <dkg://contextGraph:ai-research> { ?paper dkg:author ?agent }
  }
  ```

Cross-contextGraph queries work naturally because all contextGraphs use the same RDF model and shared ontologies. A node can only answer queries for contextGraphs it has allocated stake to (and therefore stores data for). Federation via `SERVICE` enables queries that span contextGraphs across different nodes.

---

## 9. Scoring and Rewards

### Where Rewards Come From

When a publisher pays to store knowledge, the TRAC is split:

```
Publishing fee →
  85% → ContextGraph epoch pool (for nodes hosting this contextGraph)
  10% → Global network pool (for all stakers, proportional to total stake)
   5% → Protocol treasury (funds ongoing development and maintenance)
```

There is **no contextGraph operator fee**. ContextGraph operators (creators/curators) participate by running nodes and allocating stake — earning rewards through the same meritocratic mechanisms as everyone else. This prevents rent-seeking by operators who create contextGraphs just to extract fees without contributing storage or availability.

The **protocol treasury** is a multisig-controlled address that accumulates 5% of all publishing fees network-wide. These funds are reserved for future protocol development, audits, bug bounties, and ecosystem grants. The treasury percentage is governance-adjustable.

The contextGraph epoch pool is distributed to nodes at the end of each epoch based on their **node score**.

### Node Score Formula

Within each contextGraph, a node's score is:

```
nodeContextGraphScore(t) = S(t) × (c + 0.86 × P(t) + 0.60 × A(t) × P(t))
```

Where:
- `S(t) = sqrt(nodeStakeInContextGraph / contextGraphStakeCap)` — stake factor (sublinear, so whales can't dominate)
- `P(t)` = publishing share (fraction of proofs successfully submitted in recent epochs)
- `A(t) = 1 - |nodeAsk - contextGraphPrice| / contextGraphPrice` — ask alignment (rewarding competitive pricing)
- `c = 0.002` — baseline coefficient (ensures minimal reward even for new nodes)

The **conviction multiplier** stacks on top:

```
effectiveScore = nodeContextGraphScore × stakingConvictionMultiplier
```

A node that stakes 200K to "memes", locks for 1 year (3x multiplier), submits all proofs, and has a competitive ask will earn significantly more than a node with the same stake but no lock and spotty proof submission.

### Proof Challenges

To earn rewards, nodes must prove they're actually storing the data. Challenges run every **proof period (30 minutes)**, not once per epoch — ensuring continuous verification throughout the 30-day epoch. This follows the same pattern as the existing `RandomSampling` contracts on the Cronos deployment.

Each proof period:

1. On-chain randomness (derived from block hashes) selects a random Knowledge Asset from the contextGraph
2. A random chunk of that KA is requested
3. The challenged node must provide the chunk and a merkle proof that it's part of the committed KA within the proof window

A node's proof score `P(t)` is the fraction of successfully answered challenges over the epoch. At the end of each epoch, rewards are distributed based on accumulated proof scores. Nodes that consistently respond earn full rewards; nodes with gaps earn proportionally less.

### Per-ContextGraph Stake Cap

To prevent a single whale from dominating a contextGraph's rewards through stake alone, there's a **per-contextGraph stake cap**. The `sqrt()` in the stake factor ensures diminishing returns: doubling your stake only gives you ~1.41x the stake component, not 2x. This means actual performance (proofs and ask alignment) matters as much as capital.

---

## 10. Contract Architecture

### The Hub Pattern

All DKG contracts are registered in a central **Hub** contract. The Hub is a key-value store mapping contract names to addresses:

```
Hub
├── "KnowledgeAssets" → 0xA1B2...
├── "Staking" → 0xC3D4...
├── "ContextGraph" → 0xE5F6...
├── "PublishingConvictionAccount" → 0x7890...
└── ...
```

When contract A needs to call contract B, it looks up B's address in the Hub. This enables **upgradeability**: to upgrade the Staking logic, deploy a new Staking contract and update the Hub pointer. All other contracts automatically use the new version.

### Storage/Logic Separation

Each major feature has two contracts:
- **Storage contract**: Holds the data (mappings, structs). Rarely changed. Deployed once.
- **Logic contract**: Contains the business rules. Can be upgraded by deploying a new version and updating the Hub.

This means we can add new features (like conviction multipliers) by deploying new logic contracts while keeping all existing data intact.

### Contract Map

```
Logic Contracts (upgradeable)     Storage Contracts (persistent)
─────────────────────────────     ────────────────────────────
KnowledgeAssets.sol          →    KnowledgeAssetsStorage.sol  (V9 — address-based publishing)
Staking.sol                  →    StakingStorage.sol
                                  DelegatorsInfo.sol
ContextGraph.sol                  →    ContextGraphsRegistry.sol
                                  ContextGraphKnowledgeCollectionsRegistry.sol
                                  ContextGraphKnowledgeMinersRegistry.sol
ShardingTable.sol            →    ShardingTableStorage.sol
Ask.sol                      →    AskStorage.sol
RandomSampling.sol           →    RandomSamplingStorage.sol
Profile.sol                  →    ProfileStorage.sol
Identity.sol                 →    IdentityStorage.sol
PublishingConvictionAccount.sol   (self-contained, new)
FairSwapJudge.sol                (self-contained, new)
ProtocolTreasury.sol             (self-contained, new, governed by Hub owner)

LEGACY (V8, read-only):
  KnowledgeCollectionStorage.sol  (not written by V9 logic — preserved for V8 data access)
```

Note: V9 introduces a new `KnowledgeAssetsStorage.sol` rather than appending to the V8 `KnowledgeCollectionStorage.sol`. The legacy storage remains deployed and readable (for V8 KAs), but all new V9 Knowledge Assets are written to the clean storage contract. This avoids polluting V8 storage layouts and gives V9 a purpose-built schema.

The `ProtocolTreasury` contract accumulates the 5% protocol fee from publishing and private knowledge sales. It is governed by the **Hub owner** (the same admin key that controls contract upgrades). The Hub owner can withdraw funds for protocol development, audits, bug bounties, and ecosystem grants. The treasury percentage (5%) is stored as a Hub-level parameter and adjustable by the Hub owner.

---

## 11. Multi-Chain Support

The DKG Trust Layer is designed to work on multiple blockchains. The TypeScript layer (publisher, agent, CLI) interacts with the blockchain exclusively through a **ChainAdapter** interface:

```typescript
interface ChainAdapter {
  chainType: 'evm' | 'solana';
  chainId: string;

  // Publishing (address-based, no identity required)
  reserveUALRange(count: number): Promise<ReservedRange>;
  publishKnowledgeAssets(params: PublishParams): Promise<OnChainPublishResult>;
  batchMintKnowledgeAssets(params: MintParams): Promise<TxResult>;
  updateKnowledgeAssets(params: UpdateParams): Promise<TxResult>;
  extendStorage(params: ExtendParams): Promise<TxResult>;
  transferNamespace(newOwner: string): Promise<TxResult>;

  // Staking
  stakeWithLock(identityId: bigint, amount: bigint, lockEpochs: number): Promise<TxResult>;
  stakeToContextGraph(identityId: bigint, contextGraphId: string, amount: bigint): Promise<TxResult>;

  // Publishing Conviction Account
  createConvictionAccount(amount: bigint, lockEpochs: number): Promise<AccountResult>;
  coverPublishingCost(accountId: bigint, baseCost: bigint): Promise<TxResult>;

  // FairSwap (private knowledge exchange)
  initiatePurchase(kcId: bigint, kaId: bigint, price: bigint): Promise<PurchaseResult>;
  fulfillPurchase(purchaseId: bigint, encRoot: Uint8Array, keyCom: Uint8Array): Promise<TxResult>;
  revealKey(purchaseId: bigint, key: Uint8Array): Promise<TxResult>;
  disputeDelivery(purchaseId: bigint, proof: Uint8Array): Promise<TxResult>;
  claimPayment(purchaseId: bigint): Promise<TxResult>;
}
```

The interface uses chain-agnostic types (`string` for account IDs, `bigint` for amounts, `Uint8Array` for signatures) so that no EVM or Solana-specific concepts leak into the application layer.

**EVM implementation** (Phase 2, current focus):
- Solidity contracts deployed to EVM-compatible chains (Base, Ethereum, etc.)
- ethers.js v6 for contract interaction
- Upgradeable via Hub pattern

**Solana implementation** (future):
- Anchor programs implementing the same logic
- PDAs (Program Derived Addresses) instead of Hub lookups
- SPL tokens instead of ERC20
- Same `ChainAdapter` interface — the publisher/agent/CLI code doesn't change

---

## 12. V8 Compatibility

DKG V9 is designed to supersede V8 without breaking existing state. The key principles:

### What Stays the Same

- **Storage contract names and layouts**: `StakingStorage`, `KnowledgeCollectionStorage`, `DelegatorsInfo`, `ShardingTableStorage`, `ContextGraphsRegistry`, etc. are not renamed or modified. Their struct fields are not reordered. All existing on-chain data remains accessible. `KnowledgeCollectionStorage` becomes **legacy** (read-only) — V9 writes go to the new `KnowledgeAssetsStorage`.
- **Token economics baseline**: V8's 28-day staking withdrawal maps closely to V9's 1-epoch (30-day) lock = 1.0x conviction multiplier. V8 stakers see no meaningful change in reward rate if they don't opt into longer locks.
- **Hub pattern**: Same contract registry, same upgrade mechanism.
- **Epoch timing**: 30-day epochs (same as V8 mainnet; the 1-day epoch was a testnet-only configuration).
- **Node identity**: Same identity system (Ed25519 keys, identity IDs).

### What Changes

- **Logic contracts are upgraded**: `KnowledgeAssets.sol` replaces `KnowledgeCollection.sol` in the Hub, backed by the new `KnowledgeAssetsStorage` instead of the legacy `KnowledgeCollectionStorage`.
- **New fields appended to structs**: Conviction lock data is added to the end of `DelegatorData` in `StakingStorage`. Per-contextGraph stake allocations are added via new mappings in a new `ContextGraphStakingStorage` contract.
- **New contracts deployed**: `KnowledgeAssetsStorage`, `PublishingConvictionAccount`, `ContextGraphStakingStorage`, `FairSwapJudge`, and `ProtocolTreasury` are entirely new.
- **Publishing flow**: `batchMintKnowledgeAssets` replaces `createKnowledgeCollection`, with UAL pre-minting. The storage format is the same. `updateKnowledgeAssets` is new.
- **FairSwap**: New `FairSwapJudge` contract for private knowledge exchange — entirely new, no migration.
- **Permanent publishing**: New endowment mechanism — entirely additive.

### Migration Path

1. Deploy new logic contracts and new storage contracts
2. Register them in the Hub
3. Existing stakers, delegators, and KAs continue working with no action required
4. New features (conviction locks, contextGraph staking, UAL pre-minting) are opt-in
5. The conviction multiplier for existing 28-day stakers is automatically 1.0x

---

## Appendix: Formulas Reference

### Epoch
```
1 epoch = 30 days
```

### Publishing Cost
```
cost = stakeWeightedAverageAsk × publicByteSize × epochs / 1024
```

### Permanent Publishing Cost
```
permanentCost = annualCost × ENDOWMENT_MULTIPLIER
ENDOWMENT_MULTIPLIER = 10  (governance-adjustable)
annualCost = stakeWeightedAverageAsk × publicByteSize × 12 / 1024

Distributed across 100 epochs with geometric decay:
  epoch_share(i) = totalPayment × (0.97^i) / sum(0.97^0 ... 0.97^99)
```

### Knowledge Update Cost
```
if newPublicByteSize <= originalPublicByteSize:
    updateCost = originalCost × 10%
else:
    updateCost = originalCost × 10%
             + fullRate × (newPublicByteSize - originalPublicByteSize) × remainingEpochs
```

### Publishing Conviction Discount (Flat)
```
conviction = lockedTRAC × initialLockEpochs
discount = maxDiscount × conviction / (conviction + C_half)

maxDiscount = 50%
C_half = 3,000,000

Solidity: maxDiscount = 5e17, C_half = 3e24 (scaled to 18 decimals)
```

### Staking Conviction Multiplier
```
if lockEpochs == 0:
    multiplier = 0

if lockEpochs >= 1:
    multiplier = min(3.0,  1 + (18/7) × (lockEpochs - 1) / (lockEpochs - 1 + 22/7))

Solidity: K = 18/7 scaled to 1e18, H = 22/7 scaled to 1e18, cap = 3e18
```

### Node Score (per-contextGraph)
```
nodeContextGraphScore(t) = S(t) × (c + 0.86 × P(t) + 0.60 × A(t) × P(t))

S(t) = sqrt(nodeStakeInContextGraph / contextGraphStakeCap)
P(t) = nodeProofsSubmitted / totalContextGraphProofs  (over 4 epochs)
A(t) = 1 - |nodeAsk - contextGraphPrice| / contextGraphPrice
c = 0.002

effectiveScore = nodeContextGraphScore × convictionMultiplier
```

### Reward Distribution
```
Publishing fee split:
  85% → ContextGraph epoch pool
  10% → Global network pool
   5% → Protocol treasury

Node's share of contextGraph pool:
  nodeReward = contextGraphPool × (nodeEffectiveScore / sumAllNodeScores)
```
