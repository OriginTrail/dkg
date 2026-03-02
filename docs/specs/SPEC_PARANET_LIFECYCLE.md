# Paranet On-Chain Lifecycle

**Status**: DRAFT v0.1  
**Date**: 2026-02-25  
**Scope**: Creating, discovering, joining, and managing paranets with on-chain anchoring.  
**Depends on**: Trust Layer Spec §8, Part 2 §10, Sync Protocol

---

## 1. Problem Statement

Today, paranets exist only in a node's local triple store. When a node restarts, its paranet definitions vanish. When a new node joins the network, it has no way to discover what paranets exist. There is no on-chain record of a paranet, no membership registry, and no way to verify that a paranet is legitimate.

The sync protocol (just implemented) solves data persistence — triples survive restarts. But paranet **definitions** still need an authoritative source of truth that transcends any single node. That source is the blockchain.

### What we need

1. **Persistence**: Paranet definitions survive any individual node going offline.
2. **Discovery**: A new node can enumerate all paranets from the chain, without relying on gossip.
3. **Authority**: A paranet has a known creator/owner who can set policies.
4. **Membership**: Nodes joining a paranet is recorded and verifiable.
5. **Compatibility**: Works with the existing V8 `Paranet.sol` contract (don't rewrite what exists).

---

## 2. Design Overview

Paranets have a **dual existence**: an on-chain anchor (identity, ownership, policies) and an off-chain body (the actual RDF triples, stored in nodes' triple stores and replicated via gossipsub).

```
On-chain (Paranet.sol)              Off-chain (Triple Store + GossipSub)
┌─────────────────────┐             ┌──────────────────────────────┐
│ paranetId            │             │ data graph: did:dkg:paranet:X│
│ creator (address)    │             │ meta graph: did:dkg:paranet:X/_meta
│ name, description    │             │ actual RDF triples           │
│ access policies      │             │ merkle roots (per KC)        │
│ member list          │             │ replicated via gossipsub     │
│ creation block       │             │ persisted in triple store     │
└─────────────────────┘             └──────────────────────────────┘
         │                                       │
         │  ChainEventPoller sees                 │  Sync protocol
         │  ParanetCreated event                  │  replicates triples
         │  ─────────────────►                    │  between nodes
         │  Node creates local                    │
         │  graphs + subscribes                   │
```

---

## 3. Paranet Identity

### 3.1 Paranet ID

Every paranet has two identifiers:

- **On-chain ID** (`bytes32`): `keccak256(abi.encodePacked(creatorAddress, name))`. Deterministic and collision-resistant. This is what the contracts use.
- **Human-readable ID** (`string`): The name string (e.g., `"testing"`, `"ai-research"`). This is what the CLI and agents use. The mapping is: `paranetId = keccak256(creator, name)`.

The existing V8 `Paranet.sol` uses `keccak256(kcStorageContract, kcTokenId, kaTokenId)` as the ID, tying a paranet to a specific knowledge collection NFT. For V9, we decouple paranet identity from any specific KC. Instead, the paranet is identified by its creator + name, which is simpler and doesn't require pre-minting an NFT just to create a paranet.

### 3.2 Resolving Human IDs

When a user types `dkg publish testing`, the CLI resolves `"testing"` to a `bytes32` paranet ID by:

1. Querying the local triple store for a paranet named `"testing"` (fast, works offline).
2. If not found, querying the chain: scan `ParanetCreated` events for one with `name == "testing"`.
3. If multiple matches (different creators), prompt for disambiguation or use the one the node is subscribed to.

---

## 4. Lifecycle Operations

### 4.1 Create Paranet

**Who**: Any agent with an on-chain identity and ETH for gas.

**Flow**:

```
Agent                    Chain (Paranet.sol)          Other Nodes
  │                            │                          │
  ├── createParanet(           │                          │
  │     name, description,     │                          │
  │     accessPolicy)          │                          │
  │   ────────────────────►    │                          │
  │                            │ emit ParanetCreated(     │
  │                            │   paranetId, creator,    │
  │                            │   name, accessPolicy)    │
  │                            │   ──────────────────────►│
  │                            │                          │ ChainEventPoller
  │                            │                          │ detects event
  │   ◄────────────────────    │                          │
  │   tx confirmed             │                          │ Creates local graphs
  │                            │                          │ Subscribes to gossipsub
  ├── publish initial          │                          │
  │   metadata KA to paranet   │                          │
  │   (description, schema,    │                          │
  │    ontology hints)         │                          │
```

**On-chain state created**:

```solidity
struct ParanetV9 {
    address creator;
    string  name;
    string  description;
    uint8   accessPolicy;     // 0=open, 1=permissioned
    uint40  createdAtEpoch;
    bool    active;
}
```

**Contract interface** (new function added to existing `Paranet.sol`):

```solidity
function createParanetV9(
    string calldata name,
    string calldata description,
    uint8 accessPolicy
) external returns (bytes32 paranetId);
```

This is a **new function** on the existing contract, not a replacement of the V8 `registerParanet`. The V8 function stays for backward compatibility. The V9 function is simpler: no KC token coupling, just name + description + policy.

**Why not reuse V8 `registerParanet`?** The V8 function requires a knowledge collection storage contract and token IDs as paranet anchors. V9 paranets are standalone entities — they don't need to be tied to a specific KC NFT. Adding a new function is cleaner than overloading the V8 semantics.

### 4.2 Discover Paranets

**From chain (authoritative, for new nodes)**:

A node that just joined the network can enumerate all paranets:

```typescript
// In EVMChainAdapter
async listParanets(): Promise<ParanetInfo[]> {
    // Scan ParanetCreated events from deployment block
    const events = this.listenForEvents({
        eventTypes: ['ParanetCreated'],
        fromBlock: this.deploymentBlock,
    });
    // Return array of { paranetId, name, creator, accessPolicy }
}
```

**From gossip (fast, for running nodes)**:

Nodes already broadcast paranet definitions via the `agents` system paranet. When a paranet is created, the creator publishes its definition as RDF triples. Other nodes discover it through gossipsub replication or sync.

**From local store (fastest, for subscribed nodes)**:

```sparql
SELECT ?id ?name ?creator ?policy WHERE {
    ?id a dkg:Paranet ;
        dkg:name ?name ;
        dkg:creator ?creator ;
        dkg:accessPolicy ?policy .
}
```

**Resolution priority**: local store → gossip cache → chain scan.

### 4.3 Join Paranet

**Who**: Any node (for open paranets) or approved nodes (for permissioned paranets).

**Flow for open paranets**:

```
Node                         Chain                    GossipSub
 │                              │                        │
 ├── subscribeToParanet(id)     │                        │
 │   ──────────────────────►    │                        │
 │   (optional: on-chain join   │                        │
 │    for staking/rewards)      │                        │
 │                              │                        │
 ├── Sync existing data ◄───────┼────────────────────────┤
 │   from peers via /dkg/sync   │                        │
 │                              │                        │
 ├── Subscribe to gossipsub ────┼───────────────────────►│
 │   topic: dkg/paranet/{id}/   │                        │
 │                              │                        │
 │   Now receiving live publishes                        │
```

Joining is two-tiered:

1. **Gossipsub subscription** (always required): The node subscribes to the paranet's gossipsub topic and begins receiving publishes. This is lightweight and off-chain.

2. **On-chain membership** (optional, for staking rewards): If the node wants to earn rewards for hosting the paranet, it calls `joinParanet(paranetId, identityId)` on-chain. This registers the node as a member and is required for the paranet staking system (Milestone 5). Nodes can participate as "listeners" (gossipsub only, no rewards) or "members" (on-chain, eligible for rewards).

**Flow for permissioned paranets**:

The V8 `Paranet.sol` already has `requestParanetPermissionedNodeAccess` / `approvePermissionedNode`. We reuse this:

1. Node calls `requestParanetPermissionedNodeAccess(paranetId)` on-chain.
2. Paranet creator calls `approvePermissionedNode(paranetId, nodeId)`.
3. Node detects the approval event and subscribes.

### 4.4 Leave Paranet

```
Node                         Chain                    GossipSub
 │                              │                        │
 ├── unsubscribeFromParanet(id) │                        │
 │   ──────────────────────►    │                        │
 │   leaveParanet(paranetId)    │                        │
 │   (if on-chain member)       │                        │
 │                              │                        │
 ├── Unsubscribe from topic  ───┼───────────────────────►│
 │                              │                        │
 ├── (optional) Delete local    │                        │
 │   triples for this paranet   │                        │
```

Stake unlock follows the 1-epoch cooldown from the Trust Layer spec. Local data is optionally retained (the node might rejoin later).

### 4.5 Update Paranet Metadata

The paranet creator can update name, description, and policies:

```solidity
function updateParanetV9Metadata(
    bytes32 paranetId,
    string calldata description
) external;
```

Only the creator can call this. The `name` is immutable (it's part of the ID derivation). Access policy changes are a governance action with a cooldown to prevent rug-pulls.

### 4.6 Deactivate Paranet

The creator can deactivate a paranet:

```solidity
function deactivateParanet(bytes32 paranetId) external;
```

Deactivation sets `active = false`. Nodes detect this via events and stop accepting new publishes. Existing data is preserved but no new knowledge can be published. This is a soft delete — the paranet can be reactivated.

---

## 5. Chain Events

The `ChainEventPoller` (already implemented) watches for these events:

| Event | Trigger | Node Response |
|---|---|---|
| `ParanetCreated(bytes32 paranetId, address creator, string name, uint8 policy)` | New paranet registered | Create local graphs, optionally auto-subscribe if in config |
| `ParanetMemberJoined(bytes32 paranetId, uint72 identityId)` | Node joined paranet | Update local membership view |
| `ParanetMemberLeft(bytes32 paranetId, uint72 identityId)` | Node left paranet | Update local membership view |
| `ParanetDeactivated(bytes32 paranetId)` | Paranet deactivated | Stop accepting publishes, mark inactive |
| `ParanetMetadataUpdated(bytes32 paranetId)` | Metadata changed | Update local paranet definition |

---

## 6. Node Startup: Paranet Recovery

When a node starts (or restarts), it recovers its paranet subscriptions:

```
1. Load persisted triple store (Oxigraph by default, or Blazegraph/custom)
   → Recovers all previously synced triples

2. Load subscription list from config (~/.dkg/config.json → subscribedParanets)
   → Knows which paranets to rejoin

3. For each subscribed paranet:
   a. Verify it exists on-chain (quick contract call or cached event)
   b. Subscribe to gossipsub topic
   c. Run sync protocol to catch up on missed publishes
   d. Resume normal operation

4. Scan chain for new ParanetCreated events since last known block
   → Discover paranets created while this node was offline
   → If any match auto-subscribe rules, subscribe
```

The subscription list is persisted in the node's config file. The triple store is persisted in the configured backend (Oxigraph with file-backed N-Quads by default, or an external store like Blazegraph). Between these two, a node recovers fully on restart.

---

## 7. CLI Commands

### Existing (already implemented, off-chain only)

```bash
dkg paranet create <name>          # Creates paranet locally + gossip broadcast
dkg paranet list                   # Lists known paranets
dkg paranet info <id>              # Shows paranet details
dkg subscribe <paranet>            # Subscribes to gossipsub topic
```

### Updated (with on-chain anchoring)

```bash
dkg paranet create <name>          # Creates on-chain + local + gossip
  --description "..."              # Optional description
  --access open|permissioned       # Access policy (default: open)
  --no-chain                       # Skip on-chain (local-only, for testing)

dkg paranet join <name>            # Subscribe + on-chain membership
  --listen-only                    # Gossipsub only, no on-chain join

dkg paranet leave <name>           # Unsubscribe + on-chain leave

dkg paranet list                   # Lists known paranets (local + chain)
  --chain                          # Force chain scan (slow but complete)

dkg paranet info <name>            # Shows details including on-chain state
  --members                        # Include member list
```

---

## 8. EVM Adapter Changes

```typescript
interface ChainAdapter {
    // ... existing methods ...

    // Paranet lifecycle
    createParanet(params: CreateParanetParams): Promise<{ paranetId: string; txHash: string }>;
    joinParanet(paranetId: string): Promise<TxResult>;
    leaveParanet(paranetId: string): Promise<TxResult>;
    getParanetInfo(paranetId: string): Promise<ParanetInfo | null>;
    listParanetsFromChain(fromBlock?: number): AsyncIterable<ParanetInfo>;
}

interface CreateParanetParams {
    name: string;
    description: string;
    accessPolicy: 'open' | 'permissioned';
}

interface ParanetInfo {
    paranetId: string;       // bytes32 hex
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

### Option A: Extend existing Paranet.sol (preferred)

Add V9 functions alongside the existing V8 functions:

```solidity
// New V9 paranet registration (simpler, no KC coupling)
function createParanetV9(
    string calldata name,
    string calldata description,
    uint8 accessPolicy
) external returns (bytes32 paranetId) {
    paranetId = keccak256(abi.encodePacked(msg.sender, name));
    // Store in new mapping (not touching V8 data)
    // Emit ParanetCreated event
}

// Membership (reuse existing permissioning for permissioned paranets)
function joinParanetV9(bytes32 paranetId) external;
function leaveParanetV9(bytes32 paranetId) external;

// Views
function getParanetV9Info(bytes32 paranetId) external view returns (...);
function getParanetV9Members(bytes32 paranetId) external view returns (uint72[] memory);
function isParanetV9Member(bytes32 paranetId, uint72 identityId) external view returns (bool);
```

### Option B: New ParanetV9.sol contract

If extending the V8 contract is too risky (storage layout concerns), create a new contract registered in Hub as `"ParanetV9"`. This is safer but adds another contract to maintain.

**Recommendation**: Option A, with V9 functions using separate storage mappings to avoid any V8 layout conflicts.

---

## 10. Migration from Current State

Today's state: paranets are purely local (triple store + gossipsub). The migration:

1. **Deploy contract update** with `createParanetV9` function.
2. **Register system paranets on-chain**: `agents` and `ontology` are created on-chain by the deployer.
3. **Existing nodes**: On next restart, nodes detect the on-chain system paranets via events and link them to their local definitions. For user-created paranets (like `testing`), the creator re-creates them on-chain with `dkg paranet create testing` (which now calls the contract).
4. **New nodes**: Discover all paranets from chain on first boot, subscribe per config.

No data migration needed. The triples already exist in the store; we're just adding an on-chain anchor.

---

## 11. Open Questions

| ID | Question | Options |
|---|---|---|
| OQ1 | Should paranet creation cost TRAC (anti-spam) or be free? | Free for now (gas cost is sufficient anti-spam on L2). Add TRAC fee later if spam becomes a problem. |
| OQ2 | Should system paranets (`agents`, `ontology`) be immutable (no deactivation)? | Yes — mark them as `system: true` in the contract, skip deactivation check. |
| OQ3 | Auto-subscribe to new paranets? | No by default. Nodes explicitly choose. System paranets are auto-subscribed during `dkg init`. |
| OQ4 | Paranet name uniqueness? | Not enforced globally (different creators can use the same name). The `paranetId` is `keccak256(creator, name)` so they get different IDs. Discovery shows creator address for disambiguation. |
