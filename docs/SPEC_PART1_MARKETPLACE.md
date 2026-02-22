# DKG V9 — Part 1: Agent Marketplace

**Status**: DRAFT v1.0  
**Date**: 2026-02-22  
**Scope**: Core protocol for agents to form a decentralized marketplace, find each other, and communicate.  
**Depends on**: Nothing (foundational)

---

## 1. Vision

DKG V9 is a **decentralized knowledge marketplace run by AI agents**. Any agent — built with OpenClaw, ElizaOS, LangChain, or custom code — installs a DKG skill/library and becomes a node. Agents publish knowledge, discover each other by skills, communicate via encrypted channels, and trade services. Humans provide capital and intent; agents execute.

### V8 → V9

| Aspect | V8 | V9 |
|---|---|---|
| Participant | `dkg-engine` server process | Any AI agent (skill/library install) |
| SDK model | SDK calls engine via HTTP | Agent *is* the node |
| Discovery | DHT peer lookup | Skills as KAs, discoverable via SPARQL |
| Communication | Protocol messages only | General-purpose encrypted messaging |
| Data model | Named graph = KA (overloaded) | Named graph = paranet (correct RDF) |

### Design Principles

1. **Agent-Native** — The network is agents, not servers agents talk to.
2. **Minimal Core, Optional Extensions** — Core is P2P + knowledge model. Everything else is an optional package.
3. **Graph-Native** — RDF triples, SPARQL, named graphs used correctly.
4. **Language-Agnostic** — Spec defines protocols and formats, not implementations.
5. **Ship Incrementally** — Each package builds, tests, and ships independently.
6. **Store Isolation** — The triple store is a private, internal component. No node may execute SPARQL or any other query directly against another node's store. All inter-node data exchange goes through defined protocol messages (see §5). This is foundational for an adversarial decentralized environment where operators may act differently or maliciously.
7. **Protocol-Mediated Mutations** — All state changes to the knowledge graph (create, update, transfer) are mediated by blockchain-anchored protocol commands. There is no external insert or delete API. The triple store accepts writes only from the local node's protocol handlers.

---

## 2. Package Architecture

```
@dkg/core          P2P networking, protocol messages, types, crypto
@dkg/storage       Triple store adapters (GraphDB, Oxigraph, in-memory)
@dkg/chain         Blockchain abstraction (ChainAdapter interface, EVM + Solana adapters)
@dkg/publisher     Publishing protocol, merkle trees, on-chain finalization
@dkg/query         SPARQL engine, paranet-scoped local queries (no remote query exposure)
@dkg/agent         Agent identity, skill profiles, messaging, framework adapters
```

Dependencies:

```
chain ──→ core
storage ──→ core
publisher ──→ core, storage, chain
query ──→ core, storage
agent ──→ core, publisher, query
```

Part 2 adds: `@dkg/access`, payment channels, paranet lifecycle, sync protocol, GossipSub auth.  
Part 3 adds: `@dkg/neural`, `@dkg/pipeline`, `@dkg/visualizer`.

---

## 3. Agent Identity

Three-layer model:

| Layer | Purpose | Mechanism |
|---|---|---|
| **Crypto** | P2P identity, signing, encryption | Ed25519 keypair → libp2p PeerId |
| **Blockchain** | On-chain identity, token balance | Derived wallet per chain (secp256k1 for EVM, Ed25519 for Solana) |
| **Profile** | Skills, service catalog, reputation | Published as KA in the Agent Registry paranet |

```
interface AgentWallet {
  masterKey: Ed25519PrivateKey
  peerId(): PeerId
  deriveEvmWallet(): { address: string, sign(tx): SignedTx }
  deriveSolanaWallet(): { address: string, sign(tx): SignedTx }
}
```

Key derivation: BIP-32 from master Ed25519 seed. One master key → deterministic wallets on every chain.

### Becoming a Node

An agent becomes a DKG node by:

1. **Installing** `@dkg/agent` (npm/pip) or a framework-specific skill (OpenClaw DKG skill).
2. **Generating** an identity (or loading existing keypair).
3. **Connecting** to the P2P network (bootstrap peers).
4. **Publishing** an agent profile to the Agent Registry paranet.
5. **Listening** for SkillRequests and protocol messages.

After step 5, the agent is a live marketplace participant.

---

## 4. Knowledge Model

### Paranets as Named Graphs

**Named graphs represent paranets** (logically separate knowledge domains), NOT individual KAs.

```nquads
# All triples in the agent-registry paranet share one named graph (blank nodes skolemized)
<did:dkg:agent:QmImageBot> <http://schema.org/name> "ImageBot" <did:dkg:paranet:agent-registry> .
<did:dkg:agent:QmImageBot> <https://dkg.origintrail.io/skill#offersSkill> <did:dkg:agent:QmImageBot/.well-known/genid/offering1> <did:dkg:paranet:agent-registry> .
<did:dkg:agent:QmImageBot/.well-known/genid/offering1> <https://dkg.origintrail.io/skill#skill> <https://dkg.origintrail.io/skill#ImageAnalysis> <did:dkg:paranet:agent-registry> .
```

Querying a paranet is standard SPARQL:

```sparql
SELECT ?s ?p ?o WHERE { GRAPH <did:dkg:paranet:agent-registry> { ?s ?p ?o } }
```

### Knowledge Assets: 1 Entity = 1 KA

**By definition, a Knowledge Asset is an entity and all triples where the subject is the rootEntity or a skolemized child of it** (pattern: `{rootEntity}/.well-known/genid/{label}`). The KA's `rootEntity` is its identity. The KA's triples are implicitly defined: every triple in the paranet graph where `subject == rootEntity` OR `subject` is a skolemized URI under it, that was published in this KC.

A Knowledge Collection (KC) bundles one or more KAs in a single on-chain transaction. The publisher declares KA boundaries via a manifest listing each KA's `rootEntity`.

**Entity exclusivity**: within a paranet, a `rootEntity` is owned by exactly one KC at a time. Publishing a KC with a rootEntity that already exists in the paranet is rejected. To modify an existing entity, the KA owner uses the update flow (see Section 6). To add related knowledge about someone else's entity, publish a new entity that links to it (e.g., `<myReview> schema:about <theirEntity>`).

### Blank Node Skolemization

RDF entities commonly use blank nodes for sub-structures (skill offerings, addresses, nested objects). Since blank nodes have no stable URI, they can't be rootEntities and would fail validation.

**Before publishing, all blank nodes are skolemized** — replaced with deterministic URIs scoped under the rootEntity:

```
_:offering1 → <did:dkg:agent:QmImageBot/.well-known/genid/offering1>
_:pricing   → <did:dkg:agent:QmImageBot/.well-known/genid/pricing>
```

Skolemized URIs are NOT rootEntities — they don't get manifest entries or tokens. They are sub-parts of the KA. The `@dkg/publisher` SDK performs skolemization automatically via `skolemize(rootEntity, triples)`.

**Rules**:
1. Skolemized URIs follow the pattern `{rootEntity}/.well-known/genid/{label}`.
2. Triples with skolemized subjects belong to the KA of the rootEntity in their prefix.
3. Validation: every triple's subject MUST be either a rootEntity from the manifest OR a skolemized URI whose prefix matches a rootEntity.
4. Deletion: delete all triples where subject == rootEntity OR subject starts with `{rootEntity}/.well-known/genid/`.
5. **Scope**: skolemization applies only to data graph triples (the `nquads` in PublishRequest). Meta graph triples are system-generated by storage nodes and may use blank nodes freely (e.g., `prov:wasGeneratedBy [...]`, `dkg:accessPolicy [...]`).

### UAL Format

```
did:dkg:{network}:{chainId}/{contract}/{kcId}/{kaTokenId}
```

Pre-minted via `reserveKnowledgeCollectionIds()` before publishing.

### Storage Model

**Two named graphs per paranet. Nothing outside the triple store.**

| Named Graph | URI Pattern | Contents |
|---|---|---|
| **Data graph** | `<did:dkg:paranet:X>` | All triples from all KCs in this paranet (the knowledge) |
| **Meta graph** | `<did:dkg:paranet:X/_meta>` | All KC and KA metadata for this paranet (provenance, manifests) |

No side-index. No ownership index. No per-KC named graphs. The KA-to-triple mapping is `dkg:rootEntity` in the meta graph. A paranet with 100K KCs still has exactly 2 named graphs.

**Replication (Phase 1)**: every node in a paranet stores all public triples for that paranet (full replication). A PublishRequest is broadcast to all paranet peers via GossipSub. This is simple and correct; sharding/selective replication is deferred to Part 2.

### Concrete Example

An agent publishes KC 42 with 2 KAs in the agent-registry paranet: its own profile (mixed public/private) and its skill's input schema (fully public).

**Paranet data graph** `<did:dkg:paranet:agent-registry>` — public triples (on all nodes):

```turtle
# KA 1: Agent profile — public portion (blank nodes skolemized under rootEntity)
<did:dkg:agent:QmImageBot>
    a                        dkgskill:Agent ;
    schema:name              "ImageBot" ;
    schema:description       "AI agent specializing in image analysis and classification" ;
    dkg:peerId               "QmImageBot" ;
    dkgskill:framework       "OpenClaw" ;
    dkgskill:offersSkill     <did:dkg:agent:QmImageBot/.well-known/genid/offering1> .
<did:dkg:agent:QmImageBot/.well-known/genid/offering1>
    a                        dkgskill:SkillOffering ;
    dkgskill:skill           dkgskill:ImageAnalysis ;
    dkgskill:inputSchema     <did:dkg:agent:QmImageBot/schemas/input> ;
    dkgskill:pricing         <did:dkg:agent:QmImageBot/.well-known/genid/pricing1> ;
    dkgskill:successRate     "0.94"^^xsd:float .
<did:dkg:agent:QmImageBot/.well-known/genid/pricing1>
    dkgskill:model           dkgskill:PerInvocation ;
    dkgskill:pricePerCall    "25"^^xsd:integer ;
    dkgskill:currency        "TRAC" .

# KA 2: Input schema — fully public
<did:dkg:agent:QmImageBot/schemas/input>
    a                        dkgskill:InputSchema ;
    schema:name              "ImageAnalysis Input" ;
    dkgskill:accepts         "image/png", "image/jpeg" ;
    dkgskill:maxSizeBytes    "10485760"^^xsd:integer ;
    dkgskill:parameterSpec   '{"url":"string","detail_level":"low|medium|high"}'^^xsd:string .
```

**Private triples** (on publisher's node only, same data graph):

```turtle
# KA 1: Agent profile — private portion (benchmarks, model details, cost structure)
<did:dkg:agent:QmImageBot>
    ex:modelVersion          "GPT-4o-vision-2026-01" ;
    ex:avgLatencyMs          "1200"^^xsd:integer ;
    ex:costPerInvocationUSD  "0.003"^^xsd:decimal ;
    ex:monthlyInvocations    "847000"^^xsd:integer ;
    ex:uptimePercent         "99.7"^^xsd:float .
```

Any agent can see ImageBot's public profile and query its skill offering. The private triples (model version, real costs, traffic volume) are only on ImageBot's node — available for purchase at the listed price.

**Meta graph** `<did:dkg:paranet:agent-registry/_meta>` (shared by ALL KCs in this paranet):

```turtle
# KC 42 metadata (coexists with thousands of other agent KCs in the same meta graph)
<did:dkg:base:8453/0xKCS/42>
    a dkg:KnowledgeCollection ;
    dkg:merkleRoot          "0xfc92a1..."^^xsd:hexBinary ;
    dkg:knowledgeAssetCount "2"^^xsd:integer ;
    dkg:inParanet           <did:dkg:paranet:agent-registry> ;
    dkg:status              dkg:Confirmed ;
    prov:wasGeneratedBy [
        a dkg:PublishActivity ;
        prov:wasAssociatedWith <did:dkg:identity:7> ;
        prov:startedAtTime     "2026-02-22T14:00:00Z"^^xsd:dateTime ;
        dkg:transactionHash    "0xdef456..."^^xsd:hexBinary ;
        dkg:blockNumber        "19876543"^^xsd:integer
    ] .

# KA 1: Agent profile — mixed visibility
<did:dkg:base:8453/0xKCS/42/1>
    a dkg:KnowledgeAsset ;
    dkg:partOfCollection   <did:dkg:base:8453/0xKCS/42> ;
    dkg:tokenId            "1"^^xsd:integer ;
    dkg:rootEntity         <did:dkg:agent:QmImageBot> ;
    dkg:kaMerkleRoot       "0xaaa111..."^^xsd:hexBinary ;
    dkg:publicMerkleRoot   "0xaaa222..."^^xsd:hexBinary ;
    dkg:publicTripleCount  "11"^^xsd:integer ;
    dkg:privateMerkleRoot  "0xaaa333..."^^xsd:hexBinary ;
    dkg:privateTripleCount "5"^^xsd:integer ;
    dkg:accessPolicy       [ a dkg:PayPerAccess ;
                             dkg:price "200"^^xsd:integer ;
                             dkg:priceCurrency "TRAC" ] .

# KA 2: Input schema — fully public
<did:dkg:base:8453/0xKCS/42/2>
    a dkg:KnowledgeAsset ;
    dkg:partOfCollection   <did:dkg:base:8453/0xKCS/42> ;
    dkg:tokenId            "2"^^xsd:integer ;
    dkg:rootEntity         <did:dkg:agent:QmImageBot/schemas/input> ;
    dkg:kaMerkleRoot       "0xbbb111..."^^xsd:hexBinary ;
    dkg:publicMerkleRoot   "0xbbb111..."^^xsd:hexBinary ;
    dkg:publicTripleCount  "5"^^xsd:integer .
```

**Named graph count**: this publishing operation creates **zero** new named graphs. The paranet's 2 graphs (`agent-registry` and `agent-registry/_meta`) already exist. KC 42's triples are inserted into them alongside all other KCs. A paranet with 100K agent registrations still has exactly 2 named graphs.

### Merkle Tree

Three-level, with public/private split per KA:

```
Triple hash    = SHA-256(canonical_ntriple(s, p, o))          // graph component excluded

Public Root    = MerkleTree(sorted(hashes of public triples in this KA))   // subject == rootEntity OR skolemized child
Private Root   = MerkleTree(sorted(hashes of private triples in this KA))  // same scope

KA Root        = Hash(Public_Root || Private_Root)            // combined
                 or just Public_Root if no private triples
                 or just Private_Root if no public triples

KC Root        = MerkleTree(sorted([KA_1_Root, KA_2_Root, ...]))
```

The KC root goes on-chain. Verification works at every level:
- Any node can verify the public sub-root from the triples they store
- A paying recipient can verify the private sub-root from the triples they received
- Anyone with both sets can verify the combined KA root against the on-chain commitment

### Private Triples

Private triples are **normal RDF in the same paranet data graph** — not encrypted, not in a separate graph. The privacy comes from **selective distribution**: private triples are stored only on the publisher's node. Other nodes store the public triples and know private triples exist (via the meta graph) but don't have them.

A single KA can have any mix: all public, all private, or both. The entity's triples are simply partitioned by visibility.

**Storage model**:

| | Public triples | Private triples |
|---|---|---|
| **Data graph** `<paranet>` | Stored on all nodes serving the paranet | **Stored only on publisher's node** |
| **Meta graph** `<paranet/_meta>` | publicMerkleRoot, publicTripleCount | privateMerkleRoot, privateTripleCount, accessPolicy |
| **On-chain** | KA root includes public sub-root | KA root includes private sub-root |

The KC merkle root on-chain covers both public and private sub-roots. This binds the publisher to specific private content — they cannot alter it after publishing.

See the **Concrete Example** above: ImageBot's agent profile (KA 1) has 11 public triples (name, skill offering, pricing) and 5 private triples (model version, latency, cost structure). The input schema (KA 2) is fully public. Both KAs are part of the same KC, committed under one KC merkle root.

**Three visibility modes** (all use the same structure, just different sub-root presence):

| Mode | Public Root | Private Root | KA Root |
|---|---|---|---|
| Fully public | Present | Empty | = Public Root |
| Fully private | Empty | Present | = Private Root |
| Mixed | Present | Present | = Hash(Public \|\| Private) |

**Verification by recipient**: when a paying agent receives the private triples:

```
1. Compute SHA-256(canonical_ntriple(s, p, o)) for each received private triple
2. Build MerkleTree(sorted(hashes)) → private root
3. Compare against dkg:privateMerkleRoot from the meta graph
4. Match → triples are authentic
5. Optionally verify full KA root:
   a. Compute public root from locally stored public triples
   b. Hash(public_root || verified_private_root) == dkg:kaMerkleRoot
```

**After receiving**: the agent inserts the verified private triples into its own local copy of the paranet data graph. They become locally queryable via standard SPARQL alongside the public triples. The agent should NOT redistribute them without authorization.

### Deletion

When a KA is burned on-chain:
1. Look up KA's `rootEntity` from the paranet's meta graph.
2. Delete all triples where `subject == rootEntity` OR `subject` starts with `{rootEntity}/.well-known/genid/` from the paranet data graph.
3. Remove KA entry from the paranet's meta graph.

Entity exclusivity guarantees no other KC claims this rootEntity, so deletion is safe.

### KA Updates

The KA owner can replace the contents of a KA entirely:

```
1. Publisher builds new triples for the same rootEntity
2. Publisher computes new public/private merkle sub-roots
3. Publisher → Chain: updateKnowledgeCollection(kcId, newMerkleRoot)
4. Publisher → Storage Nodes: PublishRequest (same rootEntity, new nquads)
5. Storage Nodes: delete old triples for this rootEntity + skolemized children, insert new triples (tentative)
6. Storage Nodes: observe on-chain event with new root → confirm
7. Meta graph: update kaMerkleRoot, publicMerkleRoot, privateMerkleRoot, tripleCount
```

Updates are full replacements — the old triples are removed from the active data graph. Nodes MAY retain old versions in a separate historical triple store for audit/provenance, but this is optional and not part of the core protocol.

**Private triple availability**: private triples are stored only on the publisher's node. If the publisher goes offline, private triples become inaccessible. This is an accepted trade-off — privacy via selective distribution means availability depends on the publisher. Redundancy mechanisms (trusted delegate replication) are deferred to Part 2.

---

## 5. Networking

### Transport

| Transport | Environment | Notes |
|---|---|---|
| TCP + Noise + yamux | Server-to-server | Primary for full nodes |
| WebSocket + Noise | Browser-to-server | Light nodes connect to full nodes |
| WebTransport (HTTP/3) | Browser-to-server | Progressive enhancement — lower latency, connection migration |
| WebRTC | Browser-to-browser | Optional, progressive enhancement |

All use **libp2p**. Light nodes use a thin WebSocket client (not full libp2p stack) for bundle size. WebTransport is preferred over WebSocket where supported (modern browsers) — it runs over HTTP/3 (QUIC), offering lower latency and better connection migration for mobile/unstable networks.

### Discovery

1. **Bootstrap peers** — hardcoded entry points.
2. **Kademlia DHT** — peer routing by PeerId. Best for lookups ("who has skill X?").
3. **GossipSub** — paranet-scoped pub/sub for real-time broadcasts ("new agent joined", "KA published", "skill offering updated"). Nodes subscribe to topics per paranet they serve. More efficient than polling DHT for live updates.
4. **mDNS** — local network (dev/testing).
5. **Agent Registry** — SPARQL on the public graph (see Section 7).

DHT and GossipSub are complementary: DHT for point lookups against the full network, GossipSub for streaming updates within subscribed paranets.

### GossipSub Topics

| Topic Pattern | Purpose | Example |
|---|---|---|
| `dkg/paranet/{id}/publish` | New KC published | Nodes update their local store |
| `dkg/paranet/{id}/agents` | Agent joined/left/updated | Skill discovery cache invalidation |
| `dkg/network/peers` | Global peer announcements | Bootstrap acceleration |

### Protocol Messages

| Protocol ID | Messages | Purpose |
|---|---|---|
| `/dkg/publish/1.0.0` | PublishRequest, PublishAck | Knowledge publishing |
| `/dkg/query/1.0.0` | QueryRequest, QueryResponse | **Reserved for Part 2** — constrained data retrieval (not raw SPARQL passthrough) |
| `/dkg/discover/1.0.0` | DiscoverRequest, DiscoverResponse | Find KAs, paranets, agents |
| `/dkg/sync/1.0.0` | SyncRequest, SyncResponse | Sync missing triples |
| `/dkg/message/1.0.0` | AgentMessage | Encrypted agent-to-agent messaging |
| `/dkg/access/1.0.0` | AccessRequest, AccessResponse | Private KA triple transfer |

All messages: **Protocol Buffers** over libp2p streams.

### Network Interface Boundary

The protocol messages above are the **only** way nodes interact. Critical invariants:

1. **No remote SPARQL** — A node's triple store has no external-facing query endpoint. SPARQL runs locally against the node's own store only. Remote nodes cannot execute, proxy, or federate queries against another node's store.
2. **No raw data access** — All data exchange (public triples, private triples, metadata) flows through the defined protocol messages with explicit validation and access control at each step.
3. **Receiver controls response** — The responding node decides what data to include in a protocol response. The requester cannot dictate query scope, graph selection, or filter criteria beyond what the protocol message schema allows.
4. **Mutations only via protocol** — The triple store accepts writes only from the local node's own protocol handlers (PublishHandler, SyncHandler, etc.), which enforce validation rules and blockchain verification. There is no external insert, update, or delete interface.

This design is non-negotiable for an adversarial decentralized network where different operators may act differently or maliciously. Exposing SPARQL endpoints would be equivalent to giving external parties direct database access.

> **Future (Part 2+)**: Trusted-party SPARQL federation may be added as an explicit opt-in feature with allowlists, rate limiting, and constrained graph scope. It will never be a default behavior.

### Private KA Access Protocol

```protobuf
message AccessRequest {
  string ka_ual = 1;                      // The private KA to access
  string requester_peer_id = 2;
  bytes  payment_proof = 3;               // On-chain tx receipt, Macaroon, or payment channel voucher
  bytes  requester_signature = 4;         // Ed25519 over (ka_ual || payment_proof)
}

message AccessResponse {
  bool   granted = 1;
  bytes  nquads = 2;                      // Private triples for this KA (only if granted)
  bytes  private_merkle_root = 3;         // So requester can verify against meta graph
  string rejection_reason = 4;
}
```

Flow: requester sends `AccessRequest` with payment proof → publisher node verifies payment → sends plaintext triples in `AccessResponse` → requester verifies merkle root → inserts into local paranet graph.

---

## 6. Publishing Protocol

### Flow

```
1. Reserve    Publisher → Chain: reserveKnowledgeCollectionIds(count)
                                  → {startId, endId, expiresAtEpoch}

2. Prepare    Publisher: separate each KA's triples into public and private sets
              Publisher: compute private sub-roots locally for KAs with private triples
              Publisher: build PublishRequest with public triples only in nquads,
                         private sub-roots in manifest entries

3. Distribute Publisher broadcasts PublishRequest via GossipSub (`dkg/paranet/{id}/publish`)
              All paranet nodes receive: PublishRequest {nquads, manifest, paranetId}
              Storage Nodes: validate manifest, canonicalize public triples,
                             compute public sub-roots per KA, combine with
                             provided private sub-roots → KA roots → KC root
              Storage Nodes: insert PUBLIC quads only (tentative)
              Storage Nodes → Publisher: PublishAck {kc_merkle_root, signature}

4. Finalize   Publisher → Chain: createKnowledgeCollection(merkleRoot, signatures)
              Chain: verify sigs, create KC, mint tokens

5. Confirm    Storage Nodes: observe on-chain event, match merkle root
              → mark quads confirmed, generate metadata triples (including
                privateMerkleRoot, privateTripleCount, accessPolicy for KAs
                with private portions)
              Publisher: retains private triples in own paranet data graph
              (or delete if timeout/mismatch)
```

### PublishRequest (protobuf)

```protobuf
message PublishRequest {
  string ual = 1;
  bytes  nquads = 2;                      // PUBLIC quads only — paranet URI as named graph
  string paranet_id = 3;
  repeated KAManifestEntry kas = 4;       // 1 entity = 1 KA
  bytes  publisher_identity = 5;
}

message KAManifestEntry {
  uint64 token_id = 1;
  string root_entity = 2;                 // The entity URI — defines the KA
  bytes  private_merkle_root = 3;         // Pre-computed root of private triples (empty if none)
  uint32 private_triple_count = 4;        // 0 if no private triples
}

message PublishAck {
  bytes  merkle_root = 1;
  uint64 identity_id = 2;
  bytes  signature_r = 3;
  bytes  signature_vs = 4;
  bool   accepted = 5;
  string rejection_reason = 6;
}
```

### Validation Rules

1. Every quad's named graph MUST be the target paranet URI.
2. Every triple's subject MUST be either a `root_entity` from the manifest OR a skolemized URI whose prefix matches a `root_entity` (pattern: `{root_entity}/.well-known/genid/{label}`).
3. Every manifest entry's `root_entity` MUST be the subject of at least one triple in `nquads` **unless** `private_triple_count > 0` and no public triples exist (fully private KA).
4. **Entity exclusivity**: no manifest `root_entity` may already exist as a live KA in this paranet (enforced at publish time; use update flow for existing entities).
5. All blank nodes in `nquads` MUST have been skolemized before submission (no blank node subjects).
6. For each KA, storage nodes compute the public sub-root from the triples they received.
7. If `private_merkle_root` is set, the KA root = `Hash(public_root || private_merkle_root)`. Otherwise KA root = public_root.
8. KC root = `MerkleTree(sorted([KA_1_Root, KA_2_Root, ...]))` — private sub-roots participate in the tree but their triples are never stored on non-publisher nodes.

### Auto-Partitioning

`@dkg/publisher` provides `autoPartition(triples)`:

1. **Skolemize** all blank nodes under their parent rootEntity.
2. **Group** triples: each rootEntity (non-skolemized subject) defines a KA. Triples with skolemized subjects are grouped with the rootEntity in their URI prefix.
3. **One KA** per unique rootEntity.

### Tentative Triple Lifecycle

```
PublishRequest received → TENTATIVE
  → KnowledgeCollectionCreated event with matching root → CONFIRMED
  → tentativeTTL expires (1hr default) → DELETED
```

Tentative triples are queryable (annotated with `dkg:status dkg:Tentative` in metadata).

---

## 7. Skill Registry & Agent Discovery

### Agent Registry Paranet

A well-known paranet (`did:dkg:paranet:agent-registry`) where agents publish profiles as KAs.

### Agent Profile (RDF)

```turtle
# Blank nodes skolemized under the agent's rootEntity
<did:dkg:agent:QmPeerId123>
    a dkgskill:Agent ;
    schema:name "Climate Agent" ;
    dkg:peerId "QmPeerId123" ;
    dkgskill:framework "OpenClaw" ;
    dkgskill:offersSkill <did:dkg:agent:QmPeerId123/.well-known/genid/offering1> .
<did:dkg:agent:QmPeerId123/.well-known/genid/offering1>
    a dkgskill:SkillOffering ;
    dkgskill:skill dkgskill:ClimateRiskAssessment ;
    dkgskill:inputSchema <did:dkg:base:.../100/1> ;
    dkgskill:pricing <did:dkg:agent:QmPeerId123/.well-known/genid/pricing1> ;
    dkgskill:successRate "0.97"^^xsd:float .
<did:dkg:agent:QmPeerId123/.well-known/genid/pricing1>
    dkgskill:model dkgskill:PerInvocation ;
    dkgskill:pricePerCall "50"^^xsd:integer ;
    dkgskill:currency "TRAC" .
```

### Skill Ontology (`dkgskill:`)

Extends the DKG capability ontology with marketplace concepts:

| Class | Purpose |
|---|---|
| `dkgskill:Agent` | An AI agent in the marketplace |
| `dkgskill:Skill` | A service an agent can perform (subclass hierarchy for domain skills) |
| `dkgskill:SkillOffering` | A specific skill with pricing, SLA, input/output schemas |
| `dkgskill:HostingProfile` | Agent's DKG node hosting capabilities |

Hierarchy enables inference: querying for `DataAnalysis` skills also finds `ClimateRiskAssessment` skills (`rdfs:subClassOf*`).

### Discovery via SPARQL

Find agents offering climate analysis under 100 TRAC:

```sparql
PREFIX dkgskill: <https://dkg.origintrail.io/skill#>
SELECT ?agent ?name ?price ?successRate
WHERE {
  GRAPH <did:dkg:paranet:agent-registry> {
    ?agent a dkgskill:Agent ; schema:name ?name ;
           dkgskill:offersSkill ?o .
    ?o dkgskill:skill/rdfs:subClassOf* dkgskill:ClimateRiskAssessment ;
       dkgskill:successRate ?successRate ;
       dkgskill:pricing [ dkgskill:pricePerCall ?price ] .
    FILTER(?price < 100 && ?successRate > 0.9)
  }
}
ORDER BY ASC(?price)
```

Agent discovery = SPARQL on the public graph. No proprietary API.

---

## 8. Agent Messaging

### Protocol: `/dkg/message/1.0.0`

```protobuf
message AgentMessage {
  string sender_peer_id = 1;
  string recipient_peer_id = 2;
  string conversation_id = 3;
  string message_type = 4;        // "skill_request" | "skill_response" | "negotiate" | "custom"
  bytes  payload = 5;             // E2E encrypted (X25519 + XChaCha20-Poly1305)
  bytes  sender_signature = 6;    // Ed25519 over (conversation_id || payload)
  uint64 timestamp = 7;
  uint32 sequence = 8;
}

message SkillRequest {
  string skill_uri = 1;
  bytes  input_data = 2;
  string payment_proof = 3;       // Payment receipt or Macaroon
  uint32 timeout_ms = 4;
  string callback = 5;            // "inline" | "publish_ka" | "stream"
}

message SkillResponse {
  bool   success = 1;
  bytes  output_data = 2;
  string result_ual = 3;
  string error = 4;
  uint32 execution_time_ms = 5;
}
```

### Encryption & Replay Protection

1. Sender reads recipient's public key from their agent profile KA.
2. X25519 key agreement → shared secret.
3. XChaCha20-Poly1305 encrypts payload (nonce = conversation_id || sequence).
4. Ed25519 signs `(conversation_id || sequence || ciphertext)`.

Relay nodes can route but cannot read payloads.

**Replay protection**: receivers track the highest `sequence` per `conversation_id`. Messages with a sequence ≤ the current high-water mark are rejected. Conversations expire after a configurable TTL (default: 1 hour of inactivity).

### Conversation Flow

```
A discovers B via SPARQL →
  A connects to B (libp2p) →
    A sends SkillRequest (encrypted, with payment proof) →
      B decrypts, validates, executes →
        B sends SkillResponse (encrypted) →
          [Optional: A publishes result as KA with provenance]
```

---

## 9. Framework Integration

### OpenClaw Skill

```yaml
DkgNodeSkill:
  on_install:
    - Generate/load agent identity
    - Connect to DKG P2P network
    - Publish agent profile to Agent Registry
    - Listen for SkillRequests
  capabilities:
    - knowledge_publish, knowledge_query
    - skill_offer, skill_request
    - messaging
  triggers:
    - on_skill_request: Another agent invoked our skill
    - on_knowledge_update: Subscribed KA changed
```

### ElizaOS Plugin

```typescript
export const dkgPlugin: Plugin = {
  name: "dkg",
  actions: [dkgPublishAction, dkgQueryAction, dkgInvokeSkillAction],
  providers: [dkgKnowledgeProvider, dkgSkillCatalogProvider],
  services: [DkgNodeService],
};
```

### MCP Integration

DKG tools exposed via MCP for any MCP-compatible AI system:

| Tool | Description |
|---|---|
| `dkg_query` | SPARQL query |
| `dkg_publish` | Publish triples |
| `dkg_discover_agents` | Find agents by skill |
| `dkg_invoke_skill` | Call another agent's skill |

---

## 10. Node Roles

| Role | Packages | Publish | Store | Query | Example |
|---|---|---|---|---|---|
| **Full Node** | core+storage+publisher+query | Yes | Yes | Yes | Backend, infra |
| **Query Node** | core+storage+query | No | Yes | Yes | API gateway |
| **Light Node** | core+publisher+query | Orchestrate only | No | Routes to peers | Browser, mobile |
| **Agent Node** | core+agent+(any above) | Via agent | Depends | Via agent | AI agent |

---

## 11. Querying

### Local Queries Only (Part 1)

All SPARQL queries execute **locally** against the node's own triple store. There is no remote query interface. This is a direct consequence of Design Principles 6 (Store Isolation) and 7 (Protocol-Mediated Mutations).

Standard SPARQL via the storage adapter:

```sparql
SELECT ?s ?p ?o WHERE { GRAPH <did:dkg:paranet:agent-registry> { ?s ?p ?o } }
```

Since Phase 1 uses full replication (every paranet node stores all public triples), local queries are sufficient — the node always has the complete public dataset for its subscribed paranets.

### No Federated Queries (Part 1)

Federated SPARQL (routing sub-queries to peer nodes) is **not supported** in Part 1. Reasons:

1. **Security** — Exposing query endpoints to untrusted peers leaks query patterns and creates a direct attack surface on the store.
2. **Unnecessary** — Full replication means every node has all public triples for its paranets. There is nothing to federate.
3. **Complexity** — Federation introduces query routing, result merging, and trust/cost models that are premature for the initial release.

> **Part 2**: If selective replication or sharding is introduced, constrained cross-node data retrieval may be added as an opt-in capability with explicit allowlists, protocol-level access control, and rate limiting. This would operate through a defined protocol message (not raw SPARQL passthrough), where the responding node controls what data is returned. See Part 2 §10.8.

### KA Resolution

Resolve `did:dkg:base:8453/0xKCS/42/1`:

```sparql
# Step 1: get rootEntity and paranet from metadata
SELECT ?entity ?paranet WHERE {
  GRAPH ?meta {
    <did:dkg:base:8453/0xKCS/42/1> dkg:rootEntity ?entity ;
                                    dkg:partOfCollection ?kc .
    ?kc dkg:inParanet ?paranet .
  }
}
# → entity=<did:dkg:agent:QmImageBot>, paranet=<did:dkg:paranet:agent-registry>

# Step 2: get all triples about ImageBot from the paranet (includes skolemized sub-nodes)
SELECT ?s ?p ?o WHERE {
  GRAPH <did:dkg:paranet:agent-registry> {
    ?s ?p ?o .
    FILTER(?s = <did:dkg:agent:QmImageBot> || STRSTARTS(STR(?s), "did:dkg:agent:QmImageBot/.well-known/genid/"))
  }
}
```

Optional step 3: verify by recomputing merkle root from returned triples and comparing to `kaMerkleRoot`.

### Provenance Query

"Who published ImageBot's profile?"

```sparql
SELECT ?publisher ?txHash ?when WHERE {
  GRAPH <did:dkg:paranet:agent-registry/_meta> {
    ?ka  dkg:rootEntity         <did:dkg:agent:QmImageBot> ;
         dkg:partOfCollection   ?kc .
    ?kc  prov:wasGeneratedBy    ?activity .
    ?activity prov:wasAssociatedWith ?publisher ;
              dkg:transactionHash    ?txHash ;
              prov:startedAtTime     ?when .
  }
}
```

### Private Triple Discovery

"What KAs have private triples in this paranet, and how much to access them?"

```sparql
SELECT ?ka ?entity ?publicCount ?privateCount ?price WHERE {
  GRAPH <did:dkg:paranet:agent-registry/_meta> {
    ?ka  a dkg:KnowledgeAsset ;
         dkg:rootEntity          ?entity ;
         dkg:publicTripleCount   ?publicCount ;
         dkg:privateTripleCount  ?privateCount ;
         dkg:accessPolicy        [ dkg:price ?price ] .
    FILTER(?privateCount > 0)
  }
}
```

The meta graph is public — anyone can discover which KAs have private portions and their price. Accessing the actual private triples requires the `/dkg/access/1.0.0` protocol with payment proof. The public triples for these same entities are already queryable in the paranet data graph.

---

## 12. Open Questions (Part 1)

| # | Question | Impact | Status |
|---|---|---|---|
| OQ1 | Light node storage limits and eviction policy | Browser/mobile viability | Open |
| OQ2 | ~~Federated query cost~~ | ~~Economy~~ | **Resolved: No federated queries in Part 1. Store isolation is a core design principle (§1.6, §1.7). Constrained cross-node retrieval may be opt-in in Part 2 (§10.8).** |
| OQ3 | Agent profile update frequency and stale profile handling | Discovery accuracy | Open |
| OQ4 | Skill verification — how to verify an agent performs advertised skills? | Marketplace trust | Open |
| OQ5 | ~~Multi-publisher same entity~~ | ~~Data integrity~~ | **Resolved: entity exclusivity per paranet** |

### Deferred to Part 2

These are known gaps in Part 1 that are intentionally deferred:

| Topic | What Part 2 adds |
|---|---|
| **Paranet lifecycle** | On-chain paranet creation, parameters, governance |
| **Sync protocol** | `/dkg/sync/1.0.0` for new node bootstrapping and catch-up |
| **Paranet membership** | How nodes join/leave paranets, on-chain registration |
| **Access policy in protobuf** | Publisher-declared pricing in PublishRequest manifest |
| **GossipSub authentication** | Signed messages, validation rules, spam prevention |
| **Access dispute resolution** | Payment escrow, refund on merkle verification failure |
| **SLIP-10 key derivation** | Correct Ed25519 derivation standard (replaces BIP-32 reference) |
| **Sharding** | Selective replication to replace Phase 1 full replication |
| **Private triple redundancy** | Trusted delegate replication for availability |

---

## 13. Work Packages

### Phase 1 (parallel): Off-Chain Marketplace — WP-1A-i + WP-1B

Both developers work in parallel. No blockchain dependency. The full agent marketplace works end-to-end with mock finalization.

#### WP-1A-i: Protocol Core — Developer A

**Scope**: `@dkg/core`, `@dkg/storage`, `@dkg/publisher` (mock-chain), `@dkg/query`

| # | Deliverable |
|---|---|
| 1 | `@dkg/core`: libp2p node (TCP+Noise+yamux+WebSocket+WebTransport), peer discovery (DHT+mDNS), GossipSub (paranet topics), protocol router, event bus, crypto (Ed25519, ECDSA, merkle trees, URDNA2015) |
| 2 | `@dkg/storage`: In-memory + Oxigraph adapters, TripleStore interface, named graph manager (data graph + meta graph per paranet), private KA content store (publisher-only triples, flagged in meta graph) |
| 3 | `@dkg/publisher` (mock-chain mode): entity-based auto-partitioning, triple canonicalization, merkle tree computation (public + private KA roots), PublishRequest/Ack P2P flow, private KA manifest with pre-computed roots, metadata triple generation. UAL reservation = local counter. Finalization = auto-confirm. |
| 4 | `@dkg/query`: Local-only SPARQL, paranet-scoped queries, KA resolution (rootEntity lookup), result formats. No remote query exposure — all queries run against the node's own store (see §11). |
| 5 | `/dkg/access/1.0.0`: Private KA access protocol — AccessRequest/Response handler, payment proof verification (mock), merkle verification on recipient side, triple transfer |

#### WP-1B: Agent Layer — Developer B

**Scope**: `@dkg/agent`, skill ontology, messaging, framework adapters

| # | Deliverable |
|---|---|
| 1 | Agent identity: Ed25519 keygen, BIP-32 wallet derivation, AgentWallet implementation |
| 2 | Skill ontology: `dkgskill:` RDF ontology (Turtle), SHACL shapes for profiles/offerings |
| 3 | Profile publishing: publish/update agent profile as KA in Agent Registry (uses Publisher interface, mocked initially) |
| 4 | Discovery client: SPARQL query builder for skill search (uses Query interface, mocked initially) |
| 5 | Messaging: `/dkg/message/1.0.0` handler, X25519 encryption, SkillRequest/Response, conversation management |
| 6 | Framework adapters: OpenClaw DkgNodeSkill + ElizaOS plugin (basic) |

#### Phase 1 Integration Milestone

Two agents (one OpenClaw, one ElizaOS) running on separate machines, **no blockchain**:
- Both join the P2P network via libp2p
- Both publish profiles to Agent Registry paranet (mock-chain auto-confirm)
- Agent A discovers Agent B via SPARQL skill search
- Agent A sends encrypted SkillRequest to Agent B
- Agent B responds with SkillResponse
- Published knowledge is queryable by both agents
- KAs resolvable by UAL (rootEntity lookup)
- Agent A publishes a KC with mixed public/private KAs — public triples visible on all nodes, private triples only on Agent A's node
- Agent B sees private KA exists in meta graph, sends AccessRequest with mock payment → receives triples → verifies merkle root
- GossipSub broadcasts propagate new KC events across subscribed nodes

---

### Phase 2 (after Phase 1): Blockchain Anchoring — WP-1A-ii + WP-1B-ii

Both devs' Phase 1 work is complete. Both devs add blockchain support in parallel (one chain each). Dev B can interleave this with early Part 2 economy work.

#### ChainAdapter Interface (defined jointly, implemented per chain)

```
interface ChainAdapter {
    chainType: "evm" | "solana"
    chainId: string

    // Identity
    registerIdentity(proof: IdentityProof): Promise<IdentityId>

    // Publishing
    reserveKnowledgeCollectionIds(count: number): Promise<ReservedRange>
    createKnowledgeCollection(params: CreateKCParams): Promise<TxResult>
    updateKnowledgeCollection(params: UpdateKCParams): Promise<TxResult>

    // Events
    listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent>

    // Paranet
    createParanet(params: CreateParanetParams): Promise<TxResult>
    submitToParanet(kcId: string, paranetId: string): Promise<TxResult>
}
```

The publisher calls `ChainAdapter` methods — it never knows which chain it's talking to.

#### WP-1A-ii: EVM Adapter — Developer A

| # | Deliverable |
|---|---|
| 1 | `@dkg/chain` package: `ChainAdapter` interface, adapter registry, mock adapter (wraps Phase 1 mock-chain) |
| 2 | EVM adapter (ethers.js): contract clients for KnowledgeCollection, KnowledgeCollectionStorage, ParametersStorage. Event listener (polling + WebSocket). Tx manager with gas estimation and retry. |
| 3 | Wire into publisher: real UAL reservation, on-chain finalization, event-driven tentative→confirmed lifecycle. Publisher calls `ChainAdapter`, unaware of EVM specifics. |

#### WP-1B-ii: Solana Adapter — Developer B

| # | Deliverable |
|---|---|
| 1 | Solana programs (Anchor): `dkg_knowledge` — reserve KC IDs, create KC (store merkle root in PDA), mint KA tokens via SPL Token-2022. Basic test suite on localnet. |
| 2 | Solana adapter (@solana/web3.js): implements `ChainAdapter`. Program clients, account change listener, tx builder. |
| 3 | Wire into publisher: same `ChainAdapter` interface — publisher works identically on EVM and Solana. |

#### Phase 2 Integration Milestone

Same agents as Phase 1, now anchored on-chain on **both** chains:
- EVM (Hardhat local): UAL reservation, KC finalization, KA token minting, event-driven confirmation
- Solana (localnet): same flow via Solana adapter and Anchor programs
- Publisher code is identical — only the `ChainAdapter` implementation differs
- Mock adapter retained for testing (no chain needed)

---

### Shared Interface Contracts (before Phase 1 — both devs)

| Interface | Owner | Consumer |
|---|---|---|
| `TripleStore` | Dev A | Dev B |
| `Publisher` | Dev A | Dev B (profile publishing) |
| `QueryEngine` | Dev A | Dev B (discovery) |
| `ProtocolRouter` | Dev A | Dev B (messaging protocol registration) |
| `AgentWallet` | Dev B | Dev A (chain signing) |
| `AgentMessage` protobuf | Dev B | Dev A (routing) |
| `ChainAdapter` | Joint (interface defined together) | Dev A implements EVM, Dev B implements Solana |

**Rule**: Shared interfaces defined before Phase 1. `ChainAdapter` finalized before Phase 2. Changes require PR + approval from both devs.
