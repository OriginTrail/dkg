# DKG V9 Protocol Operations — Sequence Diagrams & Analysis

> End-to-end flows for every V9 protocol operation: publish (standard,
> workspace + enshrine, context graph), update, query, sync, gossip,
> and chain integration. Includes on-chain vs off-chain split and
> improvement notes.

---

## Table of Contents

1. [Node Boot Sequence](#1-node-boot-sequence)
2. [Publish Operation](#2-publish-operation)
   - 2.1 [Standard Publish Flow](#21-standard-publish-flow)
   - 2.2 [Workspace + Enshrine Flow (Deferred Publish)](#22-workspace--enshrine-flow-deferred-publish)
   - 2.3 [Context Graph Publish Flow](#23-context-graph-publish-flow)
   - 2.4 [Publish Flow Comparison](#24-publish-flow-comparison)
   - 2.5 [Signature Types](#25-signature-types)
3. [Chain Event Confirmation](#3-chain-event-confirmation)
4. [Update Operation](#4-update-operation)
5. [Query Operation](#5-query-operation)
6. [Peer Sync](#6-peer-sync)
7. [Paranet Discovery](#7-paranet-discovery)
8. [GossipSub Topic Architecture](#8-gossipsub-topic-architecture)
9. [Storage Model](#9-storage-model)
10. [Merkle Tree & Proof System](#10-merkle-tree--proof-system)
11. [On-Chain vs Off-Chain Data](#11-on-chain-vs-off-chain-data)
12. [Protocol-Level Review & Improvements](#12-protocol-level-review--improvements)

---

## 1. Node Boot Sequence

```mermaid
sequenceDiagram
    participant CLI as dkg daemon
    participant Agent as DKGAgent
    participant Node as DKGNode (libp2p)
    participant Store as TripleStore
    participant Chain as EVM Adapter
    participant Relay as Relay Node
    participant DHT as Kademlia DHT

    CLI->>CLI: Load ~/.dkg/config.json + wallets.json
    CLI->>CLI: Verify genesis networkId

    CLI->>Agent: DKGAgent.create(config)
    Agent->>Store: createTripleStore(backend: "oxigraph")
    Agent->>Node: new DKGNode(listenPort, privateKey, relayPeers)
    Agent->>Chain: new EVMAdapter(rpcUrl, hubAddress, opKeys)

    Agent->>Node: start()
    Node->>Node: createLibp2p(tcp, websockets, noise, yamux, gossipsub, kadDHT)
    Node->>Relay: dial(relayMultiaddr)
    Relay-->>Node: Circuit relay reservation granted
    Node->>DHT: Bootstrap peer discovery

    Agent->>Agent: Create Publisher, PublishHandler, WorkspaceHandler
    Agent->>Agent: Create ChainEventPoller
    Agent->>Agent: Register protocol handlers

    Note over Agent: Protocol handlers registered:
    Note over Agent: /dkg/publish/1.0.0 — direct publish
    Note over Agent: /dkg/query/2.0.0 — remote query
    Note over Agent: /dkg/sync/1.0.0 — bulk sync
    Note over Agent: /dkg/access/1.0.0 — private data access
    Note over Agent: /dkg/discover/1.0.0 — peer discovery

    Note over Agent: /dkg/query and /dkg/access are separate paths
    Note over Agent: query is deny-by-default (queryAccess)
    Note over Agent: access checks KA/KC metadata policy for private triples

    opt Chain available (chainId ≠ "none")
        Agent->>Chain: ensureProfile() → identityId
    end
    Agent->>Agent: publishProfile() → agent ontology triples

    loop For each configured paranet
        Agent->>Agent: ensureParanetLocal(paranetId)
        Agent->>Agent: subscribeToParanet(paranetId)
        Note over Agent: Subscribe to: publish, workspace, app, update, sessions topics
    end

    Agent->>Chain: Start ChainEventPoller (interval: 12s)
    Agent->>Agent: Start periodic peer ping (interval: 2min)
    Agent->>Chain: Initial chain scan for paranets
```

---

## 2. Publish Operation

### 2.1 Standard Publish Flow

The standard publish follows a **replicate-then-attest** protocol: data is
staged in the workspace, broadcast to peers via GossipSub, peers push
attestation signatures back to the publisher, and the publisher submits a
single on-chain transaction with the collected signatures.

**Key design decisions:**

- **Workspace as universal staging.** Data is stored in the workspace graph
  first. The data graph only contains chain-confirmed data.
- **GossipSub for dissemination, direct RPC for attestation.** The gossip
  message includes the publisher's `peerId` so that any peer in the mesh —
  including peers multiple relay hops away — can dial back directly.
- **Peer-push, not publisher-pull.** Peers self-select after receiving the
  gossip and push their signatures to the publisher. This decouples quorum
  collection from the publisher's local peer table.

```mermaid
sequenceDiagram
    participant App as Application
    participant Agent as DKGAgent
    participant Pub as DKGPublisher
    participant Store as TripleStore
    participant Chain as EVM Adapter
    participant GS as GossipSub
    participant Peers as Receiver Nodes

    App->>Agent: publish(paranetId, quads, privateQuads?)
    Agent->>Pub: publish(options)

    rect rgb(240, 240, 255)
        Note over Pub,Store: Phases 1–3 are LOCAL to the publishing node

        Note over Pub: Phase 1 — Prepare + validate

        Pub->>Pub: ensureParanet(paranetId)
        Pub->>Pub: autoPartition(quads) → group by rootEntity
        Pub->>Pub: Build manifest + KA metadata
        Pub->>Pub: validatePublishRequest(quads, manifest, paranetId)
        Note over Pub: Rules 1–5: graph URI, subjects, manifest, exclusivity, no blank nodes

        Note over Pub: Phase 2 — Compute Merkle roots

        opt privateQuads present
            Pub->>Pub: computePrivateRoot(private quads)
            Pub->>Pub: Add synthetic private commitment hash to leaf set
        end
        Pub->>Pub: Compute kcMerkleRoot (flat tree over all public triple hashes)
        Pub->>Pub: Compute publicByteSize (canonical N-Triples encoding)

        Note over Pub,Store: Phase 3 — Store in workspace (local staging)

        Pub->>Store: insert(quads → workspace graph)
        Pub->>Store: insert(workspace metadata → workspace_meta graph)
        opt Private quads provided
            Pub->>Store: storePrivateTriples(paranetId, rootEntity, privateQuads)
        end
    end

    Note over Agent,Peers: Phase 4 — Broadcast via GossipSub (dissemination)

    Pub-->>Agent: preBroadcast(preparedPublish)
    Agent->>GS: publish(paranetPublishTopic, PublishRequest)
    Note over GS: Message contains:<br/>nquads, paranetId, manifest, merkleRoot,<br/>publisherPeerId (return address), operationId,<br/>deadline, publicByteSize<br/>NO txHash, NO blockNumber (not yet on-chain)
    GS-->>Peers: PublishRequest (relayed through mesh)

    rect rgb(232, 245, 233)
        Note over Agent,Peers: Phase 5 — Peer-push attestation (Direct RPC)

        Note over Peers: Each peer that receives the gossip (any hop distance):
        Peers->>Peers: Validate + store in workspace graph
        Peers->>Peers: Recompute merkleRoot from stored quads
        Peers->>Peers: Verify merkleRoot and publicByteSize match
        Peers->>Peers: Sign keccak256(merkleRoot, publicByteSize)
        Peers->>Agent: Dial publisher's peerId via /dkg/attest/1.0.0
        Note over Peers,Agent: Send: {operationId, identityId, signatureR, signatureVs}

        Note over Agent: Publisher collects incoming attestations:
        Agent->>Agent: Deduplicate by identityId
        Agent->>Agent: Accumulate until quorum reached or deadline expires
        Note over Agent: First N valid unique signatures win
    end

    rect rgb(232, 245, 233)
        Note over Pub,Chain: Phase 6 — Submit on-chain publish

        Pub->>Pub: Sign publisher commitment: keccak256(identityId, merkleRoot)
        Pub->>Chain: publishKnowledgeAssets({kaCount, merkleRoot, publicByteSize,<br/>tokenAmount, publisherSignature, receiverSignatures[]})
        Note over Chain: Contract verifies publisher + receiver signatures
        Note over Chain: Contract checks minimumRequiredSignatures threshold
        Chain-->>Pub: OnChainPublishResult {txHash, batchId, blockNumber, startKAId, endKAId}
        Note over Chain: Emits: UALRangeReserved, KnowledgeBatchCreated
    end

    Note over Pub,Store: Phase 7 — Promote workspace → data graph

    Pub->>Store: Copy quads: workspace graph → data graph
    Pub->>Store: Delete quads from workspace graph
    Pub->>Pub: generateConfirmedFullMetadata(ual, merkleRoot, txHash, batchId, ...)
    Pub->>Store: insert(confirmed metadata → meta graph)
    Pub->>Pub: Track ownedEntities + batch→paranet binding

    Note over Agent,GS: Phase 8 — Post-broadcast with chain proof

    Pub-->>Agent: PublishResult {kcId, ual, merkleRoot, status: confirmed}
    Agent->>GS: publish(paranetPublishTopic, confirmed PublishRequest)
    Note over GS: Now includes: txHash, blockNumber,<br/>startKAId, endKAId, publisherAddress<br/>Peers verify on-chain + promote workspace → data graph

    Agent-->>App: PublishResult
```

### 2.2 Workspace + Enshrine Flow (Deferred Publish)

This is the same protocol as standard publish, but split into two user-controlled
phases: **stage now, publish later.** The workspace is used for collaborative
drafting — data may be revised, discussed, or accumulated over hours or days
before committing on-chain.

`publish()` is syntactic sugar for `writeToWorkspace()` + immediate
`enshrineFromWorkspace()`. The underlying protocol is identical.

```mermaid
sequenceDiagram
    participant App as Application
    participant Agent as DKGAgent
    participant Store as TripleStore
    participant GS as GossipSub
    participant Peers as Receiver Nodes
    participant Chain as EVM Adapter

    Note over App,Peers: Step A — Write to workspace (can happen many times)

    App->>Agent: writeToWorkspace(paranetId, quads)

    rect rgb(240, 240, 255)
        Note over Agent,Store: LOCAL: validate + store in workspace
        Agent->>Agent: autoPartition(quads) → group by rootEntity
        Agent->>Agent: validatePublishRequest(quads, manifest, paranetId)
        Agent->>Store: insert(quads → workspace graph)
        Agent->>Store: insert(workspace metadata → workspace_meta graph)
    end

    Agent->>GS: publish(paranetWorkspaceTopic, WorkspacePublishRequest)
    GS-->>Peers: WorkspacePublishRequest
    Peers->>Peers: Validate + store in workspace graph

    Note over App,Chain: Time passes — hours, days, revisions...

    Note over App,Peers: Step B — Enshrine from workspace (triggers publish flow)

    App->>Agent: enshrineFromWorkspace(paranetId, selection)

    rect rgb(240, 240, 255)
        Note over Agent,Store: LOCAL: read staged data from workspace
        Agent->>Store: CONSTRUCT quads from workspace graph (by selection)
        Agent->>Agent: Compute merkleRoot + publicByteSize from workspace quads
    end

    Note over Agent,Peers: No pre-broadcast needed — peers already have workspace data

    rect rgb(232, 245, 233)
        Note over Agent,Peers: Collect receiver attestations (same peer-push mechanism)
        Agent->>GS: publish(paranetPublishTopic, attestation request with publisherPeerId)
        Peers->>Peers: Verify workspace data matches merkleRoot
        Peers->>Peers: Sign keccak256(merkleRoot, publicByteSize)
        Peers->>Agent: Dial back via /dkg/attest/1.0.0 with signature
        Agent->>Agent: Collect until quorum or deadline
    end

    rect rgb(232, 245, 233)
        Note over Agent,Chain: Submit on-chain publish
        Agent->>Chain: publishKnowledgeAssets({..., receiverSignatures[]})
        Chain-->>Agent: OnChainPublishResult {txHash, batchId, ...}
    end

    Note over Agent,Store: Promote workspace → data graph
    Agent->>Store: Copy quads: workspace graph → data graph
    Agent->>Store: Delete quads from workspace graph
    Agent->>Store: insert(confirmed metadata → meta graph)

    Agent->>GS: Broadcast finalization with chain proof
    Agent-->>App: PublishResult {status: confirmed}
```

**Key differences from standard publish:**

| Aspect | Standard publish | Workspace + enshrine |
|--------|-----------------|---------------------|
| **Data already gossip-replicated?** | No — pre-broadcast needed in Phase 4 | Yes — workspace gossip happened during writeToWorkspace |
| **Timing** | Immediate — one API call | Deferred — two API calls, arbitrary time gap |
| **Revisions** | Not possible — data is committed | Workspace supports upsert before enshrine |
| **Attestation trigger** | Gossip message with publisherPeerId | Same mechanism — peers verify workspace data |

### 2.3 Context Graph Publish Flow

A context graph is a **curated, governance-gated subgraph** within a paranet.
M-of-N registered participants must sign before data can be published to it.
The publish is **atomic** — a single on-chain transaction handles both the base
publish (receiver signatures) and the context graph registration (participant
signatures). If either set of signatures is insufficient, nothing is published.

**Key concepts:**

- A context graph is **scoped to a paranet** via URI convention:
  `did:dkg:paranet:{paranetId}/context/{contextGraphId}`
- Participants are registered on-chain at context graph creation with an M-of-N
  threshold. The protocol's `minimumRequiredSignatures` does NOT apply — each
  context graph defines its own requirements.
- Data is gossip-replicated to ALL paranet peers (for availability), but only
  lands in the context graph URI after the atomic chain tx succeeds.
- **Receiver signatures** (replication proof) and **participant signatures**
  (governance consent) are collected in parallel before the chain tx.

```mermaid
sequenceDiagram
    participant App as Application / Game Coordinator
    participant Agent as DKGAgent (Publisher)
    participant Store as TripleStore
    participant GS as GossipSub
    participant ParaPeers as Paranet Peers
    participant CGPeers as Context Graph Participants
    participant Chain as EVM Adapter

    Note over App,Chain: Prerequisites: context graph already created on-chain<br/>with participantIdentityIds[] and requiredSignatures (M of N)

    App->>Agent: publish(paranetId, quads, {contextGraphId})

    rect rgb(240, 240, 255)
        Note over Agent,Store: LOCAL: Prepare + validate + store in workspace
        Agent->>Agent: autoPartition, validate, compute merkleRoot + publicByteSize
        Agent->>Store: insert(quads → workspace graph)
    end

    Note over Agent,ParaPeers: Phase 4 — Broadcast via GossipSub (to all paranet peers)

    Agent->>GS: publish(paranetPublishTopic, PublishRequest)
    Note over GS: Contains: publisherPeerId, merkleRoot,<br/>contextGraphId, deadline
    GS-->>ParaPeers: PublishRequest (relayed through mesh)
    GS-->>CGPeers: PublishRequest (participants are also paranet peers)
    ParaPeers->>ParaPeers: Validate + store in workspace graph
    CGPeers->>CGPeers: Validate + store in workspace graph

    rect rgb(232, 245, 233)
        Note over Agent,ParaPeers: Phase 5a — Collect receiver attestations (from any paranet peer)

        ParaPeers->>ParaPeers: Verify merkleRoot, sign keccak256(merkleRoot, publicByteSize)
        ParaPeers->>Agent: Dial back via /dkg/attest/1.0.0
        Agent->>Agent: Collect receiver sigs until quorum or deadline
    end

    rect rgb(255, 243, 224)
        Note over App,CGPeers: Phase 5b — Collect participant signatures (governance)

        Note over App: Application-defined coordination mechanism<br/>(e.g., game turn proposal/approval, voting protocol, manual review)

        CGPeers->>CGPeers: Verify data matches proposal
        CGPeers->>CGPeers: Sign keccak256(contextGraphId, merkleRoot)
        CGPeers-->>App: Participant signature {identityId, r, vs}

        App->>App: Collect M-of-N participant signatures
        Note over App: If < M participants sign → publish fails entirely<br/>(no orphaned data in paranet)
    end

    rect rgb(232, 245, 233)
        Note over Agent,Chain: Phase 6 — Atomic on-chain publish

        Agent->>Chain: publishToContextGraph({<br/>  kaCount, merkleRoot, publicByteSize, tokenAmount,<br/>  publisherSignature,<br/>  receiverSignatures[],<br/>  contextGraphId, participantSignatures[]<br/>})
        Note over Chain: Contract verifies ALL signatures atomically:<br/>• Publisher commitment<br/>• Receiver attestations (≥ minimumRequired)<br/>• Participant governance (≥ context graph M-of-N)
        Chain-->>Agent: {txHash, batchId, blockNumber, contextGraphExpanded}
        Note over Chain: Emits: KnowledgeBatchCreated + ContextGraphExpanded
    end

    Note over Agent,Store: Phase 7 — Promote workspace → context graph

    Agent->>Store: Copy quads: workspace → context graph data URI
    Agent->>Store: Delete quads from workspace graph
    Agent->>Store: insert(confirmed metadata → context graph meta URI)
    Note over Store: Data lives at did:dkg:paranet:{id}/context/{ctxId}<br/>NOT in the paranet data graph

    Agent->>GS: Broadcast chain proof (for peer promotion)
    Agent-->>App: PublishResult {status: confirmed, contextGraphId}
```

#### How participant signature collection works

The protocol provides the **signing primitive** but NOT the coordination mechanism.
How participants learn about the proposal and decide to sign is application-specific:

| Application | Coordination mechanism | Timing |
|-------------|----------------------|--------|
| **Game (turn resolution)** | Leader broadcasts `turn:proposal` via app topic; peers respond with `turn:approve` + signature | During turn resolution, before enshrine |
| **Manual curation** | Dashboard shows pending proposals; curators sign via UI | Asynchronous, human-in-the-loop |
| **Automated pipeline** | Service monitors workspace writes; auto-signs if validation passes | Event-driven, immediate |

The protocol only requires: M-of-N valid signatures over `keccak256(contextGraphId, merkleRoot)`,
collected before the chain tx. How they're collected is up to the application.

#### What if participant signatures are insufficient?

```mermaid
sequenceDiagram
    participant App as Application
    participant Agent as DKGAgent

    App->>Agent: publish(paranetId, quads, {contextGraphId})
    Agent->>Agent: Collect receiver sigs ✓
    Agent->>Agent: Collect participant sigs... only 1 of 3 required

    alt Strict mode (default for context graphs)
        Agent-->>App: PublishResult {status: failed, error: "insufficient participant signatures"}
        Note over Agent: Data stays in workspace, nothing on-chain
        Note over Agent: No orphaned data in paranet — clean failure
    end

    alt Fallback mode (application opts in)
        Agent->>Agent: Drop contextGraphId, publish to paranet only
        Agent-->>App: PublishResult {status: confirmed, contextGraphError: "insufficient sigs, fell back to paranet"}
        Note over Agent: Data in paranet data graph, NOT in context graph
    end
```

### 2.4 Publish Flow Comparison

| | Standard publish | Workspace + enshrine | Context graph publish |
|---|---|---|---|
| **Target** | Paranet data graph | Paranet data graph | Context graph (within paranet) |
| **Staging** | Workspace (automatic) | Workspace (manual write) | Workspace (automatic or manual) |
| **Receiver sigs** | Required (peer-push) | Required (peer-push) | Required (peer-push) |
| **Participant sigs** | Not needed | Not needed | Required (M-of-N, app-defined collection) |
| **Chain tx** | `publishKnowledgeAssets` | `publishKnowledgeAssets` | `publishToContextGraph` (atomic) |
| **Failure behavior** | Rollback workspace | Rollback workspace | Strict: fail entirely / Fallback: paranet-only |
| **Data lands in** | `did:dkg:paranet:{id}` | `did:dkg:paranet:{id}` | `did:dkg:paranet:{id}/context/{ctxId}` |

### 2.5 Signature Types

| Signature type | Purpose | Signed over | Collected from |
|---|---|---|---|
| **Publisher signature** | Publisher commits to the batch | `keccak256(identityId, merkleRoot)` | Publisher's own operational key |
| **Receiver signatures** | Peers attest data replication | `keccak256(merkleRoot, publicByteSize)` | Any paranet peer (peer-push after gossip) |
| **Participant signatures** | Governance consent for context graph | `keccak256(contextGraphId, merkleRoot)` | Registered context graph participants only |

Receiver signatures prove replication. Participant signatures prove governance consent.
They serve different trust models, are collected through different mechanisms, and are
verified by different on-chain logic.

---

## 3. Chain Event Confirmation

Receiver nodes use the ChainEventPoller as a **fallback confirmation mechanism**.
The primary path is the post-broadcast in Phase 8 (section 2.1), where the
publisher gossips chain proof and peers promote workspace → data graph. The
poller catches any events missed due to gossip failures or node restarts.

```mermaid
sequenceDiagram
    participant Poller as ChainEventPoller
    participant Chain as EVM Adapter
    participant PH as PublishHandler
    participant Store as TripleStore

    loop Every 12 seconds
        Poller->>Poller: Check: hasUnconfirmedWorkspaceData?
        alt Has unconfirmed workspace data
            Poller->>Chain: listenForEvents({fromBlock: lastBlock+1, types: ["KnowledgeBatchCreated"]})

            loop For each KnowledgeBatchCreated event
                Chain-->>Poller: {merkleRoot, publisherAddress, startKAId, endKAId, blockNumber}
                Poller->>PH: confirmByMerkleRoot(merkleRoot, chainData)
                PH->>PH: Find workspace data with matching merkleRoot
                alt Match found
                    PH->>Store: Copy quads: workspace graph → data graph
                    PH->>Store: Delete quads from workspace graph
                    PH->>Store: Insert confirmed metadata + chain provenance
                    PH-->>Poller: promoted = true
                else No match
                    PH-->>Poller: promoted = false
                end
            end

            Poller->>Poller: Update lastBlock
        end
    end
```

> **Workspace data expiry:** Workspace data that is never confirmed on-chain
> expires after a configurable timeout. This is safe — TRAC was never locked,
> so no economic harm. The publisher can retry with a new publish cycle.

### Chain Events Emitted

| Event | Source Contract | Fields | Purpose |
|-------|---------------|--------|---------|
| `KnowledgeBatchCreated` | KnowledgeAssetsStorage | batchId, publisher, merkleRoot, startKAId, endKAId, txHash | Confirm published data, trigger workspace → data graph promotion |
| `UALRangeReserved` | KnowledgeAssetsStorage | publisher, startId, endId | UAL allocation |
| `ParanetCreated` | ParanetV9Registry | paranetId, creator, accessPolicy | Discover new paranets |
| `KnowledgeBatchUpdated` | KnowledgeAssetsStorage | batchId, newMerkleRoot | Confirm data updates |
| `ContextGraphCreated` | ContextGraphStorage | contextGraphId, manager, participantIds, M | Context graph creation |
| `ContextGraphExpanded` | ContextGraphStorage | contextGraphId, batchId | Context graph data addition |


---

## 4. Update Operation

```mermaid
sequenceDiagram
    participant App as Application
    participant Agent as DKGAgent
    participant Pub as DKGPublisher
    participant Store as TripleStore
    participant Chain as EVM Adapter
    participant GS as GossipSub

    App->>Agent: update(kcId, paranetId, quads)

    Agent->>Pub: update(kcId, options)

    Pub->>Pub: Validate quads (same rules)
    Pub->>Pub: Compute new merkle root

    Pub->>Store: Delete old data for affected rootEntities
    Pub->>Store: Insert new quads into data graph

    Pub->>Chain: updateKnowledgeAssets({batchId, newMerkleRoot, signatures})
    Chain-->>Pub: TxResult {txHash, blockNumber}
    Chain->>Chain: Emit KnowledgeBatchUpdated

    Pub->>Store: Update meta graph (new merkle root, timestamp)
    Pub-->>Agent: PublishResult {kcId, ual, status: "confirmed"}

    Agent->>GS: publish(paranetUpdateTopic, UpdateRequest)

    Note over GS: Receivers verify via chain.verifyKAUpdate()<br/>then apply update in canonical order
```

> **REVIEW: Update ordering.**
> Updates are applied in canonical `(blockNumber, txIndex)` order. This is
> correct for consistency, but there's no mechanism for conflict resolution
> if two publishers update overlapping entities in the same block. The first
> tx wins (by txIndex), but the second publisher gets no notification of
> the conflict.

---

## 5. Query Operation

```mermaid
sequenceDiagram
    participant App as Application
    participant Agent as DKGAgent
    participant QE as DKGQueryEngine
    participant Store as TripleStore

    App->>Agent: query(sparql, {paranetId, includeWorkspace?})

    Agent->>QE: query(sparql, options)

    QE->>QE: validateReadOnlySparql(sparql)
    Note over QE: Rejects: INSERT, DELETE, LOAD, CLEAR, DROP, CREATE, COPY, MOVE, ADD
    Note over QE: Accepts: SELECT, CONSTRUCT, ASK, DESCRIBE

    alt includeWorkspace = true
        QE->>Store: query(sparql, scoped to data graph)
        Store-->>QE: dataBindings
        QE->>Store: query(sparql, scoped to workspace graph)
        Store-->>QE: workspaceBindings
        QE->>QE: Merge: [...dataBindings, ...workspaceBindings]
    else Normal query
        QE->>QE: wrapWithGraph(sparql, dataGraphUri)
        QE->>Store: query(wrappedSparql)
        Store-->>QE: bindings
    end

    QE-->>Agent: {bindings: [...]}
    Agent-->>App: QueryResult

    Note over QE: Design: LOCAL ONLY — no remote query<br/>Data must arrive via publish/sync first
```

### Query Access Policy

```typescript
interface ParanetQueryPolicy {
  policy: 'deny' | 'public' | 'allowList';
  allowedPeers?: string[];
  allowedLookupTypes?: LookupType[];
  sparqlEnabled?: boolean;
  sparqlTimeout?: number;
  sparqlMaxResults?: number;
}
```

> **REVIEW: Query isolation.**
> The query engine is intentionally local-only (Spec §1.6 Store Isolation).
> This means a node can only query data it has received via publish/sync.
> **Implication for apps:** If an app needs data from a paranet it hasn't
> synced, it must first sync from a peer. There's no query federation.
> This is a conscious design choice for privacy/security, but may frustrate
> app developers expecting a "world computer" model.

### Private Access (cross-agent)

Private triple retrieval uses a separate protocol and policy path from remote query.

- **Protocol:** `/dkg/access/1.0.0` — requester sends KA UAL + signature; provider
  returns private N-Quads if access is granted.
- **Handler:** `AccessHandler` checks KA/KC metadata (`dkg:accessPolicy`,
  `dkg:publisherPeerId`, `dkg:allowedPeer`) before returning private triples.
- **Client:** `AccessClient` verifies returned triples against `privateMerkleRoot`
  when available.

Effective policy rules:

- `ownerOnly` -> only publisher peer may access.
- `allowList` -> only peers listed by KC metadata `dkg:allowedPeer` may access.
- `allowList` with missing or empty `dkg:allowedPeer` entries -> access denied.
- `public` -> any peer may request private triples for that KA.

> **Security note:** `/dkg/query/2.0.0` and `/dkg/access/1.0.0` are independent.
> A denied remote query does not imply denied private access. Access behavior is
> controlled by KC/KA access metadata.

---

## 6. Peer Sync

```mermaid
sequenceDiagram
    participant A as Node A (requester)
    participant B as Node B (provider)

    A->>B: /dkg/sync/1.0.0 SyncRequest {paranetIds, fromTimestamp?}

    B->>B: Query meta graph for KCs matching filters
    B->>B: Serialize data + metadata

    B-->>A: SyncResponse {quads[], metadata[]}

    A->>A: For each KC in response:
    A->>A: verifySyncedData(quads, metadata)

    Note over A: Merkle verification:
    Note over A: 1. computePublicRoot(quads) per rootEntity
    Note over A: 2. computeKARoot(publicRoot, privateRoot?)
    Note over A: 3. computeKCRoot(kaRoots[])
    Note over A: 4. Compare to merkleRoot in metadata

    alt Merkle root matches
        A->>A: Insert quads into data graph
        A->>A: Insert metadata into meta graph
    else Mismatch
        A->>A: Reject — data tampered or incomplete
    end
```

### Workspace Sync

```mermaid
sequenceDiagram
    participant A as Node A
    participant B as Node B

    A->>B: /dkg/sync/1.0.0 WorkspaceSyncRequest {paranetIds}

    B->>B: Export workspace + workspace_meta quads
    B-->>A: WorkspaceSyncResponse {quads[]}

    A->>A: Insert into workspace graph
    A->>A: Update workspaceOwnedEntities
```

> **REVIEW: Sync completeness.**
> Workspace sync does NOT include the `workspaceOwnedEntities` map.
> A synced node cannot enforce creator-only upsert for workspace entities
> it received via sync. This is a known limitation.

---

## 7. Paranet Discovery

```mermaid
sequenceDiagram
    participant Agent as DKGAgent
    participant Chain as EVM Adapter
    participant Store as TripleStore

    Agent->>Chain: listParanetsFromChain(fromBlock?)

    loop For each ParanetCreated event
        Chain-->>Agent: {paranetId, creator, accessPolicy, blockNumber}
        Agent->>Agent: ensureParanetLocal(paranetId)
        Agent->>Store: createGraph(data, meta, private, workspace, workspace_meta)
        Agent->>Agent: subscribeToParanet(paranetId)
        Note over Agent: Subscribe to 5 GossipSub topics
    end

    Note over Agent: Also discovered via:<br/>- ChainEventPoller (ParanetCreated events)<br/>- Peer sync (paranets in synced metadata)<br/>- Config file (paranets[] array)
```

---

## 8. GossipSub Topic Architecture

```mermaid
graph TB
    subgraph "System Topics"
        PEERS["dkg/network/peers"]
    end

    subgraph "Per-Paranet Topics"
        PUB["dkg/paranet/{id}/publish"]
        WS["dkg/paranet/{id}/workspace"]
        APP["dkg/paranet/{id}/app"]
        UPD["dkg/paranet/{id}/update"]
        SESS["dkg/paranet/{id}/sessions"]
    end

    subgraph "Per-Session Topics"
        S1["dkg/paranet/{id}/sessions/{sid}"]
    end

    subgraph "System Paranets"
        AGENTS["dkg/paranet/agents/publish"]
        ONTO["dkg/paranet/ontology/publish"]
    end
```

| Topic | Purpose | Message Types |
|-------|---------|---------------|
| `dkg/network/peers` | Peer discovery & health | Peer announce, capabilities |
| `dkg/paranet/{id}/publish` | Publish broadcast (pre- and post-chain) | PublishRequest (pre-chain: data + publisherPeerId; post-chain: + txHash, blockNumber) |
| `dkg/paranet/{id}/workspace` | Workspace writes (deferred publish staging) | WorkspacePublishRequest |
| `dkg/paranet/{id}/app` | Application coordination | JSON app messages (game, etc.) |
| `dkg/paranet/{id}/update` | KA updates | UpdateRequest |
| `dkg/paranet/{id}/sessions` | Multi-party sessions | Session proposals, coordination |
| `dkg/paranet/{id}/sessions/{sid}` | Per-session messages | Round data, commitments |

> **REVIEW: App topic is untyped.**
> The `app` topic carries JSON messages with an `app` field for routing (e.g.
> `"origin-trail-game"`). All apps on the same paranet share a single topic.
> **Risk:** A malicious app could flood the topic, affecting all apps. Consider
> per-app subtopics: `dkg/paranet/{id}/app/{appId}`.

---

## 9. Storage Model

```mermaid
graph TB
    subgraph "Triple Store (Oxigraph)"
        subgraph "Paranet: origin-trail-game"
            DATA["Data Graph<br/>did:dkg:paranet:origin-trail-game<br/>Published triples + player profiles"]
            META["Meta Graph<br/>.../_meta<br/>KC/KA metadata, merkle roots, status"]
            PRIV["Private Graph<br/>.../_private<br/>Publisher-only triples"]
            WS["Workspace Graph<br/>.../_workspace<br/>Swarms, memberships, votes"]
            WS_META["Workspace Meta<br/>.../_workspace_meta<br/>Operation tracking"]
        end

        subgraph "Context Graphs (per swarm)"
            CTX["did:dkg:paranet:.../context/{swarmId}<br/>Turn results (published)"]
            CTX_META["...context/{swarmId}/_meta<br/>Turn result metadata"]
        end
    end
```

### Graph URI Patterns

| Pattern | Example | Content |
|---------|---------|---------|
| `did:dkg:paranet:{id}` | `did:dkg:paranet:origin-trail-game` | Published data |
| `did:dkg:paranet:{id}/_meta` | `.../_meta` | KC/KA metadata |
| `did:dkg:paranet:{id}/_private` | `.../_private` | Private triples |
| `did:dkg:paranet:{id}/_workspace` | `.../_workspace` | Workspace data |
| `did:dkg:paranet:{id}/_workspace_meta` | `.../_workspace_meta` | Workspace ops |
| `did:dkg:paranet:{id}/context/{ctxId}` | `.../context/swarm-abc123` | Context graph data |
| `did:dkg:paranet:{id}/context/{ctxId}/_meta` | `.../context/swarm-abc123/_meta` | Context graph meta |

`_private` graph behavior:

- Not included in normal peer sync (`/dkg/sync/1.0.0`) or standard query replication.
- Retrieved only through `/dkg/access/1.0.0` when access policy permits.

---

## 10. Merkle Tree & Proof System

```mermaid
graph TB
    subgraph "Knowledge Collection (KC)"
        KC_ROOT["KC Merkle Root<br/>(published on-chain)"]
    end

    subgraph "Knowledge Assets (KAs)"
        KA1["KA Root 1"]
        KA2["KA Root 2"]
        KA3["KA Root 3"]
    end

    subgraph "KA1 Internals"
        PUB1["Public Root<br/>sha256(sorted triple hashes)"]
        PRIV1["Private Root<br/>sha256(sorted private triple hashes)"]
    end

    subgraph "KA2 Internals (public only)"
        PUB2["Public Root"]
    end

    subgraph "KA3 Internals (private only)"
        PRIV3["Private Root"]
    end

    KC_ROOT --- KA1
    KC_ROOT --- KA2
    KC_ROOT --- KA3

    KA1 --- PUB1
    KA1 --- PRIV1
    KA2 --- PUB2
    KA3 --- PRIV3
```

### Merkle Computation

1. **Triple hash:** SHA-256 of the NQuad serialization of each triple.
2. **Public root:** Merkle tree over sorted triple hashes for a rootEntity.
3. **Private root:** Merkle tree over sorted private triple hashes (publisher-only).
4. **KA root:** `sha256(publicRoot || privateRoot)` — or just the one that exists.
5. **KC root:** Merkle tree over sorted KA roots.
6. **On-chain:** Only the KC root (32 bytes) goes on-chain.

### Verification

```
Verifier receives: quads[], metadata{merkleRoot, kaManifest[]}

For each KA in manifest:
  1. Filter quads for rootEntity + skolemized children
  2. Hash each quad → sorted list
  3. Build merkle tree → publicRoot
  4. KA root = computeKARoot(publicRoot, privateMerkleRoot?)

Collect KA roots → sorted → build merkle tree → kcRoot
Compare kcRoot === metadata.merkleRoot ✓
```

> **REVIEW: Entity-proofs mode.**
> When `entityProofs: true`, each KA has its own sub-tree enabling selective
> disclosure (prove entity 2 without revealing entity 1). This is powerful
> but adds overhead. Currently off by default — consider making it the default
> for paranets with privacy requirements.

---

## 11. On-Chain vs Off-Chain Data

### On-Chain (Base Sepolia)

| Data | Contract | Purpose |
|------|----------|---------|
| KC Merkle Root | KnowledgeAssetsStorage | Integrity anchor — verifies off-chain data hasn't been tampered |
| KA token range | KnowledgeAssetsStorage | NFT ownership — startKAId to endKAId |
| Publisher address | KnowledgeAssetsStorage | Attribution — who published this data |
| Batch ID | KnowledgeAssetsStorage | Sequential ordering |
| Paranet ID | ParanetV9Registry | Paranet existence and access policy |
| TRAC stake | Token contract | Storage payment |
| Identity ID | Identity contract | DID ↔ on-chain identity binding |

### Off-Chain (Triple Store + GossipSub)

| Data | Storage | Propagation |
|------|---------|-------------|
| Published triples | Data graph | GossipSub publish topic |
| KC/KA metadata | Meta graph | GossipSub publish topic |
| Private triples | Private graph | NEVER propagated (publisher only) |
| Workspace data | Workspace graph | GossipSub workspace topic |
| App messages | In-memory | GossipSub app topic |

Access-policy linkage (off-chain):

- Access control for private triples is encoded in KC/KA metadata in `_meta`
  (e.g., `dkg:accessPolicy`, `dkg:publisherPeerId`).
- Registry-level paranet `accessPolicy` on-chain governs paranet registration/discovery
  semantics and should not be treated as a substitute for KA private data access checks.

### What Gets Linked (and What Doesn't)

```mermaid
graph LR
    subgraph "On-Chain"
        MR["merkleRoot<br/>0xabc..."]
        TX["txHash<br/>0xdef..."]
        BN["blockNumber<br/>12345678"]
        BATCH["batchId: 7"]
        ADDR["publisher<br/>0x1234..."]
        NFT["KA tokens<br/>#42..#44"]
    end

    subgraph "Meta Graph (linked)"
        KC["KC metadata<br/>dkg:status, dkg:merkleRoot,<br/>dkg:transactionHash, dkg:blockNumber,<br/>dkg:publisherAddress, dkg:batchId"]
    end

    subgraph "Data Graph (NOT linked)"
        DATA["User triples<br/>No reference to chain provenance"]
    end

    MR -.->|confirmed| KC
    TX -.->|confirmed| KC
    BN -.->|confirmed| KC
    BATCH -.->|confirmed| KC
    ADDR -.->|confirmed| KC

    KC -->|"dkg:partOf"| DATA

    style DATA fill:#3a2020,color:#e6edf3
```

> **REVIEW: Data-to-chain linking gap.**
> User-facing data triples have NO direct link to their on-chain proof.
> To verify a triple's on-chain status, an app must:
> 1. Find the rootEntity of the triple
> 2. Look up the KA in the meta graph by rootEntity
> 3. Follow `dkg:partOf` to the KC
> 4. Read `dkg:transactionHash` from the KC
>
> This is workable but fragile. A convenience triple on each rootEntity
> pointing to its KA would simplify queries:
> ```turtle
> <rootEntity>  dkg:knowledgeAsset  <ual/tokenId> .
> ```

---

## 12. Protocol-Level Review & Improvements

### 12.1 Publish Flow

| # | Issue | Severity | Recommendation |
|---|-------|----------|----------------|
| P1 | Workspace data dropped after timeout if chain tx never confirms | Medium | Make timeout configurable; add re-request via sync protocol |
| P2 | No publish receipt/ACK from receivers | Low | Consider adding a lightweight gossip ACK for publisher visibility |
| P3 | Gossip publish can be replayed (no nonce/dedup) | Medium | Add `operationId` + dedup window to GossipSub handlers |
| P4 | `broadcastPublish` has a 5s timeout; large payloads may fail | Medium | Chunk large publish payloads or use direct protocol for big KCs |

### 12.2 Workspace

| # | Issue | Severity | Recommendation |
|---|-------|----------|----------------|
| W1 | `workspaceOwnedEntities` is in-memory only | High | Persist to workspace_meta; reconstruct on startup |
| W2 | No TTL on workspace data | Medium | Add configurable TTL; old workspace ops should be prunable |
| W3 | No workspace versioning | Low | Track version/revision per rootEntity for optimistic concurrency |

### 12.3 Consensus / Game

| # | Issue | Severity | Recommendation |
|---|-------|----------|----------------|
| C1 | Leader controls random seed — can manipulate game events | Medium | Use VRF seeded by collective randomness (hash of all votes) |
| C2 | No explicit rejection message for proposals | Medium | Add `turn:reject` message type with reason |
| C3 | `expedition:launched` game state is gossip-only | High | Write to workspace so late-joining nodes can catch up |
| C4 | Turn results don't include chain provenance | High | After publish, write txHash/ual/blockNumber to context graph |
| C5 | `resultMessage` not in RDF | Low | Add `ot:resultMessage` to `turnResolvedQuads` |
| C6 | No game event entities in RDF | Medium | Create first-class `ot:GameEvent` entities per turn |
| C7 | No resource deltas in RDF | Low | Add structured resource snapshots per turn |

### 12.4 GossipSub

| # | Issue | Severity | Recommendation |
|---|-------|----------|----------------|
| G1 | `offMessage` has a bug: returns early when handlers exist | Bug | Fix: `if (!handlers) return;` should be `if (handlers)` |
| G2 | All apps share single `app` topic per paranet | Medium | Add per-app subtopics: `dkg/paranet/{id}/app/{appId}` |
| G3 | No message signing/authentication on gossip level | Medium | GossipSub supports `strictNoSign: false` — enable message signing |
| G4 | Vote heartbeat creates O(n × 6) messages per turn | Low | Acceptable for 3-8 players; not scalable beyond ~20 |

### 12.5 Chain Integration

| # | Issue | Severity | Recommendation |
|---|-------|----------|----------------|
| CH1 | Chain poller interval (12s) may miss events on fast L2s | Low | Use WebSocket subscription instead of polling where available |
| CH2 | No retry on failed chain tx (publish, mint) | Medium | Add exponential backoff retry for chain transactions |
| CH3 | Paranet metadata reveal is a separate tx | Low | Consider batching with creation tx to save gas |

### 12.6 Storage

| # | Issue | Severity | Recommendation |
|---|-------|----------|----------------|
| S1 | Oxigraph doesn't support persistent WAL by default | Low | Ensure `oxigraph-persistent` backend is used in production |
| S2 | No compaction/garbage collection for dropped graphs | Low | Add periodic graph statistics and compaction |

### 12.7 Valuable Additions for Agents

Beyond fixing the gaps above, these additions to the knowledge graph would
significantly increase utility for AI agents:

1. **Consensus attestation triples** — Which specific nodes approved which turns,
   with their peerId and the proposal hash. Enables trust scoring and reputation.

2. **Publish provenance chain** — For each rootEntity, a provenance chain linking:
   `rootEntity → KA NFT → KC → txHash → blockNumber → publisher DID`.
   Currently requires 3 SPARQL joins; should be a direct property.

3. **Network topology hints** — Relay connections, direct connections, and peer
   latency metrics as RDF triples. Helps agents choose optimal peers.

4. **Workspace lineage** — Track which workspace entities were eventually
   enshrined (published) and link workspace operations to their resulting KCs.

5. **Game-specific: strategy patterns** — Aggregate voting patterns per player
   as RDF. Which players tend to vote "advance" vs "syncMemory"? This creates
   a behavioral knowledge graph that agents can use for strategy optimization.
