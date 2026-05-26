# ContextGraph On-Chain Lifecycle

**Status**: DRAFT v0.1
**Date**: 2026-02-25
**Scope**: Creating, discovering, joining, and managing contextGraphs with on-chain anchoring.
**Depends on**: Trust Layer Spec §8, Part 2 §10, Sync Protocol

---

## 1. Problem Statement

Today, contextGraphs exist only in a node's local triple store. When a node restarts, its contextGraph definitions vanish. When a new node joins the network, it has no way to discover what contextGraphs exist. There is no on-chain record of a contextGraph, no membership registry, and no way to verify that a contextGraph is legitimate.

The sync protocol (just implemented) solves data persistence — triples survive restarts. But contextGraph **definitions** still need an authoritative source of truth that transcends any single node. That source is the blockchain.

### What we need

1. **Persistence**: ContextGraph definitions survive any individual node going offline.
2. **Discovery**: A new node can enumerate all contextGraphs from the chain, without relying on gossip.
3. **Authority**: A contextGraph has a known creator/owner who can set policies.
4. **Membership**: Nodes joining a contextGraph is recorded and verifiable.
5. **Compatibility**: Works with the existing V8 `ContextGraph.sol` contract (don't rewrite what exists).

---

## 2. Design Overview

ContextGraphs have a **dual existence**: an on-chain anchor (identity, ownership, policies) and an off-chain body (the actual RDF triples, stored in nodes' triple stores and replicated via gossipsub).

```
On-chain (ContextGraph.sol)              Off-chain (Triple Store + GossipSub)
┌─────────────────────┐             ┌──────────────────────────────┐
│ contextGraphId            │             │ data graph: did:dkg:context-graph:X│
│ creator (address)    │             │ meta graph: did:dkg:context-graph:X/_meta
│ name, description    │             │ actual RDF triples           │
│ access policies      │             │ merkle roots (per KC)        │
│ member list          │             │ replicated via gossipsub     │
│ creation block       │             │ persisted in triple store     │
└─────────────────────┘             └──────────────────────────────┘
         │                                       │
         │  ChainEventPoller sees                 │  Sync protocol
         │  ContextGraphCreated event                  │  replicates triples
         │  ─────────────────►                    │  between nodes
         │  Node creates local                    │
         │  graphs + subscribes                   │
```

---

## 3. ContextGraph Identity

### 3.1 ContextGraph ID

Every contextGraph has two identifiers:

- **On-chain ID** (`bytes32`): `keccak256(abi.encodePacked(creatorAddress, name))`. Deterministic and collision-resistant. This is what the contracts use.
- **Human-readable ID** (`string`): The name string (e.g., `"testing"`, `"ai-research"`). This is what the CLI and agents use. The mapping is: `contextGraphId = keccak256(creator, name)`.

The existing V8 `ContextGraph.sol` uses `keccak256(kcStorageContract, kcTokenId, kaTokenId)` as the ID, tying a contextGraph to a specific knowledge collection NFT. For V9, we decouple contextGraph identity from any specific KC. Instead, the contextGraph is identified by its creator + name, which is simpler and doesn't require pre-minting an NFT just to create a contextGraph.

### 3.2 Resolving Human IDs

When a user types `dkg publish testing`, the CLI resolves `"testing"` to a `bytes32` contextGraph ID by:

1. Querying the local triple store for a contextGraph named `"testing"` (fast, works offline).
2. If not found, querying the chain: scan `ContextGraphCreated` events for one with `name == "testing"`.
3. If multiple matches (different creators), prompt for disambiguation or use the one the node is subscribed to.

---

## 4. Lifecycle Operations

### 4.1 Create ContextGraph

**Who**: Any agent with an on-chain identity and ETH for gas.

**Flow**:

```
Agent                    Chain (ContextGraph.sol)          Other Nodes
  │                            │                          │
  ├── createContextGraph(           │                          │
  │     name, description,     │                          │
  │     accessPolicy)          │                          │
  │   ────────────────────►    │                          │
  │                            │ emit ContextGraphCreated(     │
  │                            │   contextGraphId, creator,    │
  │                            │   name, accessPolicy)    │
  │                            │   ──────────────────────►│
  │                            │                          │ ChainEventPoller
  │                            │                          │ detects event
  │   ◄────────────────────    │                          │
  │   tx confirmed             │                          │ Creates local graphs
  │                            │                          │ Subscribes to gossipsub
  ├── publish initial          │                          │
  │   metadata KA to contextGraph   │                          │
  │   (description, schema,    │                          │
  │    ontology hints)         │                          │
```

**On-chain state created**:

```solidity
struct ContextGraphV9 {
    address creator;
    string  name;
    string  description;
    uint8   accessPolicy;     // 0=open, 1=permissioned
    uint40  createdAtEpoch;
    bool    active;
}
```

**Contract interface** (new function added to existing `ContextGraph.sol`):

```solidity
function createContextGraphV9(
    string calldata name,
    string calldata description,
    uint8 accessPolicy
) external returns (bytes32 contextGraphId);
```

This is a **new function** on the existing contract, not a replacement of the V8 `registerContextGraph`. The V8 function stays for backward compatibility. The V9 function is simpler: no KC token coupling, just name + description + policy.

**Why not reuse V8 `registerContextGraph`?** The V8 function requires a knowledge collection storage contract and token IDs as contextGraph anchors. V9 contextGraphs are standalone entities — they don't need to be tied to a specific KC NFT. Adding a new function is cleaner than overloading the V8 semantics.

### 4.2 Discover ContextGraphs

**From chain (authoritative, for new nodes)**:

A node that just joined the network can enumerate all contextGraphs:

```typescript
// In EVMChainAdapter
async listContextGraphs(): Promise<ContextGraphInfo[]> {
    // Scan ContextGraphCreated events from deployment block
    const events = this.listenForEvents({
        eventTypes: ['ContextGraphCreated'],
        fromBlock: this.deploymentBlock,
    });
    // Return array of { contextGraphId, name, creator, accessPolicy }
}
```

**From gossip (fast, for running nodes)**:

Nodes already broadcast contextGraph definitions via the `agents` system contextGraph. When a contextGraph is created, the creator publishes its definition as RDF triples. Other nodes discover it through gossipsub replication or sync.

**From local store (fastest, for subscribed nodes)**:

```sparql
SELECT ?id ?name ?creator ?policy WHERE {
    ?id a dkg:ContextGraph ;
        dkg:name ?name ;
        dkg:creator ?creator ;
        dkg:accessPolicy ?policy .
}
```

**Resolution priority**: local store → gossip cache → chain scan.

### 4.3 Join ContextGraph

**Who**: Any node (for open contextGraphs) or approved nodes (for permissioned contextGraphs).

**Flow for open contextGraphs**:

```
Node                         Chain                    GossipSub
 │                              │                        │
 ├── subscribeToContextGraph(id)     │                        │
 │   ──────────────────────►    │                        │
 │   (optional: on-chain join   │                        │
 │    for staking/rewards)      │                        │
 │                              │                        │
 ├── Sync existing data ◄───────┼────────────────────────┤
 │   from peers via /dkg/sync   │                        │
 │                              │                        │
 ├── Subscribe to gossipsub ────┼───────────────────────►│
 │   topic: dkg/context-graph/{id}/   │                        │
 │                              │                        │
 │   Now receiving live publishes                        │
```

Joining is two-tiered:

1. **Gossipsub subscription** (always required): The node subscribes to the contextGraph's gossipsub topic and begins receiving publishes. This is lightweight and off-chain.

2. **On-chain membership** (optional, for staking rewards): If the node wants to earn rewards for hosting the contextGraph, it calls `joinContextGraph(contextGraphId, identityId)` on-chain. This registers the node as a member and is required for the contextGraph staking system (Milestone 5). Nodes can participate as "listeners" (gossipsub only, no rewards) or "members" (on-chain, eligible for rewards).

**Flow for permissioned contextGraphs**:

The V8 `ContextGraph.sol` already has `requestContextGraphPermissionedNodeAccess` / `approvePermissionedNode`. We reuse this:

1. Node calls `requestContextGraphPermissionedNodeAccess(contextGraphId)` on-chain.
2. ContextGraph creator calls `approvePermissionedNode(contextGraphId, nodeId)`.
3. Node detects the approval event and subscribes.

### 4.4 Leave ContextGraph

```
Node                         Chain                    GossipSub
 │                              │                        │
 ├── unsubscribeFromContextGraph(id) │                        │
 │   ──────────────────────►    │                        │
 │   leaveContextGraph(contextGraphId)    │                        │
 │   (if on-chain member)       │                        │
 │                              │                        │
 ├── Unsubscribe from topic  ───┼───────────────────────►│
 │                              │                        │
 ├── (optional) Delete local    │                        │
 │   triples for this contextGraph   │                        │
```

Stake unlock follows the 1-epoch cooldown from the Trust Layer spec. Local data is optionally retained (the node might rejoin later).

### 4.5 Update ContextGraph Metadata

The contextGraph creator can update name, description, and policies:

```solidity
function updateContextGraphV9Metadata(
    bytes32 contextGraphId,
    string calldata description
) external;
```

Only the creator can call this. The `name` is immutable (it's part of the ID derivation). Access policy changes are a governance action with a cooldown to prevent rug-pulls.

### 4.6 Deactivate ContextGraph

The creator can deactivate a contextGraph:

```solidity
function deactivateContextGraph(bytes32 contextGraphId) external;
```

Deactivation sets `active = false`. Nodes detect this via events and stop accepting new publishes. Existing data is preserved but no new knowledge can be published. This is a soft delete — the contextGraph can be reactivated.

---

## 5. Chain Events

The `ChainEventPoller` (already implemented) watches for these events:

| Event | Trigger | Node Response |
|---|---|---|
| `ContextGraphCreated(bytes32 contextGraphId, address creator, string name, uint8 policy)` | New contextGraph registered | Create local graphs, optionally auto-subscribe if in config |
| `ContextGraphMemberJoined(bytes32 contextGraphId, address agent)` | Agent joined contextGraph | Update local membership view |
| `ContextGraphMemberLeft(bytes32 contextGraphId, address agent)` | Agent left contextGraph | Update local membership view |
| `ContextGraphDeactivated(bytes32 contextGraphId)` | ContextGraph deactivated | Stop accepting publishes, mark inactive |
| `ContextGraphMetadataUpdated(bytes32 contextGraphId)` | Metadata changed | Update local contextGraph definition |

---

## 6. Node Startup: ContextGraph Recovery

When a node starts (or restarts), it recovers its contextGraph subscriptions:

```
1. Load persisted triple store (Oxigraph by default, or Blazegraph/custom)
   → Recovers all previously synced triples

2. Load subscription list from config (~/.dkg/config.json → subscribedContextGraphs)
   → Knows which contextGraphs to rejoin

3. For each subscribed contextGraph:
   a. Verify it exists on-chain (quick contract call or cached event)
   b. Subscribe to gossipsub topic
   c. Run sync protocol to catch up on missed publishes
   d. Resume normal operation

4. Scan chain for new ContextGraphCreated events since last known block
   → Discover contextGraphs created while this node was offline
   → If any match auto-subscribe rules, subscribe
```

The subscription list is persisted in the node's config file. The triple store is persisted in the configured backend (Oxigraph with file-backed N-Quads by default, or an external store like Blazegraph). Between these two, a node recovers fully on restart.

---

## 7. CLI Commands

### Existing (already implemented, off-chain only)

```bash
dkg contextGraph create <name>          # Creates contextGraph locally + gossip broadcast
dkg contextGraph list                   # Lists known contextGraphs
dkg contextGraph info <id>              # Shows contextGraph details
dkg subscribe <contextGraph>            # Subscribes to gossipsub topic
```

### Updated (with on-chain anchoring)

```bash
dkg contextGraph create <name>          # Creates on-chain + local + gossip
  --description "..."              # Optional description
  --access open|permissioned       # Access policy (default: open)
  --no-chain                       # Skip on-chain (local-only, for testing)

dkg contextGraph join <name>            # Subscribe + on-chain membership
  --listen-only                    # Gossipsub only, no on-chain join

dkg contextGraph leave <name>           # Unsubscribe + on-chain leave

dkg contextGraph list                   # Lists known contextGraphs (local + chain)
  --chain                          # Force chain scan (slow but complete)

dkg contextGraph info <name>            # Shows details including on-chain state
  --members                        # Include member list
```

---

## 8. EVM Adapter Changes

```typescript
interface ChainAdapter {
    // ... existing methods ...

    // ContextGraph lifecycle
    createContextGraph(params: CreateContextGraphParams): Promise<{ contextGraphId: string; txHash: string }>;
    joinContextGraph(contextGraphId: string): Promise<TxResult>;
    leaveContextGraph(contextGraphId: string): Promise<TxResult>;
    getContextGraphInfo(contextGraphId: string): Promise<ContextGraphInfo | null>;
    listContextGraphsFromChain(fromBlock?: number): AsyncIterable<ContextGraphInfo>;
}

interface CreateContextGraphParams {
    name: string;
    description: string;
    accessPolicy: 'open' | 'permissioned';
}

interface ContextGraphInfo {
    contextGraphId: string;       // bytes32 hex
    name: string;
    description: string;
    creator: string;         // address
    accessPolicy: 'open' | 'permissioned';
    active: boolean;
    createdAtBlock: number;
    memberCount?: number;
}
```

---

## 9. Contract Changes

### Option A: Extend existing ContextGraph.sol (preferred)

Add V9 functions alongside the existing V8 functions:

```solidity
// New V9 contextGraph registration (simpler, no KC coupling)
function createContextGraphV9(
    string calldata name,
    string calldata description,
    uint8 accessPolicy
) external returns (bytes32 contextGraphId) {
    contextGraphId = keccak256(abi.encodePacked(msg.sender, name));
    // Store in new mapping (not touching V8 data)
    // Emit ContextGraphCreated event
}

// Membership (reuse existing permissioning for permissioned contextGraphs)
function joinContextGraphV9(bytes32 contextGraphId) external;
function leaveContextGraphV9(bytes32 contextGraphId) external;

// Views
function getContextGraphV9Info(bytes32 contextGraphId) external view returns (...);
function getContextGraphV9Members(bytes32 contextGraphId) external view returns (address[] memory);
function isContextGraphV9Member(bytes32 contextGraphId, address agent) external view returns (bool);
```

### Option B: New ContextGraphV9.sol contract

If extending the V8 contract is too risky (storage layout concerns), create a new contract registered in Hub as `"ContextGraphV9"`. This is safer but adds another contract to maintain.

**Recommendation**: Option A, with V9 functions using separate storage mappings to avoid any V8 layout conflicts.

---

## 10. Migration from Current State

Today's state: contextGraphs are purely local (triple store + gossipsub). The migration:

1. **Deploy contract update** with `createContextGraphV9` function.
2. **Register system contextGraphs on-chain**: `agents` and `ontology` are created on-chain by the deployer.
3. **Existing nodes**: On next restart, nodes detect the on-chain system contextGraphs via events and link them to their local definitions. For user-created contextGraphs (like `testing`), the creator re-creates them on-chain with `dkg contextGraph create testing` (which now calls the contract).
4. **New nodes**: Discover all contextGraphs from chain on first boot, subscribe per config.

No data migration needed. The triples already exist in the store; we're just adding an on-chain anchor.

---

## 11. Open Questions

| ID | Question | Options |
|---|---|---|
| OQ1 | Should contextGraph creation cost TRAC (anti-spam) or be free? | Free for now (gas cost is sufficient anti-spam on L2). Add TRAC fee later if spam becomes a problem. |
| OQ2 | Should system contextGraphs (`agents`, `ontology`) be immutable (no deactivation)? | Yes — mark them as `system: true` in the contract, skip deactivation check. |
| OQ3 | Auto-subscribe to new contextGraphs? | No by default. Nodes explicitly choose. System contextGraphs are auto-subscribed during `dkg init`. |
| OQ4 | ContextGraph name uniqueness? | Not enforced globally (different creators can use the same name). The `contextGraphId` is `keccak256(creator, name)` so they get different IDs. Discovery shows creator address for disambiguation. |
