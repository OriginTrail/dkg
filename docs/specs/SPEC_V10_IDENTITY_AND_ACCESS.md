# V10 Identity and Access Control — Spec Update

**Status**: IMPLEMENTED (v10-rc)
**Date**: 2026-04-07
**Scope**: Agent identity model, context graph namespacing, access control, edge node requirements.
**Supersedes**: Parts of SPEC_PARANET_LIFECYCLE §3–4, v9-protocol-operations §2.3 Phase 5b.

---

## 1. Two-Layer Identity Model

V10 introduces a clear separation between **Node identity** (infrastructure) and **Agent identity** (application/user).

### 1.1 Node Identity

- **peerId** (`string`): libp2p Ed25519 key, used for P2P transport (gossipsub, sync, streams).
- **nodeIdentityId** (`uint72`): On-chain profile in the `IdentityStorage` contract. **Required only for core nodes** that participate in staking, relay, or protocol-level signing. Edge nodes do NOT need an on-chain profile.
- **nodeRole** (`'core' | 'edge'`): Configured in `config.json`. Determines whether on-chain profile creation is attempted at boot.

### 1.2 Agent Identity

- **agentAddress** (`address`): Ethereum address derived from a secp256k1 keypair. This is the primary agent identifier.
- **agentDid** (`string`): `did:dkg:agent:{agentAddress}` — the canonical DID form.
- **authToken** (`string`): A random 64-hex token assigned at registration, used as a Bearer token in HTTP API requests to resolve the calling agent.
- **mode** (`'custodial' | 'self-sovereign'`):
  - **Custodial**: The node holds the agent's private key. Key generated via `ethers.Wallet.createRandom()`.
  - **Self-sovereign**: The agent provides only a public key. The node derives the address but never holds the private key.

### 1.3 Agent Registry

Agents are stored as RDF triples in the system graph `did:dkg:system/agents`:

```turtle
<did:dkg:agent:0xAbc...> a dkg:Agent ;
    dkg:agentAddress "0xAbc..." ;
    dkg:agentMode "custodial" ;
    schema:name "ResearchBot" ;
    dkg:agentAuthToken "a1b2c3..." .
```

On first boot, a default "owner" agent is auto-registered from the node's operational wallet. Additional agents are registered via `POST /api/agent/register`.

---

## 2. Context Graph ID Namespacing

### 2.1 Format

Context graph IDs use the format:

```
{agentAddress}/{project-slug}
```

With the full URI being:

```
did:dkg:context-graph:{agentAddress}/{project-slug}
```

Examples:
- `0xAbc...def/pharma-drug-interactions`
- `0x123...789/ai-research-q2`

### 2.2 Validation

The `isValidContextGraphId` regex in the daemon accepts:
- Legacy format: alphanumeric + colons + hyphens (e.g., `cg:my-project`)
- New format: `{agentAddress}/{slug}` (e.g., `0xAbc...def/my-project`)

### 2.3 Uniqueness

The address prefix ensures global uniqueness without a central registry. Two agents cannot create colliding CG IDs because their addresses differ.

---

## 3. Access Control

V10 implements a two-tier access control model:

### 3.1 Off-Chain (Unregistered Context Graphs)

For CGs that have not been registered on-chain (the default state after `createContextGraph`):

- Access is controlled via `dkg:allowedAgent` triples in the CG's `_meta` graph.
- The curator (CG creator) can add/remove agents via:
  - `POST /api/context-graph/{id}/add-participant` — adds an agent address to the allowlist
  - `POST /api/context-graph/{id}/remove-participant` — removes an agent
  - `GET /api/context-graph/{id}/participants` — lists allowed agents
- Allowlist propagates to peers via the authenticated sync protocol (not gossip).
- If no `dkg:allowedAgent` triples exist, the CG is open (anyone who subscribes can read/write).

### 3.2 On-Chain (Registered Context Graphs)

For CGs registered on-chain via `registerContextGraphOnChain`:

- Access is controlled via the `participantAgents` array in the `ContextGraphs` contract.
- Participants are **agent addresses** (`address`), not node identity IDs (`uint72`).
- The contract exposes: `addParticipant(bytes32 id, address agent)`, `removeParticipant(bytes32 id, address agent)`.
- M-of-N governance signatures use agent private keys.

### 3.3 Resolution Order

When checking if an agent can access a CG:
1. Check local `participantAgents` cache (from subscription registry)
2. Check `_meta` graph for `dkg:allowedAgent` triples
3. Check on-chain `getContextGraphParticipants()` (if CG has an on-chain ID)
4. Fall back to legacy `dkg:allowedPeer` check (backward compatibility)

---

## 4. Edge Nodes

### 4.1 No On-Chain Profile Required

Edge nodes (`nodeRole: 'edge'`) skip `ensureProfile` during `ensureIdentity`. They can:
- Run a full node with P2P, gossip, and sync capabilities
- Host agents that interact with the DKG
- Create and join context graphs (off-chain only)

They cannot:
- Participate in on-chain staking or rewards
- Register context graphs on-chain (requires `nodeIdentityId > 0`)
- Act as relay nodes

### 4.2 Default Behavior

If `nodeRole` is not specified in config, it defaults to `'edge'`. Core nodes must explicitly set `nodeRole: 'core'`.

---

## 4.3 Custodial Agent Key Restoration

When a node restarts (non-clean), agent records loaded from the triple store
may lack their `privateKey` (private keys are intentionally not persisted to
the store). For custodial agents, the node restores the private key from the
configured `operationalKeys` by matching the derived wallet address to the
stored `agentAddress`. This ensures signed operations (e.g., join requests)
work correctly after restart.

## 4.4 Join Approval Broadcast

When a curator approves a join request, the notification is **broadcast to
all connected peers** via `PROTOCOL_JOIN_REQUEST`, not targeted to a specific
agent registry entry. Each peer's handler checks the `agentAddress` field —
only the matching node auto-subscribes and initiates catch-up sync. This
approach avoids reliance on a potentially incomplete agent registry.

## 4.5 Real-Time SSE Events

The node emits Server-Sent Events on `GET /api/events` for:

| Event | Trigger |
|-------|---------|
| `join_request` | Peer submits a join request for a CG this node curates |
| `join_approved` | This node's join request was approved by a curator |
| `project_synced` | Catch-up sync completed with new data (dataSynced > 0 or sharedMemorySynced > 0) |

These events are also stored as notifications in the dashboard database. The
Node UI subscribes to SSE for instant updates, falling back to 60-second
polling. See [17_NODE_API.md `GET /api/events`](../../dkgv10-spec/17_NODE_API.md) for protocol details.

---

## 5. Node API Changes

### New Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/agent/register` | Register a new agent (custodial or self-sovereign) |
| `GET` | `/api/agent/identity` | Get current agent's identity from Bearer token |
| `POST` | `/api/context-graph/{id}/add-participant` | Add agent to CG allowlist |
| `POST` | `/api/context-graph/{id}/remove-participant` | Remove agent from CG allowlist |
| `GET` | `/api/context-graph/{id}/participants` | List allowed agents for a CG |
| `POST` | `/api/context-graph/register` | Register CG on-chain (required for VM publish) |
| `GET` | `/api/assertion/{name}/history` | Query assertion lifecycle provenance |
| `GET` | `/api/events` | SSE stream for join_request, join_approved, project_synced |

### Updated Routes

| Route | Change |
|-------|--------|
| `POST /api/paranet/create` | Accepts `allowedAgents: string[]` and `accessPolicy: number` |
| `POST /api/context-graph/create` | Uses `participantAgents: string[]` instead of `participantIdentityIds: bigint[]` |

### Agent Resolution

All daemon routes resolve the calling agent from the Bearer token:
1. Look up token in `validTokens` set
2. Call `agent.resolveAgentByToken(token)` to get the `agentAddress`
3. Use `agentAddress` as the actor identity for assertion creation, access checks, etc.

---

## 6. Contract Changes

### ContextGraphStorage.sol

```solidity
// Before (V9)
struct ContextGraph {
    uint72[] participantIdentityIds;
    ...
}

// After (V10)
struct ContextGraph {
    address[] participantAgents;
    ...
}
```

Events updated:
- `ContextGraphCreated(bytes32 id, address manager, address[] participantAgents, uint256 requiredSignatures)`
- `ParticipantAdded(bytes32 id, address agent)`
- `ParticipantRemoved(bytes32 id, address agent)`

### KnowledgeAssets.sol

`publishBatch` co-signatures now use `address[] calldata participantAgents` instead of `uint72[]`.

### ContextGraphs.sol

`_verifyParticipantSignatures` now verifies `ecrecover` against agent addresses, not identity storage lookups.

---

## 7. Ontology Updates

New predicates added to `genesis.ts`:

| Predicate | Purpose |
|-----------|---------|
| `dkg:allowedAgent` | Agent address in CG allowlist (replaces `dkg:allowedPeer` for agent-level access) |
| `dkg:agentAddress` | Agent's Ethereum address (in system agents graph) |
| `dkg:agentMode` | `"custodial"` or `"self-sovereign"` |
| `dkg:agentAuthToken` | Bearer token for API authentication |

`dkg:allowedPeer` is retained for backward compatibility but deprecated in favor of `dkg:allowedAgent`.
