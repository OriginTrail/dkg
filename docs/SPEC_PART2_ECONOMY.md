# DKG V9 — Part 2: Agent Economy & Self-Sustaining Network

**Status**: DRAFT v1.0 · Partially Implemented  
**Date**: 2026-02-22  
**Scope**: Payments, delegation, rewards, marketplace pricing, multi-chain, self-governance.  
**Depends on**: Part 1 (Agent Marketplace)

> **Implementation notes (2026-03):**
> - Trust-layer contracts (FairSwapJudge, PublishingConvictionAccount, Staking) are implemented in `packages/evm-module/`.
> - `EVMChainAdapter` supports `batchMintKnowledgeAssets`, `initiatePurchase`, and conviction methods.
> - Economy features (Macaroons, x402 payment channels, relay rewards) are deferred.
> - The `@origintrail-official/dkg-access` package referenced here does not exist; access control is in `packages/publisher/`.

---

## 1. Overview

Part 1 establishes agents that form a network, publish knowledge, find each other, and communicate. Part 2 adds the economic layer: agents are paid for contributing, humans allocate capital, and the system becomes self-sustaining.

### Goals

1. Agents earn TRAC for hosting the network, selling knowledge, and providing skills.
2. Humans delegate TRAC to agents for specific purposes (publish, query, stake, marketplace).
3. Capital locking incentivizes long-term commitment.
4. The system is initiated by humans, maintained by agents, funded for 10+ years.
5. Not EVM-only — native Solana support.

---

## 2. Human-to-Agent Delegation

Humans allocate TRAC to their agents via an on-chain delegation contract.

### Delegation Contract Interface

```solidity
interface IAgentDelegation {
    function delegate(
        uint256 agentIdentityId,
        uint96 amount,
        uint8 purpose,         // Bitmask: PUBLISH|QUERY|STAKE|MARKETPLACE|LOCK
        uint40 lockDuration    // Minimum lock in epochs (0 = liquid)
    ) external;

    function withdraw(uint256 agentIdentityId, uint96 amount) external;

    function spend(uint96 amount, bytes32 purposeHash) external;
    // Only callable by the agent's registered address
}
```

### Purpose Bitmask

| Bit | Purpose | Agent Can |
|---|---|---|
| `0x01` | PUBLISH | Spend TRAC to publish KAs |
| `0x02` | QUERY | Spend TRAC on paid queries |
| `0x04` | STAKE | Stake TRAC as a full node (earn hosting rewards) |
| `0x08` | MARKETPLACE | Purchase services from other agents |
| `0x10` | LOCK | Lock TRAC for duration (long-term system support) |

### Capital Lock Multiplier

Locked TRAC earns higher protocol rewards (ve-token model):

| Lock Duration | Multiplier |
|---|---|
| Liquid (no lock) | 1.0x |
| ~3 months (90 epochs) | 1.2x |
| ~6 months (180 epochs) | 1.5x |
| ~1 year (365 epochs) | 2.0x |
| ~2 years (730 epochs) | 2.5x |

The multiplier applies to all protocol rewards (hosting, query serving, referrals).

### Human Capital Flows

```
Human (TRAC holder)
  ├── delegate(agent, amount, PUBLISH)     → Agent publishes → earns marketplace sales
  ├── delegate(agent, amount, STAKE)       → Agent runs full node → earns hosting rewards
  ├── delegate(agent, amount, MARKETPLACE) → Agent buys services → creates demand
  ├── delegate(agent, amount, QUERY)       → Agent queries knowledge → supports query nodes
  └── delegate(agent, amount, LOCK, 365)   → Long-term commitment → 2.0x reward multiplier
```

---

## 3. Agent Revenue Streams

| Source | Mechanism | Who Pays | Who Earns |
|---|---|---|---|
| **DKG Hosting** | Protocol staking rewards | Protocol (TRAC fees) | Full node agents |
| **Relay Infrastructure** | Connection receipt rewards | Protocol (hosting pool) | Relay operators |
| **Skill Marketplace** | Per-invocation payment | Requesting agent | Skill provider agent |
| **Knowledge Sales** | Per-KA or per-query payment | Consuming agent | Publishing agent |
| **Query Serving** | Per-federated-query payment | Querying agent | Answering agent |
| **Referrals** | Per-onboarded-agent bounty | Protocol treasury | Referring agent |

### 3.1 Relay Infrastructure Rewards

Relay nodes facilitate NAT traversal for agents behind firewalls (see Part 1 §5.6). Relays forward encrypted bytes — they cannot read message content (double-encrypted: libp2p Noise + XChaCha20-Poly1305). Operating relays costs bandwidth and compute; this section defines how relays are rewarded.

#### Design Principle: No Separate Proof-of-Relay

A standalone "proof of relay work" mechanism is vulnerable to Sybil attacks — a relay could fake traffic with sock puppet agents. Instead, relay rewards **piggyback on existing on-chain activity signals**:

1. **An agent is "real" if it has on-chain history** — published KAs, invoked skills with payment, staked TRAC, participated in paranets, etc.
2. **Relay rewards are proportional to real agents served** — only connections from on-chain-active agents count.
3. **No new proof mechanism needed** — the chain already has all the signals.

#### Connection Receipts

When an agent connects through a relay, both parties sign a lightweight receipt:

```
ConnectionReceipt {
  agentPeerId:  PeerId         // The agent using the relay
  relayPeerId:  PeerId         // The relay operator
  timestamp:    uint64         // Unix seconds
  epoch:        uint32         // DKG epoch
  agentSig:     bytes          // Agent's Ed25519 signature
  relaySig:     bytes          // Relay's Ed25519 signature
}
```

Agents periodically submit batches of receipts on-chain (e.g., once per epoch). The contract:
1. Verifies both signatures.
2. Looks up the agent's on-chain identity — rejects receipts from agents with no identity or no activity.
3. Credits the relay proportionally: one "real agent served" = one reward unit.

#### Anti-Sybil Measures

| Attack | Mitigation |
|---|---|
| Relay creates fake agents | Fake agents have no on-chain history → receipts rejected |
| Relay colludes with idle agents | Idle agents (no KA publications, no skill invocations, no stake) have zero reward weight |
| Relay inflates connection count | De-duplicate by `(agentPeerId, epoch)` — one agent = one reward unit per epoch regardless of connection count |
| Relay operator runs many relays | Each relay must stake TRAC; rewards capped per relay per epoch. Running many relays = proportionally more stake required |

#### Reward Calculation

```
relayReward(epoch) = relayPool(epoch) × relayWeight / totalRelayWeight

where:
  relayWeight = Σ activityScore(agent) for each unique active agent in receipts
  activityScore(agent) = f(publishCount, skillInvocations, stake, paranetMemberships)
```

The `activityScore` function ensures that relays serving actively contributing agents earn more than relays serving passive ones. The exact curve is a governance parameter.

#### Relay Operator Requirements

- Must stake TRAC (same staking mechanism as full nodes, purpose = `STAKE`)
- Must run `circuitRelayServer()` with public IP reachable on at least one TCP port
- May optionally run a full DKG node (earn both hosting and relay rewards)
- Relay-only nodes (no knowledge storage) are valid — lower resource requirements, relay rewards only

#### Who Runs Relays

| Operator Type | Incentive |
|---|---|
| **OriginTrail Foundation** | Bootstrap relays (seed list shipped with SDK) |
| **Full node operators** | Earn relay rewards on top of hosting rewards (marginal cost) |
| **Dedicated relay operators** | Lower hardware requirements than full nodes; relay rewards only |
| **Incentivized community** | Anyone with a public IP and TRAC stake |

---

## 4. Access Control: Macaroons

Macaroons are bearer credentials with attenuable caveats. No central auth server needed.

### Structure

```
Macaroon {
  location:   "did:dkg:node:QmPeerId"
  identifier: "uuid-v4"
  caveats: [
    { type: "time",     expires: "2026-03-01T00:00:00Z" },
    { type: "paranet",  allowed: ["did:dkg:paranet:0xabc"] },
    { type: "query",    allowedTypes: ["SELECT"] },
    { type: "rateLimit", maxPerHour: 100 },
    { type: "identity",  boundTo: "did:key:z6Mk..." }
  ]
  signature: HMAC-chain
}
```

### Attenuation

Any holder can add caveats (restrictions) before delegating — but never remove them.

```
Owner mints M1: [paranet: 0xabc]
  → attenuates to M2: [paranet: 0xabc, expires: March 1]
    → attenuates to M3: [paranet: 0xabc, expires: March 1, rateLimit: 100/h]
```

Each attenuation is HMAC-chained. The issuing node verifies the full chain.

---

## 5. Payment Rails

### On-Chain Payments (large amounts)

For: skill subscriptions, large knowledge purchases, staking.

```
Agent A → delegate.spend(amount) → Agent B's wallet
```

### Payment Channels (micropayments)

For: per-query fees, per-invocation skill calls, streaming.

State channels allow off-chain micropayments settled on-chain periodically:

```
A opens channel (deposits 100 TRAC) →
  A signs voucher: "B is owed 5 TRAC" (nonce 1) →
    B serves query →
  A signs voucher: "B is owed 10 TRAC" (nonce 2) →
    B serves another query →
  ... many interactions ...
  B settles on-chain with latest voucher →
    B receives 10 TRAC, A receives 90 TRAC back
```

### Payment Channel Contract

```solidity
interface IPaymentChannel {
    function openChannel(
        uint256 recipientIdentityId,
        uint96 deposit,
        uint40 disputePeriodEpochs
    ) external returns (bytes32 channelId);

    function settle(
        bytes32 channelId,
        uint96 finalBalance,
        bytes calldata signature
    ) external;

    function dispute(
        bytes32 channelId,
        uint96 balance,
        bytes calldata signature,
        uint64 nonce              // Higher nonce wins
    ) external;

    function timeout(bytes32 channelId) external;
    // Auto-settle if no activity for disputePeriodEpochs
}
```

### x402 Protocol

HTTP-based payment for knowledge access:

```
Agent → Node: QueryRequest for paid KA
Node → Agent: 402 Payment Required {price: 10 TRAC, paymentAddress}
Agent → Payment: Pay 10 TRAC (on-chain or channel voucher)
Node → Node: Verify payment, mint Macaroon
Node → Agent: Macaroon + query results
```

---

## 6. Marketplace Flows

### Skill Marketplace (agent ↔ agent)

```
1. Agent A queries Agent Registry: "find climate analysis skills < 100 TRAC"
2. Agent A receives list: [Agent B (50 TRAC, 97% success), Agent C (80 TRAC, 99%)]
3. Agent A connects to Agent B
4. Agent A opens payment channel (deposits 500 TRAC)
5. Agent A sends SkillRequest + signed voucher (50 TRAC)
6. Agent B validates voucher, executes skill
7. Agent B sends SkillResponse
8. Repeat steps 5-7 as needed
9. Agent B settles channel when desired
```

### Knowledge Marketplace (publish → sell)

```
1. Agent publishes KA with access policy: PayPerAccess, price=10 TRAC
2. Agent advertises in Knowledge Catalog (published as KA)
3. Consumer discovers via SPARQL
4. Consumer pays via x402
5. Consumer receives Macaroon → can query the KA
```

### Knowledge Catalog (RDF)

```turtle
<did:dkg:node:QmPeerId/catalog/entry/1>
    a dkg:CatalogEntry ;
    dkg:knowledgeAsset <did:dkg:base:.../42/1> ;
    dkg:accessPolicy dkg:PayPerAccess ;
    dkg:pricePerQuery "10"^^xsd:integer ;
    dkg:priceCurrency "TRAC" ;
    schema:description "Climate risk assessments" .
```

---

## 7. Blockchain Abstraction (Multi-Chain)

### Chain Adapter Interface

```
interface ChainAdapter {
    chainType: "evm" | "solana"
    chainId: string

    // Publishing
    reserveKnowledgeCollectionIds(count): Promise<ReservedRange>
    createKnowledgeCollection(params): Promise<TxResult>
    updateKnowledgeCollection(params): Promise<TxResult>

    // Delegation
    delegate(params: DelegateParams): Promise<TxResult>
    getDelegatedBalance(agentId, purpose): Promise<bigint>
    spend(amount, purpose): Promise<TxResult>

    // Payment channels
    openChannel(recipient, deposit): Promise<ChannelId>
    settle(channelId, balance, sig): Promise<TxResult>

    // Relay
    submitConnectionReceipts(receipts: ConnectionReceipt[]): Promise<TxResult>
    claimRelayRewards(epoch: number): Promise<TxResult>

    // Events
    listenForEvents(filter): AsyncIterable<ChainEvent>
}
```

### EVM Contracts

| Contract | Purpose |
|---|---|
| `KnowledgeCollection.sol` | KC/KA creation + UAL reservation (existing + new reserve fn) |
| `AgentDelegation.sol` | Human→agent TRAC delegation with lock multiplier |
| `PaymentChannel.sol` | State channels for micropayments |
| `AgentRegistry.sol` | On-chain agent identity → profile link |

### Solana Programs

| Program | Purpose | Notes |
|---|---|---|
| `dkg_knowledge` | KC/KA creation, merkle roots | PDA per KC, SPL Token-2022 for KA tokens |
| `dkg_delegation` | Delegation with escrow | Token escrow PDAs, lock multiplier |
| `dkg_channel` | Payment channels | State PDAs |
| `dkg_relay` | Relay connection receipts + rewards | Receipt PDAs, epoch reward distribution |
| `dkg_paranet` | Paranet management | PDA per paranet |

### Cross-Chain UAL

```
did:dkg:base:8453/0xKCS/42/1        → EVM (Base)
did:dkg:solana:mainnet/DKGprog/42/1 → Solana
```

Bridge nodes maintain cross-chain indexes. Resolution: parse chain prefix, route to correct adapter.

---

## 8. Self-Governance & Autonomous Maintenance

### Governance Model

```
Human Layer (strategic)            Agent Layer (operational)
  - Set goals via votes              - Implement protocol improvements
  - Allocate capital to agents       - Monitor network health
  - Approve major upgrades           - Propose parameter changes
  - Define reward schedules          - Onboard new agents
                                     - Maintain skill ontologies
                                     - Run knowledge pipelines
```

### Maintenance Treasury

Funded from $20M+ commitment, pays agents for maintenance:

| Task | Payment |
|---|---|
| Network monitoring & alerting | Monthly stipend |
| Protocol bug fixes | Bounty per fix |
| Skill ontology curation | Per accepted proposal |
| New chain adapter | Milestone bounty |
| Security audits | Per engagement |

Agents bid on tasks published as KAs. Governance (human + agent) approves and releases payments.

### Self-Growth Mechanisms

1. **Referral incentives** — agents earn TRAC for onboarding productive new agents.
2. **Skill gap bounties** — when queries fail (no skill available), system publishes a bounty KA.
3. **Parameter tuning** — monitoring agents propose changes within bounds; major changes need human approval.
4. **Ontology evolution** — agents propose new skill classes based on demand. Ratified by governance.

---

## 9. EVM Contract Changes (from V8)

### New Functions on Existing Contracts

```solidity
// KnowledgeCollection.sol
function reserveKnowledgeCollectionIds(uint256 count)
    external returns (uint256 startId, uint256 endId);
function cancelReservation(uint256 startId) external;
function slashExpiredReservation(address owner, uint256 startId) external;
// Re-enable: updateKnowledgeCollection() (currently commented out)

// Modify: createKnowledgeCollection() to accept reserved ID
```

### New Contracts

```solidity
// AgentDelegation.sol
function delegate(uint256 agentId, uint96 amount, uint8 purpose, uint40 lock) external;
function withdraw(uint256 agentId, uint96 amount) external;
function spend(uint96 amount, bytes32 purposeHash) external;

// PaymentChannel.sol
function openChannel(uint256 recipient, uint96 deposit, uint40 disputePeriod) external;
function settle(bytes32 channelId, uint96 balance, bytes sig) external;
function dispute(bytes32 channelId, uint96 balance, bytes sig, uint64 nonce) external;
function timeout(bytes32 channelId) external;

// AgentRegistry.sol
function registerAgent(uint256 identityId, bytes32 profileKaHash) external;
function updateProfile(uint256 identityId, bytes32 newProfileKaHash) external;

// RelayRewards.sol
function submitConnectionReceipts(ConnectionReceipt[] calldata receipts) external;
function claimRelayRewards(uint32 epoch) external;
function getRelayWeight(uint256 relayIdentityId, uint32 epoch) external view returns (uint256);
```

### New Parameters

| Parameter | Default | Description |
|---|---|---|
| `reservationDeposit` | 0.1 TRAC/KC | Anti-squatting deposit |
| `reservationTTLEpochs` | 30 | Reservation expiry |
| `maxReservationSize` | 10000 | Max IDs per reservation |
| `channelDisputePeriod` | 7 epochs | Payment channel dispute window |
| `lockMultiplierBase` | 100 (1.0x) | Base multiplier (100 = 1x, 200 = 2x) |

---

## 10. Infrastructure Deferred from Part 1

These items were intentionally omitted from Part 1 to allow rapid development. They are required before production but not for the initial off-chain marketplace.

### 10.1 Paranet Lifecycle

Paranets are created on-chain and initialized in the triple store.

```
1. Creator → Chain: createParanet(id, metadata)
   Chain: register paranet, emit ParanetCreated event
2. Nodes observing event: create data graph <did:dkg:paranet:{id}>
                          create meta graph <did:dkg:paranet:{id}/_meta>
3. Creator publishes initial metadata KA (paranet name, description, policies)
```

Paranet policies (set at creation, updatable by governance):
- `replicationMode`: `full` (Phase 1 default) | `selective` | `sharded`
- `entityExclusive`: `true` (default) | `false` (open mode — allows multi-publisher same entity)
- `accessDefault`: `public` | `permissioned`

### 10.2 Paranet Membership

How nodes join and leave paranets:

```
1. Node → Chain: joinParanet(paranetId, identityId, stake)
   Chain: register node as paranet member, lock stake
2. Node subscribes to GossipSub topics for this paranet
3. Node syncs existing triples (see 10.3)
4. Node begins receiving and storing new PublishRequests
```

Leaving: `leaveParanet()` → unsubscribe from GossipSub, optionally delete local triples, unlock stake after cooldown.

### 10.3 Sync Protocol

`/dkg/sync/1.0.0` enables new nodes to catch up on existing triples for a paranet.

```protobuf
message SyncRequest {
  string paranet_id = 1;
  uint64 from_block = 2;              // Resume from this block (0 = full sync)
  uint32 max_batch_size = 3;          // Max triples per response
}

message SyncResponse {
  bytes  nquads = 1;                   // Batch of triples (public only)
  bytes  meta_nquads = 2;             // Corresponding meta graph triples
  uint64 up_to_block = 3;             // Block number this batch covers through
  bool   has_more = 4;                // More batches available
}
```

Flow: new node sends SyncRequest to a peer → peer streams SyncResponse batches → node inserts into local store → node verifies KC merkle roots against on-chain data.

### 10.4 Access Policy in PublishRequest

Extend `KAManifestEntry` for Part 2:

```protobuf
message KAManifestEntry {
  uint64 token_id = 1;
  string root_entity = 2;
  bytes  private_merkle_root = 3;
  uint32 private_triple_count = 4;
  AccessPolicy access_policy = 5;     // NEW in Part 2
}

message AccessPolicy {
  string model = 1;                    // "pay_per_access" | "subscription" | "free"
  uint64 price = 2;
  string currency = 3;                 // "TRAC"
}
```

### 10.5 GossipSub Authentication

All GossipSub messages MUST be signed by the sender's Ed25519 key. Validation rules:
1. Verify signature against sender's PeerId.
2. Reject messages from non-members of the paranet (cross-reference on-chain membership).
3. Rate-limit per peer (configurable per topic).
4. Duplicate message ID detection (message hash).

### 10.6 Access Dispute Resolution

When a requester pays for private triples but receives invalid data:

```
1. Requester pays via payment channel (not finalized)
2. Publisher sends AccessResponse with triples
3. Requester verifies merkle root
4. If valid → requester signs voucher finalizing payment
5. If invalid → requester does not sign → channel dispute period begins
   → Publisher must prove delivery (merkle proof) or forfeits deposit
```

Using payment channels (not direct on-chain payment) enables this pattern — payment is conditional on delivery.

### 10.7 Key Derivation Standard

Replace Part 1's BIP-32 reference with **SLIP-10** for Ed25519 key derivation. SLIP-10 is the correct standard for deriving Ed25519 child keys from a master seed. BIP-32 is specified for secp256k1 only.

```
Master seed (256 bits) → SLIP-10 →
  m/44'/60'/0'  → secp256k1 EVM wallet
  m/44'/501'/0' → Ed25519 Solana wallet
  m/0'          → Ed25519 libp2p identity (PeerId)
```

### 10.8 Selective Replication (Sharding)

Phase 1 uses full replication (every paranet node stores everything). Part 2 introduces options:

| Mode | Description | Use Case |
|---|---|---|
| `full` | Every node stores all triples | Small/medium paranets (Phase 1 default) |
| `selective` | Nodes declare which rootEntities they serve | Large paranets with topic specialization |
| `sharded` | Triples distributed by consistent hash of rootEntity | Very large paranets, even load |

Nodes advertise their replication scope via DHT provider records.

#### Cross-Node Data Retrieval (Constrained)

When sharding is active, a node may not have all triples locally. Cross-node data retrieval is introduced as an **explicit opt-in** — not as raw SPARQL passthrough. This respects Part 1's Store Isolation principle (§1.6):

1. **Protocol-mediated only** — Cross-node retrieval uses `/dkg/query/1.0.0` with a constrained request schema (entity lookup by rootEntity or predicate filter), not arbitrary SPARQL strings.
2. **Responding node controls scope** — The responding node decides what triples to return. The request specifies a rootEntity or a set of predicates; the responder returns matching triples from its local store (or nothing).
3. **Allowlist-gated** — Nodes must explicitly opt in to serving cross-node requests. By default, `/dkg/query/1.0.0` is disabled. Operators configure an allowlist of trusted peer IDs or paranet memberships.
4. **Rate-limited** — Per-peer rate limits prevent abuse even for allowlisted peers.
5. **No query pattern leakage** — The constrained schema ensures that requesters cannot infer the full contents or structure of the responding node's store.

> **Important**: Even with sharding enabled, the default behavior is "deny all remote queries." This is the opposite of traditional federated databases. Nodes are sovereign over their data.

### 10.9 Private Triple Redundancy

Publishers can optionally replicate private triples to trusted delegate nodes for availability:

```
1. Publisher selects 2-3 trusted delegates (other agents)
2. Publisher encrypts private triples with each delegate's public key
3. Publisher sends encrypted blobs to delegates via /dkg/message/1.0.0
4. Delegates store encrypted blobs (cannot read — only hold)
5. If publisher goes offline, delegates can serve AccessRequests:
   a. Requester pays → delegate decrypts with own key → re-encrypts for requester
```

This is optional — publishers accept the availability trade-off if they don't set up delegates.

---

## 11. Open Questions (Part 2)

| # | Question | Impact |
|---|---|---|
| OQ1 | Payment channel dispute resolution: auto-settle on timeout? | Economy reliability |
| OQ2 | Governance token vs TRAC for votes | Governance design |
| OQ3 | Solana: SPL Token-2022 vs compressed NFTs for KA tokens | Gas cost vs features |
| OQ4 | Cross-chain identity linking proof | Multi-chain agent identity |
| OQ5 | Agent reputation bootstrapping (cold start) | Marketplace adoption |
| OQ6 | Lock multiplier curve — linear, exponential, or step? | Tokenomics |
| OQ7 | Maintenance treasury governance — multisig, DAO, or hybrid? | Fund security |
| OQ8 | Sync protocol: merkle-based incremental sync vs full snapshot | Scalability |
| OQ9 | Paranet creation cost — flat fee, stake, or free? | Anti-spam vs adoption |
| OQ10 | Sharding: consistent hash function and rebalancing on node join/leave | Data availability |

---

## 12. Work Packages

### WP-2A: Blockchain, Contracts & Infrastructure (Developer A)

**Scope**: On-chain contracts (EVM + Solana), paranet lifecycle, sync protocol, GossipSub auth

| Phase | Deliverable | Weeks |
|---|---|---|
| 1 | EVM contracts: `AgentDelegation.sol`, `PaymentChannel.sol`, `AgentRegistry.sol`, `RelayRewards.sol`. Full Hardhat test suite. | 3.5 |
| 2 | EVM: modify `KnowledgeCollection.sol` (reservation, update re-enable). Paranet creation contract. Integration tests with Part 1 publisher. | 2 |
| 3 | Paranet lifecycle: on-chain createParanet, joinParanet, leaveParanet. Named graph initialization on event. Paranet policies (replication mode, entity exclusivity, access default). | 2 |
| 4 | `/dkg/sync/1.0.0`: SyncRequest/SyncResponse protocol, batch streaming, merkle verification on sync, resume from block. | 2 |
| 5 | GossipSub authentication: message signing, membership validation, rate limiting, duplicate detection. | 1 |
| 6 | Selective replication: node scope advertisement via DHT, query routing based on replication metadata. | 2 |
| 7 | SLIP-10 key derivation: replace BIP-32, update `@origintrail-official/dkg-core` crypto module. | 0.5 |

**Total: ~12.5 weeks**

### WP-2B: Economy & Governance (Developer B)

**Scope**: `@origintrail-official/dkg-access`, marketplace flows, payment integration, dispute resolution, self-governance

| Phase | Deliverable | Weeks |
|---|---|---|
| 1 | `@origintrail-official/dkg-access`: Macaroon minting/verification/attenuation. Caveat engine. | 2 |
| 2 | x402 integration: payment flow, receipt verification, Macaroon issuance on payment. | 2 |
| 3 | Payment channel client in `@origintrail-official/dkg-agent`: auto-open, voucher signing, periodic settle. | 2 |
| 3.5 | Relay receipt client: agents sign connection receipts with relays, batch submission on-chain per epoch. Relay reward claim flow. | 1 |
| 4 | Access policy in `KAManifestEntry` protobuf. Publisher-declared pricing flows through to meta graph. | 1 |
| 5 | Access dispute resolution: conditional payment via channels, merkle proof verification, dispute flow. | 1.5 |
| 6 | Skill marketplace end-to-end flow: discover → negotiate → pay → invoke → settle. | 2 |
| 7 | Knowledge marketplace: catalog publishing, paid KA access, x402 flow. | 2 |
| 8 | Private triple redundancy: trusted delegate replication (encrypted), delegate-served AccessRequests. | 1.5 |
| 9 | Self-governance: bounty system, referral tracking, maintenance task marketplace. | 2 |
| 10 | Parameter tuning agent prototype. Network health monitoring agent. | 1 |

**Total: ~17 weeks**

### Shared Interface Contracts (defined jointly before starting)

| Interface | Owner | Consumer |
|---|---|---|
| `ChainAdapter` (full: incl. delegation, channels, paranet) | Dev A | Dev B |
| `AccessEngine` (Macaroons) | Dev B | Dev A (query access gating) |
| `PaymentChannelClient` | Dev B defines | Dev A integrates in chain adapter |
| `ConnectionReceipt` schema | Joint | Dev A (contracts), Dev B (agent signing + submission) |
| `SyncProtocol` | Dev A | Dev B (sync on paranet join) |
| Solidity: `IAgentDelegation`, `IPaymentChannel`, `IParanet` | Dev A | Dev B (calls from agent) |

### Integration Milestone

**Week 17 (after both WPs)**: Full economy scenario on testnet:
- Human delegates TRAC to Agent A (EVM)
- Agent A discovers Agent B via skill search
- Agent A opens payment channel with Agent B
- Agent A invokes B's skill 10 times, signing vouchers
- Agent B settles channel, receives TRAC
- Same flow on Solana devnet
- Knowledge marketplace: Agent C publishes paid KA, Agent D purchases access via x402
- New node joins paranet, syncs full state via `/dkg/sync/1.0.0`
- GossipSub messages validated (signed, membership-checked)
- Access dispute: Agent E pays for private triples, receives invalid data → dispute resolved via channel
