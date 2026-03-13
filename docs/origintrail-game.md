# OriginTrail Game — Protocol & Knowledge Graph Reference

> How the game uses the DKG V9 protocol: context graph integration,
> sequence diagrams, RDF triples, and consensus flow.

---

## 1. Architecture Overview

The game runs as an installable DKG app (`@origintrail-official/dkg-app-origin-trail-game`).
Each node loads the game coordinator, which bridges the game engine with the
DKG network using four DKG primitives:

| Primitive | When used | Persistence |
|-----------|-----------|-------------|
| **GossipSub** (app topic) | Real-time coordination (create, join, vote, propose, approve) | Ephemeral — in-memory only |
| **Workspace** writes | Swarm creation, player joins, vote records | Node-local, replicated via gossip, no chain |
| **Context Graph** | On-chain bounded subgraph created per game; turn results enshrined into it | Permanent, M/N signature-gated, on-chain anchored |
| **enshrineFromWorkspace** | Promote workspace quads to context graph with merkle root + KC batch | Permanent, chain-anchored (merkle root + KA NFTs) |

All gossipsub messages flow through a single topic: `dkg/paranet/origin-trail-game/app`.

---

## 2. Context Graph Integration

### 2.1 One Game = One Context Graph

Each game (wagon/swarm) gets its own on-chain **context graph**, created when the
expedition launches. The context graph:

- Lists all player identity IDs as **participants**
- Requires **M = ceil(2N/3)** on-chain participant signatures (e.g. M=2 for 3 players)
- Peers sign the context graph digest (`keccak256(contextGraphId, merkleRoot)`) as part of their `turn:approve` message
- The `ContextGraphs` contract verifies each signature belongs to a registered participant and that at least M are present
- Only consensus-resolved turn results are enshrined to the context graph; force-resolved turns and ancillary data (strategy patterns, leaderboard) use plain publish

### 2.2 Context Graph Lifecycle

```mermaid
sequenceDiagram
    participant Leader as Node A (Leader)
    participant Peer as Nodes B, C
    participant Chain as Base Sepolia
    participant CG as ContextGraphs Contract
    participant KA as KnowledgeAssetsStorage

    Note over Leader,CG: Expedition Launch

    Leader->>Chain: createContextGraph({participantIds: [A,B,C], requiredSigs: 2})
    Chain->>CG: Store context graph #42 with M=2, N=3
    CG-->>Leader: contextGraphId = 42

    Note over Leader,KA: Each Consensus Turn Resolution

    Leader->>Leader: Compute turnQuads + merkleRoot
    Leader->>Leader: Sign keccak256(42, merkleRoot)
    Leader->>Peer: turn:proposal {merkleRoot, contextGraphId}
    Peer->>Peer: Verify proposal, sign digest
    Peer->>Leader: turn:approve {identityId, signatureR, signatureVS}

    Note over Leader: M=2 signatures collected (leader + 1 peer)

    Leader->>Leader: writeToWorkspace(turnQuads)
    Leader->>Chain: enshrineFromWorkspace(rootEntities, contextGraphId=42, sigs=[A, B])
    Chain->>KA: publishKnowledgeAssets(merkleRoot) → batchId
    Chain->>CG: addBatchToContextGraph(42, batchId, merkleRoot, sigs)
    CG->>CG: Verify sigs.length >= M, ecrecover matches participants
    CG-->>Leader: batch linked to context graph

    Note over Leader,CG: Game Over / Force Resolve

    Leader->>Chain: publish(strategyPatterns + leaderboard) — plain KC, no context graph
```

### 2.3 Data Flow: Workspace → Context Graph → Chain

```mermaid
graph LR
    subgraph "Ephemeral (Workspace)"
        V[Votes]
        L[Lobby / Swarm State]
        E[Expedition Launch]
    end

    subgraph "Context Graph (M/N-gated)"
        TR[Turn Results]
        CA[Consensus Attestations]
    end

    subgraph "Plain Publish (leader-only)"
        SP[Strategy Patterns]
        LB[Leaderboard Entries]
        SM[SyncMemory Events]
        FR[Force-Resolved Turns]
    end

    subgraph "On-Chain"
        CG[Context Graph Contract]
        KC_CG[KC Batches — context graph]
        KC_PLAIN[KC Batches — standalone]
        KA[KA NFTs]
    end

    V -->|multi-party signing| TR
    TR -->|enshrineFromWorkspace + M sigs| KC_CG
    CA -->|enshrineFromWorkspace + M sigs| KC_CG
    KC_CG -->|addBatchToContextGraph| CG

    SP -->|publish| KC_PLAIN
    LB -->|publish| KC_PLAIN
    SM -->|publish| KC_PLAIN
    FR -->|publish| KC_PLAIN
    KC_CG --> KA
    KC_PLAIN --> KA

    style CG fill:#2d1b4e,color:#e6edf3
    style KC_CG fill:#2d1b4e,color:#e6edf3
    style KC_PLAIN fill:#1b2d4e,color:#e6edf3
    style KA fill:#2d1b4e,color:#e6edf3
```

### 2.4 On-Chain Multi-Party Verification

The context graph uses a single, unified consensus mechanism:

1. **Gossip transport** — peers exchange votes, proposals, and signatures over GossipSub (sub-second, no gas)
2. **On-chain verification** — the `ContextGraphs` contract enforces that `M` of `N` registered participants cryptographically signed the merkle root before accepting a KC batch

| Aspect | Detail |
|--------|--------|
| **M value** | `ceil(2N/3)` — same threshold used for gossip approval |
| **What is signed** | `keccak256(contextGraphId, merkleRoot)` — ties the signature to both the context graph and the specific data batch |
| **Verification** | `ecrecover` on each signature, matched against participant identity IDs stored on the context graph |
| **Force-resolved turns** | Use plain `publish()` (not context graph) since multi-party consensus was not achieved |

This ensures that no single node can unilaterally enshrine data to the context graph — the blockchain enforces the same quorum the protocol requires.

---

## 3. Game Lifecycle — Full Sequence

### 3.1 Create Swarm + Join

```mermaid
sequenceDiagram
    participant A as Node A (Leader)
    participant DKG_A as DKG Agent A
    participant GS as GossipSub
    participant B as Node B
    participant C as Node C

    A->>DKG_A: POST /create {playerName: "Alice", swarmName: "Pioneer"}
    DKG_A->>DKG_A: Create SwarmState in memory
    DKG_A->>DKG_A: writeToWorkspace(swarmCreatedQuads + playerJoinedQuads)
    DKG_A->>GS: publish("swarm:created") {swarmId, playerName, maxPlayers, identityId}
    DKG_A-->>A: {status: "recruiting", playerCount: 1}

    GS-->>B: swarm:created
    B->>B: Store remote swarm (with leader's identityId)
    GS-->>C: swarm:created
    C->>C: Store remote swarm

    B->>B: POST /join {swarmId, playerName: "Bob"}
    B->>B: writeToWorkspace(playerJoinedQuads)
    B->>GS: publish("swarm:joined") {swarmId, playerName, identityId}
    GS-->>A: swarm:joined
    A->>A: Add Bob to swarm.players (with identityId)

    C->>C: POST /join {swarmId, playerName: "Charlie"}
    C->>C: writeToWorkspace(playerJoinedQuads)
    C->>GS: publish("swarm:joined") {swarmId, playerName, identityId}
    GS-->>A: swarm:joined
    GS-->>B: swarm:joined
```

### 3.2 Launch Expedition (creates context graph with M/N)

```mermaid
sequenceDiagram
    participant A as Node A (Leader)
    participant Chain as Base Sepolia
    participant GS as GossipSub
    participant B as Node B
    participant C as Node C

    A->>A: POST /start {swarmId}
    A->>A: gameEngine.createGame(["Alice","Bob","Charlie"])
    A->>A: M = signatureThreshold(3) = 2

    A->>Chain: createContextGraph({participantIds: [idA, idB, idC], requiredSigs: 2})
    Chain-->>A: contextGraphId = 42

    A->>A: swarm.contextGraphId = "42", swarm.requiredSignatures = 2
    A->>A: swarm.status = "traveling", currentTurn = 1
    A->>GS: publish("expedition:launched") {gameStateJson, contextGraphId: "42"}

    GS-->>B: expedition:launched
    B->>B: Parse gameState, set contextGraphId = "42"

    GS-->>C: expedition:launched
    C->>C: Parse gameState, set contextGraphId = "42"

    Note over A,C: All nodes share identical game state + context graph ID (M=2)
```

### 3.3 Voting + Turn Resolution (Multi-Party Signing → Context Graph)

```mermaid
sequenceDiagram
    participant A as Node A (Leader)
    participant GS as GossipSub
    participant B as Node B
    participant C as Node C
    participant Chain as Base Sepolia

    Note over A,C: Turn 1 — All players vote

    A->>A: POST /vote {action: "advance"}
    A->>A: writeToWorkspace(voteCastQuads)
    A->>GS: publish("vote:cast") {turn:1, action:"advance"}

    B->>GS: publish("vote:cast") {turn:1, action:"advance"}
    C->>GS: publish("vote:cast") {turn:1, action:"syncMemory"}

    Note over A: Leader sees all 3 votes → triggers proposal

    A->>A: tallyVotes() → "advance" wins (2/3)
    A->>A: gameEngine.executeAction(state, {type:"advance"})
    A->>A: Compute turnQuads + merkleRoot
    A->>A: Sign keccak256(contextGraphId=42, merkleRoot)
    A->>GS: publish("turn:proposal") {hash, merkleRoot, contextGraphId, ...}

    GS-->>B: turn:proposal
    B->>B: Verify hash + tally
    B->>B: Sign keccak256(42, merkleRoot) with identity key
    B->>GS: publish("turn:approve") {hash, identityId, signatureR, signatureVS}

    GS-->>C: turn:proposal
    C->>C: Verify hash + tally
    C->>C: Sign keccak256(42, merkleRoot)
    C->>GS: publish("turn:approve") {hash, identityId, signatureR, signatureVS}

    Note over A: Leader collects M=2 crypto signatures (own + B's)

    A->>A: writeToWorkspace(turnQuads + attestationQuads)
    A->>Chain: enshrineFromWorkspace(rootEntities, contextGraphId=42, sigs=[A,B])
    Chain->>Chain: ecrecover each sig, verify participant, check count >= M
    Chain-->>A: batch linked to context graph 42
    A->>GS: publish("turn:resolved") {turn:1, proposalHash}

    GS-->>B: turn:resolved → advance to turn 2
    GS-->>C: turn:resolved → advance to turn 2
```

### 3.4 Force Resolve (Deadline Expired — No Multi-Party Consensus)

```mermaid
sequenceDiagram
    participant A as Node A (Leader)
    participant GS as GossipSub
    participant Chain as Base Sepolia

    Note over A: Turn deadline (30s) expires, not all votes in

    A->>A: POST /force-resolve {swarmId}
    A->>A: If no votes: inject synthetic {action:"syncMemory"}
    A->>A: tallyVotes() → execute → create proposal
    A->>GS: publish("turn:proposal") {resolution: "force-resolved"}

    Note over A: No multi-party signing — use plain publish

    A->>Chain: publish(turnQuads) — standalone KC batch, NOT linked to context graph
    Chain-->>A: batch published (no context graph link)
    A->>GS: publish("turn:resolved")

    Note over A: Data is chain-anchored but not M/N-gated
```

---

## 4. RDF Triples Created at Each Step

### 4.1 Workspace Writes (ephemeral, no chain)

**Graph:** `did:dkg:paranet:origin-trail-game` (workspace)

#### Swarm Created
```turtle
<ot:swarm/{swarmId}>  rdf:type          ot:AgentSwarm ;
                       ot:name           "Pioneer Express" ;
                       ot:orchestrator   <ot:player/{leaderPeerId}> ;
                       ot:createdAt      "1709901234000"^^xsd:decimal ;
                       ot:status         "recruiting" ;
                       ot:maxPlayers     "3"^^xsd:decimal .
```

#### Player Joined
```turtle
<ot:swarm/{swarmId}/member/{peerId}>
    rdf:type          ot:SwarmMembership ;
    ot:agent          <ot:player/{peerId}> ;
    ot:displayName    "Bob" ;
    ot:swarm          <ot:swarm/{swarmId}> .
```

#### Vote Cast
```turtle
<ot:swarm/{swarmId}/turn/1/vote/{peerId}>
    rdf:type    ot:Vote ;
    ot:turn     "1"^^xsd:decimal ;
    ot:action   "advance" ;
    ot:agent    <ot:player/{peerId}> ;
    ot:params   "{\"intensity\":2}" .
```

### 4.2 Context Graph Data (permanent, enshrined on-chain)

**Graph:** `did:dkg:paranet:origin-trail-game/context/{swarmId}`

These quads are written to workspace first, then promoted to the on-chain
context graph via `enshrineFromWorkspace`.

#### Turn Resolved
```turtle
<ot:swarm/{swarmId}/turn/1>
    rdf:type           ot:TurnResult ;
    ot:turn            "1"^^xsd:decimal ;
    ot:winningAction   "advance" ;
    ot:gameState       "{...full JSON...}" ;
    ot:swarm           <ot:swarm/{swarmId}> ;
    ot:approvedBy      <ot:player/{peerId_A}> ;
    ot:approvedBy      <ot:player/{peerId_B}> .
```

#### Consensus Attestation
```turtle
<urn:dkg:attestation:{swarmId}:turn1:{proposalHash}>
    rdf:type          ot:ConsensusAttestationBatch ;
    ot:forTurn        <ot:swarm/{swarmId}/turn/1> ;
    ot:resolution     "consensus" ;
    ot:hasAttestation <ot:swarm/{swarmId}/turn/1/attestation/{hash}/{peerId}> .

<ot:swarm/{swarmId}/turn/1/attestation/{hash}/{peerId}>
    rdf:type          ot:ConsensusAttestation ;
    ot:signer         <ot:player/{peerId}> ;
    ot:proposalHash   "a92ab6cb..." ;
    ot:approved       "true"^^xsd:boolean ;
    ot:attestedAt     "1709901265000"^^xsd:decimal .
```

#### Strategy Pattern (game over)
```turtle
<ot:strategy/{swarmId}/{peerId}>
    rdf:type           ot:StrategyPattern ;
    ot:player          <ot:player/{peerId}> ;
    ot:swarm           <ot:swarm/{swarmId}> ;
    ot:totalVotes      "8"^^xsd:decimal ;
    ot:favoriteAction  "advance" ;
    ot:turnsSurvived   "12"^^xsd:decimal .
```

#### Leaderboard Entry (game over)
```turtle
<ot:swarm/{swarmId}/leaderboard/{peerId}>
    rdf:type       ot:LeaderboardEntry ;
    ot:player      <ot:player/{peerId}> ;
    ot:score       "2450"^^xsd:decimal ;
    ot:outcome     "won" ;
    ot:epochs      "200"^^xsd:decimal ;
    ot:survivors   "2"^^xsd:decimal ;
    ot:partySize   "3"^^xsd:decimal .
```

---

## 5. GossipSub Message Types

| Message | Sender | Key Payload | Purpose |
|---------|--------|-------------|---------|
| `swarm:created` | Leader | swarmId, playerName, maxPlayers, **identityId** | Announce new swarm |
| `swarm:joined` | Joiner | swarmId, playerName, **identityId** | Announce player joined |
| `swarm:left` | Leaver | swarmId | Announce player left |
| `expedition:launched` | Leader | gameStateJson, partyOrder, **contextGraphId** | Broadcast game state + context graph |
| `vote:cast` | Voter | turn, action, params | Broadcast vote |
| `turn:proposal` | Leader | proposalHash, winningAction, newStateJson, **merkleRoot**, **contextGraphId** | Propose turn + share digest for signing |
| `turn:approve` | Verifier | turn, proposalHash, **identityId**, **signatureR**, **signatureVS** | Approve proposal with crypto signature |
| `turn:resolved` | Leader | turn, proposalHash | Notify turn finalized |

**Topic:** `dkg/paranet/origin-trail-game/app`

---

## 6. Consensus Mechanism

### Threshold

`M = ceil(2n/3)` where n = player count. For 3 players: M=2 signatures needed.

### Gossip Verification

Receivers verify `proposalHash` (SHA-256 of `swarmId:turn:stateJson`)
and that `winningAction` matches their local vote tally.

### Cryptographic Signing

After verifying the proposal, each peer signs `keccak256(contextGraphId, merkleRoot)`
using their identity key and includes the signature (r, vs) in their `turn:approve` message.

### On-Chain Verification

The `ContextGraphs` contract:
1. Checks `signatures.length >= M`
2. Runs `ecrecover` on each signature to recover the signer address
3. Verifies each signer is a registered participant of the context graph
4. Only then links the KC batch to the context graph

### Non-determinism

The game engine uses `Math.random()` — receivers do NOT replay the
engine. They trust the leader's state output and verify only the action choice.

### Resolution modes

| Mode | When | Quorum | On-Chain |
|------|------|--------|----------|
| `consensus` | Majority wins cleanly | M crypto signatures | Enshrined to context graph |
| `leader-tiebreak` | Tie broken by leader's vote | M crypto signatures | Enshrined to context graph |
| `force-resolved` | Deadline expired | Leader only | Plain publish (no context graph) |

---

## 7. Data Flow Summary

```mermaid
graph TD
    subgraph "Game UI (Browser)"
        UI[React App]
    end

    subgraph "DKG Node"
        API[HTTP API /api/apps/origin-trail-game/*]
        COORD[OriginTrailGameCoordinator]
        ENGINE[GameEngine]
        RDF[RDF Quad Generators]
    end

    subgraph "DKG Agent"
        WS[Workspace Handler]
        PUB[Publisher + enshrineFromWorkspace]
        GOSSIP[GossipSub Manager]
        STORE[Triple Store - Oxigraph]
        QUERY[Query Engine]
    end

    subgraph "Network"
        GS_MESH[GossipSub Mesh]
        RELAY[Circuit Relay]
    end

    subgraph "Base Sepolia"
        CG_CONTRACT[ContextGraphs Contract]
        KA_STORE[KnowledgeAssetsStorage]
    end

    UI -->|REST| API
    API --> COORD
    COORD --> ENGINE
    COORD --> RDF

    RDF -->|workspace quads| WS
    WS -->|insert| STORE

    RDF -->|enshrine quads| PUB
    PUB -->|merkle root + KC batch| KA_STORE
    PUB -->|addBatchToContextGraph| CG_CONTRACT

    COORD -->|encode + broadcast| GOSSIP
    GOSSIP -->|libp2p| GS_MESH
    GS_MESH -->|via| RELAY

    QUERY -->|SPARQL| STORE

    style UI fill:#1a1a2e,color:#e6edf3
    style CG_CONTRACT fill:#2d1b4e,color:#e6edf3
    style KA_STORE fill:#2d1b4e,color:#e6edf3
    style GS_MESH fill:#0d3a0d,color:#e6edf3
```

---

## 8. Graph-based Lobby Sync

When a node starts (or restarts), `loadLobbyFromGraph` runs after 5 seconds:

```mermaid
sequenceDiagram
    participant Node as Node (just booted)
    participant Store as Triple Store
    participant WS as Workspace Graph

    Node->>Store: SPARQL: SELECT players from paranet graph
    Store-->>Node: Player profiles {name, peerId}

    Node->>WS: SPARQL: SELECT swarms from workspace (includeWorkspace: true)
    WS-->>Node: Swarms with status="recruiting"

    loop For each recruiting swarm not in memory
        Node->>WS: SPARQL: SELECT memberships for swarm
        WS-->>Node: Members {peerId, displayName}
        Node->>Node: Reconstruct SwarmState
    end

    Note over Node: Only "recruiting" swarms restored.<br/>Traveling/finished swarms are lost on restart.
```
