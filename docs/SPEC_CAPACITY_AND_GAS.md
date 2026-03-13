# DKG V9 — Capacity Metering, Dynamic Pricing & Provable Resources

**Status**: DRAFT v0.1  
**Date**: 2026-02-25  
**Scope**: Resource metering ("DKG gas"), dynamic pricing, capacity advertising, challenge-based verification.  
**Depends on**: Trust Layer Spec, Part 2 (Economy)

---

## Table of Contents

1. [The Capacity Problem](#1-the-capacity-problem)
2. [DKG Gas: A Universal Resource Unit](#2-dkg-gas-a-universal-resource-unit)
3. [Operation Cost Schedule](#3-operation-cost-schedule)
4. [Node Capacity Metering](#4-node-capacity-metering)
5. [Dynamic Pricing](#5-dynamic-pricing)
6. [Capacity Advertising](#6-capacity-advertising)
7. [Provable Capacity: The Challenge Protocol](#7-provable-capacity-the-challenge-protocol)
8. [Paranet-Level Capacity Markets](#8-paranet-level-capacity-markets)
9. [Integration with TRAC Economy](#9-integration-with-trac-economy)
10. [Implementation Phases](#10-implementation-phases)

---

## 1. The Capacity Problem

### What happens when demand exceeds supply

The DKG is a distributed system where every node has finite resources: storage for triples, CPU for query processing and merkle computation, bandwidth for replication, and on-chain gas for EVM transactions. Today, if demand spikes — many agents publishing simultaneously, complex queries flooding the network, large knowledge assets replicating to many peers — nodes degrade ungracefully. There is no mechanism to:

1. **Measure** how much capacity a node has or is currently using.
2. **Signal** to the network that capacity is scarce.
3. **Attract** new capacity when the network needs it.
4. **Verify** that nodes claiming capacity actually have it.

Blockchains solved an analogous problem. Ethereum introduced gas as a universal proxy for heterogeneous resource costs (computation, storage, memory, bandwidth), and EIP-1559 introduced dynamic pricing that adjusts fees based on demand. The result: the network gracefully handles load, honestly prices scarcity, and economically incentivizes capacity where it's needed.

The DKG needs the same — but the design differs in a critical way. In Ethereum, gas meters a **shared** scarce resource (block space, bounded by consensus). In the DKG, resources are **distributed** — my storage doesn't compete with your storage. This means the DKG can scale horizontally: more nodes = more total capacity. The gas system's job isn't to limit global throughput but to **measure local capacity**, **signal where demand is**, and **attract supply to meet it**.

### Design goals

| Goal | Mechanism |
|---|---|
| **Graceful degradation** | Nodes know their capacity, apply back-pressure before overload |
| **Honest pricing** | Cost reflects actual resource consumption, not arbitrary flat fees |
| **Capacity attraction** | Rising prices signal profit opportunity, attracting new node operators |
| **Accountability** | Nodes that claim capacity can be challenged to prove it |
| **Horizontal scaling** | Adding nodes to a paranet directly increases its throughput |

---

## 2. DKG Gas: A Universal Resource Unit

### Definition

**DKG gas** (or simply **gas**) is a dimensionless unit of off-chain resource consumption. Every operation a DKG node performs — storing triples, processing queries, replicating data, generating proofs — has a gas cost derived from the real resources it consumes.

Gas is not a token. It is not transferred or held. It is a **measurement unit** — like CPU cycles or kilowatt-hours — used for metering, pricing, and capacity planning.

### Why a single unit?

Operations consume different resource types in different proportions. A publish is storage-heavy. A complex SPARQL join is CPU-heavy. Replication is bandwidth-heavy. Collapsing these into a single scalar enables:

- **Uniform capacity expression**: a node advertises "I can process N gas/second" rather than separate storage/CPU/bandwidth limits.
- **Simple pricing**: one TRAC-per-gas rate, dynamically adjusted.
- **Comparable cost**: agents can compare the cost of different operations on a common scale.

### Relationship to EVM gas

EVM gas covers on-chain operations (publishing the merkle root, minting NFTs, signature verification). DKG gas covers everything off-chain. The two are independent and priced separately. A complete publish operation costs:

```
total_cost = evm_gas_cost (paid in ETH) + dkg_gas_cost (paid in TRAC)
```

The existing TRAC "ask" pricing (per KB per epoch) becomes a special case of DKG gas pricing for storage operations.

---

## 3. Operation Cost Schedule

Each atomic operation has a gas cost formula. Costs are parameterized so they can be tuned via governance without code changes.

### 3.1 Storage Operations

| Operation | Gas Formula | Rationale |
|---|---|---|
| `STORE_TRIPLE` | `G_store_base + G_store_byte × byte_size` | Fixed overhead (index update) + variable (serialized size) |
| `DELETE_TRIPLE` | `G_delete` | Index removal, tombstone creation |
| `INDEX_UPDATE` | `G_index × num_affected_indexes` | Updating SPO, POS, OSP indexes |

**`STORE_TRIPLE`** is the fundamental write operation. A triple like `<Alice> <knows> <Bob>` might be 80 bytes serialized in N-Quads; a triple with a long literal value might be 2KB. The variable component ensures larger triples cost proportionally more.

### 3.2 Replication Operations

| Operation | Gas Formula | Rationale |
|---|---|---|
| `REPLICATE_SEND` | `G_repl_base + G_repl_byte × byte_size` | Serialization + network transmission per peer |
| `REPLICATE_RECEIVE` | `G_recv_base + G_recv_byte × byte_size` | Deserialization + merkle verification |
| `GOSSIP_RELAY` | `G_gossip × message_size` | Forwarding gossipsub messages |

Replication cost is **per peer**. Publishing a 1KB knowledge asset to a paranet with 50 subscribers costs 50× the single-peer replication gas. This accurately reflects the real bandwidth consumed.

### 3.3 Query Operations

| Operation | Gas Formula | Rationale |
|---|---|---|
| `QUERY_PARSE` | `G_parse` | SPARQL parsing and algebra compilation |
| `QUERY_SCAN` | `G_scan × triples_scanned` | Sequential scan through matching triples |
| `QUERY_JOIN` | `G_join × (left_rows × right_rows)` | Hash join or nested loop join |
| `QUERY_FILTER` | `G_filter × rows_evaluated` | FILTER expression evaluation per row |
| `QUERY_SORT` | `G_sort × N × log(N)` | ORDER BY on N result rows |
| `QUERY_RESULT` | `G_result_byte × result_size` | Serializing and transmitting results |

Query gas is the most variable because it depends on data, not just the query string. A `SELECT * WHERE { ?s ?p ?o }` over 10 million triples is fundamentally more expensive than the same query over 100 triples. The gas cost reflects this.

**Query gas limits.** Nodes enforce a per-query gas limit (configurable). If a query exceeds the limit mid-execution, the node returns a partial result with a `GAS_LIMIT_EXCEEDED` status. This prevents unbounded queries from monopolizing CPU.

### 3.4 Cryptographic Operations

| Operation | Gas Formula | Rationale |
|---|---|---|
| `MERKLE_HASH` | `G_hash × num_leaves` | Hashing triples for merkle tree |
| `MERKLE_PROOF` | `G_proof × tree_depth` | Generating inclusion proof |
| `SIGNATURE_VERIFY` | `G_sigverify` | ECDSA signature verification |

### 3.5 Composite Operations

Real operations combine atomics. A publish of 100 triples to a paranet with 10 peers:

```
publish_gas =
    100 × STORE_TRIPLE(avg_size)          // Store locally
  + MERKLE_HASH(100)                      // Build merkle tree
  + SIGNATURE_VERIFY × 1                  // Verify publisher signature
  + 10 × REPLICATE_SEND(total_bytes)      // Send to 10 peers
```

### 3.6 Calibration

Gas costs are **empirically calibrated**, not theoretically derived. The process:

1. Benchmark each operation on reference hardware (defined as: 4-core CPU, 16GB RAM, NVMe SSD, 100Mbps symmetric bandwidth).
2. Measure wall-clock time and resource utilization (CPU-seconds, bytes written, bytes transmitted).
3. Set gas weights so that 1 gas ≈ 1 microsecond of reference-hardware execution time.
4. Periodically recalibrate as the codebase and hardware landscape evolves.

This follows Ethereum's approach: EVM gas costs were set by benchmarking opcodes and have been adjusted multiple times (e.g., EIP-2929 repricing SLOAD).

---

## 4. Node Capacity Metering

### 4.1 The Gas Meter

Every node runs a **gas meter** — a real-time accounting system that tracks gas consumed per operation and per time window.

```
GasMeter {
  // Sliding windows
  gasConsumedLastSecond:   uint64
  gasConsumedLastMinute:   uint64
  gasConsumedLastHour:     uint64

  // Cumulative counters (reset per epoch)
  totalGasConsumed:        uint64
  operationCounts: {
    publishes:             uint32
    queries:               uint32
    replications:          uint32
    proofs:                uint32
  }

  // Capacity
  maxGasPerSecond:         uint64   // Hardware-derived capacity
  currentUtilization:      float    // gasConsumedLastSecond / maxGasPerSecond
}
```

### 4.2 Capacity Discovery

On startup, a node benchmarks itself to determine `maxGasPerSecond`:

1. **Storage benchmark**: Write and read 10,000 random triples, measure throughput.
2. **CPU benchmark**: Execute a standard SPARQL join query over a synthetic dataset.
3. **Bandwidth benchmark**: Measure available upload/download bandwidth.
4. **Composite score**: Weighted combination → `maxGasPerSecond`.

The benchmark is deterministic given the same hardware, so it produces reproducible results. The benchmark suite is part of the node software and versioned with the protocol.

### 4.3 Back-Pressure

When utilization exceeds thresholds, the node applies back-pressure:

| Utilization | Behavior |
|---|---|
| 0–70% | Normal operation. Accept all requests. |
| 70–90% | **Soft throttle.** Delay low-priority operations (non-subscribed paranet queries). Publish and replication remain at full speed. |
| 90–99% | **Hard throttle.** Queue new publishes. Reject queries that would exceed gas limit. Return `503 Service Busy` with `Retry-After` and current gas price. |
| 99–100% | **Shed load.** Reject all new operations except replication of already-committed knowledge (protocol-level obligation). |

Back-pressure is local to each node. When node A is overloaded, agents can route to node B. This naturally distributes load across the network.

### 4.4 Metering API

The gas meter is exposed via the node's API for observability:

```
GET /api/capacity
```

```json
{
  "maxGasPerSecond": 1000000,
  "currentUtilization": 0.42,
  "gasConsumedLastMinute": 25200000,
  "operationCounts": {
    "publishes": 12,
    "queries": 847,
    "replications": 36,
    "proofs": 3
  },
  "effectiveGasPrice": "0.000000015",
  "queueDepth": 0
}
```

---

## 5. Dynamic Pricing

### 5.1 The Problem with Static Pricing

Today, nodes set a static "ask" (TRAC per KB per epoch). This creates two failure modes:

1. **Underpriced**: If demand surges, the node is overwhelmed but earns the same fee. No signal to attract more capacity.
2. **Overpriced**: If a node sets ask too high, it gets no work. No market feedback.

Static pricing cannot balance supply and demand. Dynamic pricing can.

### 5.2 EIP-1559 for the DKG

Ethereum's EIP-1559 adjusts a base fee per block based on how full the previous block was, targeting 50% utilization. The DKG adapts this model:

**Per-node gas price:**

```
base_price(t) = base_price(t-1) × (1 + δ × (utilization(t-1) - target_utilization))
```

Where:
- `base_price(t)` is the TRAC-per-gas price at time window `t`
- `utilization(t-1)` is the node's utilization in the previous window (0.0 to 1.0)
- `target_utilization` is the ideal operating point (default: 0.5)
- `δ` is the adjustment speed (default: 0.125, same as EIP-1559)

**Example trajectory:**

| Window | Utilization | Base Price (TRAC/gas) | Signal |
|---|---|---|---|
| t=0 | 0.30 | 0.000000010 | Below target → price decreasing |
| t=1 | 0.25 | 0.0000000097 | Still low → continues decreasing |
| t=2 | 0.80 | 0.0000000100 | Above target → price increasing |
| t=3 | 0.95 | 0.0000000106 | Well above → accelerating |
| t=4 | 0.50 | 0.0000000106 | At target → stable |

### 5.3 Network-Level Price Signal

Individual node prices are aggregated into a network-level signal:

```
network_gas_price = weighted_median(node_gas_prices, weights=node_stakes)
```

The stake-weighted median prevents Sybil manipulation (can't spam cheap fake nodes without capital) and is robust to outliers.

This network price is published on-chain (updated once per epoch) and serves as:
- **A capacity signal**: rising price = network needs more nodes.
- **A cost estimate**: agents can forecast operation costs.
- **A reward benchmark**: node operators can assess profitability.

### 5.4 Price Bounds

To prevent extreme volatility:

```
min_gas_price ≤ base_price(t) ≤ max_gas_price
```

- `min_gas_price`: governance parameter. Prevents a race to zero that could leave the network uneconomical to operate.
- `max_gas_price`: governance parameter. Prevents price spikes that could lock out legitimate agents during temporary surges.
- `max_adjustment_per_window`: the price cannot change by more than 12.5% per window (matching EIP-1559).

### 5.5 Priority Fees (Tips)

Like EIP-1559, agents can attach a **priority fee** (tip) above the base price to incentivize faster processing:

```
total_gas_price = base_price + priority_fee
```

When a node is at capacity and must prioritize, higher-tipping operations are processed first. The base price is protocol-determined; the priority fee is market-determined.

---

## 6. Capacity Advertising

### 6.1 Capacity Commitment

Nodes advertise their capacity to the network via a signed, on-chain commitment:

```solidity
struct CapacityCommitment {
    uint72  identityId;
    uint64  maxGasPerSecond;       // Claimed processing capacity
    uint64  storageCapacityBytes;  // Claimed available storage
    uint32  bandwidthMbps;         // Claimed network bandwidth
    uint32  epoch;                 // When this commitment was made
    uint96  stakeAmount;           // TRAC staked behind this commitment
}
```

The commitment is stored on-chain and associated with the node's identity. It's updated when the node's capacity changes (hardware upgrade, configuration change) or when the stake changes.

### 6.2 Peer Metadata

Off-chain, nodes include real-time capacity data in their libp2p peer metadata, broadcast via gossipsub:

```
PeerCapacityUpdate {
  peerId:              PeerId
  identityId:          uint72
  maxGasPerSecond:     uint64
  currentUtilization:  float32     // 0.0–1.0
  currentGasPrice:     uint64      // Current TRAC-per-gas price
  subscribedParanets:  string[]    // Which paranets this node serves
  timestamp:           uint64
  signature:           bytes       // Signed by operational key
}
```

This allows agents to make routing decisions: "paranet X has 12 nodes, 3 are under 50% utilization, route my query there."

### 6.3 Capacity Registry

A network-wide view of capacity is maintained by aggregating `PeerCapacityUpdate` messages:

```
GET /api/network/capacity
```

```json
{
  "totalNodes": 47,
  "totalGasPerSecond": 42000000,
  "averageUtilization": 0.38,
  "networkGasPrice": "0.000000012",
  "paranets": {
    "testing": {
      "nodes": 12,
      "gasPerSecond": 11000000,
      "utilization": 0.52,
      "gasPrice": "0.000000015"
    },
    "agents": {
      "nodes": 47,
      "gasPerSecond": 42000000,
      "utilization": 0.31,
      "gasPrice": "0.000000010"
    }
  }
}
```

---

## 7. Provable Capacity: The Challenge Protocol

### 7.1 The Verification Problem

A node claims `maxGasPerSecond = 1,000,000`. How do we know it's telling the truth? A node with a Raspberry Pi could claim datacenter-level capacity to earn higher rewards without delivering the promised performance. Without verification, the capacity system is a Sybil vector.

### 7.2 Design: Staked Commitment + Statistical Challenge

The challenge protocol combines economic commitment (staked TRAC) with statistical verification (random spot-checks).

**Core idea**: A node stakes TRAC proportional to its claimed capacity. Any node can challenge it. If the challenged node fails, it is slashed. If it succeeds, the challenger pays the challenge cost. This creates an equilibrium where honest nodes are never challenged (it's unprofitable) and dishonest nodes are eventually caught (it's profitable to challenge them).

### 7.3 Challenge Types

#### Type 1: Storage Challenge

Verify that the node is actually storing the triples it claims to store.

```
StorageChallenge {
  challengerId:    uint72
  targetId:        uint72
  paranetId:       bytes32
  randomSeed:      bytes32    // Determines which triples to prove
  responseDeadline: uint64    // Blocks until response required
}
```

**Protocol:**

1. Challenger submits `StorageChallenge` on-chain with a bond.
2. The `randomSeed` deterministically selects K triples from the target's claimed dataset (using the on-chain merkle roots as the dataset commitment).
3. Target must respond within `responseDeadline` blocks with merkle inclusion proofs for all K triples.
4. Contract verifies proofs against the stored merkle roots.
5. **Pass**: target's bond is untouched, challenger's bond is forfeited (pays for the target's proof generation cost).
6. **Fail**: target is slashed (percentage of staked TRAC), challenger receives a portion as bounty.

#### Type 2: Throughput Challenge

Verify that the node can actually process operations at its claimed rate.

```
ThroughputChallenge {
  challengerId:    uint72
  targetId:        uint72
  workload:        bytes      // Deterministic workload specification
  expectedGas:     uint64     // Gas cost of the workload
  maxDuration:     uint64     // Milliseconds (derived from claimed capacity)
  randomSeed:      bytes32
}
```

**Protocol:**

1. Challenger submits `ThroughputChallenge` on-chain. The `randomSeed` and `workload` specification deterministically generate a benchmark task (e.g., "store these 500 synthetic triples and execute this SPARQL query").
2. `maxDuration` is computed as `expectedGas / target.maxGasPerSecond × safety_margin`.
3. The target node detects the on-chain challenge (via ChainEventPoller) and executes the workload.
4. Target submits a response on-chain: the merkle root of stored triples + query result hash + signed timestamp proving completion within `maxDuration`.
5. Any node can verify by re-executing the deterministic workload and comparing the result hash.

**Key design property**: The workload is **deterministic** given the `randomSeed`. Any node can independently compute the expected result. This makes verification trustless.

#### Type 3: Bandwidth Challenge (Peer-Verified)

Verify that the node can replicate data at its claimed bandwidth.

Unlike storage and throughput challenges, bandwidth is inherently peer-to-peer — it can't be verified by a smart contract. Instead, bandwidth challenges use a **peer jury**:

1. Challenger selects 3 random peers (from the staked node set) as jurors.
2. Each juror sends a standardized data payload to the target and measures round-trip time.
3. Jurors submit signed attestations of measured bandwidth.
4. If majority attestation < claimed bandwidth × threshold, target is slashed.

### 7.4 Challenge Economics

The challenge system must be self-regulating: honest nodes aren't harassed, dishonest nodes are caught.

**Challenger bond**: Submitting a challenge requires staking TRAC. If the challenge fails (target passes), the bond is forfeited. This prevents challenge spam.

**Slash amount**: Proportional to the gap between claimed and actual capacity. Claiming 1M gas/sec but only delivering 500K is a 50% over-claim → slash 50% of the capacity stake.

**Challenge frequency**: The protocol targets one challenge per node per epoch (probabilistically). Challenges are selected via VRF (verifiable random function) so nodes can't predict when they'll be challenged.

**Expected value analysis:**

For an honest node:
```
E[cost] = P(challenged) × proof_generation_cost ≈ negligible
E[reward] = normal_operating_revenue
```

For a dishonest node (claiming 2× actual capacity):
```
E[cost] = P(challenged) × slash_amount = significant
E[reward] = inflated_operating_revenue - E[cost] = negative (if slash > gains)
```

The slash amount is calibrated so that overclaiming capacity is always negative expected value.

### 7.5 Graduated Response

Not every failure indicates dishonesty. Networks have variance — a node might fail a throughput challenge because of temporary CPU contention from an OS update. The protocol uses graduated response:

| Consecutive Failures | Response |
|---|---|
| 1 | **Warning.** Logged on-chain. No slash. Node has grace period to remediate. |
| 2 | **Soft penalty.** Capacity commitment is halved on-chain. Node can re-benchmark and re-commit. Capacity stake locked for 1 epoch. |
| 3 | **Slash.** 10% of capacity stake is slashed. Capacity commitment zeroed. Must re-stake and re-commit. |
| 4+ | **Progressive slash.** 25% per failure. Reputation score decays. |

### 7.6 Self-Challenge (Benchmark Refresh)

Nodes can proactively "self-challenge" to update their capacity commitment:

1. Node runs the standard benchmark suite.
2. Submits the results on-chain with a signed attestation.
3. Other nodes can verify by running the same benchmark and comparing.

This is cheaper than waiting for external challenges and builds trust. Nodes that self-challenge regularly can be weighted higher in routing decisions.

---

## 8. Paranet-Level Capacity Markets

### 8.1 Per-Paranet Pricing

Different paranets have different demand profiles. A paranet hosting high-frequency financial data has different capacity needs than one hosting a static ontology. DKG gas pricing operates at the **paranet level**:

```
paranet_gas_price(p, t) = paranet_base_price(p, t-1) × 
    (1 + δ × (paranet_utilization(p, t-1) - target_utilization))
```

Each paranet independently adjusts its gas price based on the utilization of nodes subscribed to that paranet.

### 8.2 Capacity Attraction

When a paranet's gas price rises, it signals profit opportunity:

```
profit_margin(node, paranet) = paranet_gas_price × node_gas_capacity - operating_cost
```

Nodes can dynamically subscribe to paranets where the profit margin is highest. This creates a **self-balancing market**: demand on paranet X rises → price rises → nodes migrate from low-demand paranet Y → paranet X gains capacity → price stabilizes.

### 8.3 Minimum Capacity Requirements

Paranets can set minimum capacity requirements for participating nodes:

```solidity
struct ParanetCapacityPolicy {
    uint64 minGasPerSecond;         // Minimum node capacity to subscribe
    uint64 minStorageBytes;         // Minimum storage commitment
    uint32 minBandwidthMbps;        // Minimum bandwidth
    uint8  minReplicationFactor;    // Minimum copies of each KA
}
```

This prevents underpowered nodes from degrading paranet performance while still allowing them to participate in less demanding paranets.

---

## 9. Integration with TRAC Economy

### 9.1 Replacing Static Ask

The current `ask` system (TRAC per KB per epoch) is subsumed by DKG gas pricing:

```
legacy_ask = storage_gas_per_kb × base_gas_price × epochs
```

Existing `Profile.updateAsk()` becomes a way to set a **minimum floor price** rather than a fixed price. The actual price is determined dynamically by the gas pricing mechanism.

### 9.2 Gas Payment Flow

```
Agent wants to publish 100 triples to paranet "finance"

1. Agent queries gas estimate:
   publish_gas = 100 × STORE_TRIPLE + MERKLE_HASH(100) + 10 × REPLICATE_SEND
              = 100 × 150 + 100 × 5 + 10 × 800
              = 23,500 gas

2. Agent queries current gas price for paranet "finance":
   gas_price = 0.000000015 TRAC/gas

3. Total TRAC cost:
   cost = 23,500 × 0.000000015 = 0.0003525 TRAC

4. Agent submits publish with tokenAmount ≥ cost
5. Receiving nodes earn gas revenue proportional to work performed
```

### 9.3 Revenue Distribution

Gas revenue is distributed to nodes proportional to the gas they consumed serving the operation:

| Role | Share | Rationale |
|---|---|---|
| **Publisher node** (local storage + merkle + signing) | 40% | Does the most work |
| **Replicating nodes** (storage + verification) | 50% (split equally) | Store and serve the data long-term |
| **Protocol treasury** | 10% | Funds development and governance |

### 9.4 Staking Integration

A node's capacity stake (staked TRAC backing its capacity commitment) is **additive** with its existing DKG hosting stake:

```
total_effective_stake = hosting_stake + capacity_stake × capacity_multiplier
```

Where `capacity_multiplier` rewards nodes that commit to and deliver higher capacity. This incentivizes node operators to invest in better hardware.

---

## 10. Implementation Phases

### Phase 1: Instrumentation (Measure)

**Goal**: Add gas metering to every operation without enforcement or pricing.

- Implement `GasMeter` in the node core.
- Assign provisional gas costs to all operations.
- Log gas consumption per operation in daemon output.
- Expose `GET /api/capacity` endpoint.
- Add startup benchmark to determine `maxGasPerSecond`.
- Collect real-world data to calibrate gas costs.

**Deliverables**: `@origintrail-official/dkg-gas-meter` package, dashboard for monitoring gas consumption.

**No economic impact.** This phase is purely observational.

### Phase 2: Back-Pressure (Protect)

**Goal**: Nodes gracefully handle overload using gas budgets.

- Implement utilization-based back-pressure (§4.3).
- Add per-query gas limits with `GAS_LIMIT_EXCEEDED` responses.
- Include capacity metadata in peer advertisements.
- Agents can query node capacity before routing.

**Deliverables**: Back-pressure middleware, capacity-aware routing in the agent.

**No economic impact.** Gas is metered and used for load management but not priced.

### Phase 3: Dynamic Pricing (Price)

**Goal**: Gas has a TRAC price that adjusts with demand.

- Implement per-node EIP-1559 pricing.
- Aggregate to paranet-level and network-level prices.
- Publish network gas price on-chain (once per epoch).
- Replace static ask with gas-price-derived ask.
- Implement priority fees.

**Deliverables**: Pricing engine, on-chain gas price oracle, updated publish flow.

**Economic impact begins.** Nodes earn variable revenue; agents pay variable costs.

### Phase 4: Capacity Commitments (Advertise)

**Goal**: Nodes commit to capacity levels on-chain, backed by stake.

- Implement `CapacityCommitment` contract.
- Nodes submit capacity commitments with staked TRAC.
- Capacity commitments are visible network-wide.
- Routing prefers nodes with committed (not just advertised) capacity.

**Deliverables**: Capacity commitment contract, stake-weighted routing.

### Phase 5: Challenge Protocol (Verify)

**Goal**: Capacity commitments are verifiable through challenges.

- Implement storage challenges (Type 1).
- Implement throughput challenges (Type 2).
- Implement bandwidth challenges via peer jury (Type 3).
- Implement graduated slashing.
- Implement VRF-based random challenge selection.

**Deliverables**: Challenge contracts, challenge response handler in node, slash/reward distribution.

### Phase 6: Paranet Markets (Scale)

**Goal**: Paranets have independent capacity markets that self-balance.

- Implement per-paranet gas pricing.
- Nodes dynamically subscribe to high-margin paranets.
- Paranet capacity policies (minimum requirements).
- Cross-paranet capacity dashboard.

**Deliverables**: Paranet market contracts, dynamic subscription logic, network capacity explorer.

---

## Appendix A: Gas Cost Reference Table (Provisional)

These costs are provisional and will be calibrated empirically in Phase 1.

| Operation | Symbol | Provisional Cost | Unit |
|---|---|---|---|
| Store triple (base) | `G_store_base` | 100 | gas |
| Store triple (per byte) | `G_store_byte` | 1 | gas/byte |
| Delete triple | `G_delete` | 50 | gas |
| Index update | `G_index` | 20 | gas/index |
| Replicate send (base) | `G_repl_base` | 200 | gas/peer |
| Replicate send (per byte) | `G_repl_byte` | 2 | gas/byte/peer |
| Replicate receive (base) | `G_recv_base` | 150 | gas |
| Replicate receive (per byte) | `G_recv_byte` | 1 | gas/byte |
| Gossip relay | `G_gossip` | 1 | gas/byte |
| Query parse | `G_parse` | 500 | gas |
| Query scan | `G_scan` | 5 | gas/triple |
| Query join | `G_join` | 10 | gas/row-pair |
| Query filter | `G_filter` | 3 | gas/row |
| Query sort | `G_sort` | 2 | gas/comparison |
| Query result (per byte) | `G_result_byte` | 1 | gas/byte |
| Merkle hash | `G_hash` | 5 | gas/leaf |
| Merkle proof | `G_proof` | 10 | gas/level |
| Signature verify | `G_sigverify` | 1000 | gas |

## Appendix B: Example Gas Calculations

### Small publish (3 triples, 1 paranet peer)

```
Storage:     3 × (100 + 1 × 120)  =   660 gas
Merkle:      5 × 3                 =    15 gas
Signature:   1000                  = 1,000 gas
Replication: 1 × (200 + 2 × 360)  =   920 gas
────────────────────────────────────────────
Total:                               2,595 gas
At 0.000000015 TRAC/gas:         0.0000389 TRAC
```

### Large publish (10,000 triples, 50 paranet peers)

```
Storage:     10000 × (100 + 1 × 150) = 2,500,000 gas
Merkle:      5 × 10000               =    50,000 gas
Signature:   1000                     =     1,000 gas
Replication: 50 × (200 + 2 × 1.5M)   = 150,010,000 gas
────────────────────────────────────────────────
Total:                                  152,561,000 gas
At 0.000000015 TRAC/gas:                    2.288 TRAC
```

### Complex SPARQL query (3-way join, 1M triples scanned)

```
Parse:       500                       =     500 gas
Scan:        5 × 1,000,000            = 5,000,000 gas
Join (1):    10 × 50,000 × 200       = 100,000,000 gas
Join (2):    10 × 10,000 × 50        = 5,000,000 gas
Filter:      3 × 500                  =   1,500 gas
Sort:        2 × 500 × 9             =   9,000 gas
Result:      1 × 25,000              =  25,000 gas
────────────────────────────────────────────────
Total:                                  110,036,000 gas
At 0.000000015 TRAC/gas:                    1.651 TRAC
```

## Appendix C: Comparison with Ethereum Gas

| Property | Ethereum Gas | DKG Gas |
|---|---|---|
| **Scope** | On-chain computation + storage | Off-chain computation + storage + bandwidth |
| **Resource type** | Shared (block space) | Distributed (per-node) |
| **Scaling** | Fixed throughput (gas limit per block) | Horizontal (more nodes = more total gas) |
| **Pricing** | EIP-1559 base fee + priority fee | Per-node EIP-1559 + aggregated paranet price |
| **Determinism** | Fully deterministic (same input = same gas) | Mostly deterministic (query gas depends on data) |
| **Enforcement** | Consensus (all validators agree on gas used) | Local metering + challenge-based verification |
| **Payment** | ETH | TRAC |
| **Target** | 50% block utilization | 50% node utilization |
