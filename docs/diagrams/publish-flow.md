# Publish Flow

Sequence diagram showing the full lifecycle of a `publish()` call, from the
user-facing API through every internal module down to on-chain finality and
peer-to-peer replication.

The key insight is that **P2P replication happens before the on-chain
transaction**. The blockchain tx is the _finalization_ step — it can only
succeed once enough receiving nodes have validated the data and returned
their ECDSA signatures. After the tx confirms, receiving nodes promote
their tentative data to permanent.

## Design decisions

- **Triples, not quads** — the publish message carries `paranetId` in the
  envelope, so the graph component (`G` in SPOG) is redundant on the wire.
  Receiving nodes derive it as `did:dkg:paranet:{paranetId}`.
- **Two-level merkle root** — private triples hash into a `privateMerkleRoot`,
  which is anchored as a synthetic public triple. All public triples
  (including the anchor) hash into the `kcMerkleRoot` that goes on-chain.
- **`entityProofs: true` (opt-in)** — when enabled, triples are grouped by
  root entity and each group gets its own `kaRoot`. The `kcMerkleRoot` is then
  a Merkle tree over the sorted `kaRoot` values instead of a flat hash. This
  lets you prove a specific entity is in the batch without revealing the
  others. Off by default — the flat hash is simpler and cheaper.
- **No re-query** — the publisher already holds the triples from the publish
  call. They are passed directly to the broadcast step.
- **No publisher signature** — the contract derives the publisher node's
  identity from `msg.sender` via `IdentityStorage.getIdentityId()`. No
  separate ECDSA signature needed when the node publishes its own data.
- **Dual confirmation** — receiving nodes use both mechanisms:
  1. **GossipSub** — fast hint from the publisher that the tx landed.
  2. **ChainEventPoller** — trustless background polling for
     `KnowledgeBatchCreated` events, independent of the publisher.
  The chain event is the authoritative source. If the publisher goes offline
  after submitting the tx, the poller still confirms the data.
- **operationId** — every publish generates a UUID that is threaded through
  all modules and included in the GossipSub message. Log format:
  `YYYY-MM-DD HH:MM:SS publish <operationId> "message"`. Enables cross-node
  log correlation on testnet.

## Merkle computation

```
Default (entityProofs: false)         With entityProofs: true
─────────────────────────────         ─────────────────────────
                                      autoPartition by root entity
                                              │
private triples                       private triples
    │ sort + hash                         │ sort + hash
    ▼                                     ▼
privateMerkleRoot                     privateMerkleRoot
    │                                     │
    ▼ emit synthetic triple               ▼ emit synthetic triple
    ┌──────────────────────┐              ┌──────────────────────┐
    │ <kc> dkg:private-    │              │ <kc> dkg:private-    │
    │   ContentRoot "0x…"  │              │   ContentRoot "0x…"  │
    └──────────────────────┘              └──────────────────────┘
    │ add to public triples               │ add to public triples
    ▼                                     ▼
all public triples                    per-entity groups
    │ sort + hash                         │ hash each group
    ▼                                     ▼
kcMerkleRoot ◄── on-chain            kaRoot₁, kaRoot₂, … kaRootₙ
                                          │ build Merkle tree
                                          ▼
                                      kcMerkleRoot ◄── on-chain
                                          + per-KA Merkle proofs
                                            stored in metadata
```

## Sequence diagram

```mermaid
sequenceDiagram
    actor User

    participant Agent as @origintrail-official/dkg-agent<br/>DKGAgent
    participant Publisher as @origintrail-official/dkg-publisher<br/>DKGPublisher
    participant Crypto as @origintrail-official/dkg-core<br/>Crypto
    participant Store as @origintrail-official/dkg-storage<br/>TripleStore
    participant Chain as @origintrail-official/dkg-chain<br/>EVMChainAdapter
    participant EVM as EVM Blockchain
    participant Gossip as @origintrail-official/dkg-core<br/>GossipSub

    participant RcvAgent as Receiver<br/>Agent
    participant RcvCrypto as Receiver<br/>Crypto
    participant RcvStore as Receiver<br/>TripleStore

    Note over User,Gossip: Phase 1 — Local Preparation (publisher node)

    User ->> Agent: publish(paranetId, triples, options?)
    Agent ->> Agent: Generate operationId (UUID)
    Agent ->> Agent: Validate paranet exists

    Agent ->> Publisher: publish(paranetId, triples, privateTriples, operationId)

    Publisher ->> Publisher: autoPartition(triples)
    Note right of Publisher: Groups triples by root entity<br/>Skolemizes blank nodes

    opt Has private triples
        Publisher ->> Crypto: hash(sorted private triples)
        Crypto -->> Publisher: privateMerkleRoot
        Publisher ->> Publisher: Add synthetic triple anchoring privateMerkleRoot
    end

    alt entityProofs: false (default)
        Publisher ->> Crypto: hash(sorted public triples)
        Crypto -->> Publisher: kcMerkleRoot
    else entityProofs: true
        loop For each root entity
            Publisher ->> Crypto: hash(entity's sorted triples)
            Crypto -->> Publisher: kaRoot
        end
        Publisher ->> Crypto: MerkleTree(sorted kaRoots)
        Crypto -->> Publisher: kcMerkleRoot
        Publisher ->> Publisher: Store Merkle proofs in metadata
    end

    Publisher ->> Publisher: validatePublishRequest()
    Note right of Publisher: Entity exclusivity<br/>No raw blank nodes

    Publisher ->> Crypto: ed25519Sign(kcMerkleRoot, secretKey)
    Crypto -->> Publisher: ed25519Signature

    Note over User,Gossip: Phase 2 — Tentative Local Storage (publisher node)

    Publisher ->> Store: graphManager.ensureParanet(paranetId)
    Store -->> Publisher: data graph + meta graph ready

    Publisher ->> Store: store.insert(triples into data graph)
    opt Has private triples
        Publisher ->> Store: privateStore.storePrivateTriples(...)
    end

    Publisher ->> Store: store.insert(tentativeMetadata)
    Note right of Store: KC + KA entries in meta graph<br/>status = tentative

    Note over Agent,RcvStore: Phase 3 — P2P Broadcast + Signature Collection

    Agent ->> Agent: Serialize triples to N-Triples
    Agent ->> Agent: encodePublishRequest (protobuf)
    Note right of Agent: operationId / paranetId / ntriples<br/>entityProofs flag / kas[]<br/>publisherIdentity / merkleRoot

    Agent ->> Gossip: publish(topic, message)
    Note right of Gossip: topic = dkg/paranet/id/publish
    Gossip ->> RcvAgent: GossipSub broadcast

    Note over RcvAgent,RcvStore: Receiving node validates + stores (same operationId in logs)

    RcvAgent ->> RcvAgent: decodePublishRequest(data)
    RcvAgent ->> RcvAgent: parseNTriples(data)

    alt entityProofs: false
        RcvAgent ->> RcvCrypto: hash(sorted received triples)
        RcvCrypto -->> RcvAgent: recomputedRoot
    else entityProofs: true
        RcvAgent ->> RcvAgent: autoPartition by root entity
        loop For each root entity
            RcvAgent ->> RcvCrypto: hash(entity's sorted triples)
            RcvCrypto -->> RcvAgent: kaRoot
        end
        RcvAgent ->> RcvCrypto: MerkleTree(sorted kaRoots)
        RcvCrypto -->> RcvAgent: recomputedRoot
    end
    RcvAgent ->> RcvAgent: Verify recomputedRoot == merkleRoot

    RcvAgent ->> RcvAgent: validatePublishRequest()
    RcvAgent ->> RcvStore: store.insert(triples) — tentative
    Note right of RcvStore: Data stored but not yet<br/>committed. Expires if no<br/>on-chain confirmation.

    RcvAgent ->> RcvCrypto: ECDSA sign(merkleRoot) with operational key
    RcvCrypto -->> RcvAgent: signatureR + signatureVs
    RcvAgent -->> Agent: PublishAck(identityId, signatureR, signatureVs)

    Agent ->> Agent: Collect receiver signatures
    Note right of Agent: Waits until 3+ valid<br/>receiver signatures collected<br/>(minimumRequiredSignatures)

    Note over User,EVM: Phase 4 — On-Chain Finalization (publisher node)

    Publisher ->> Chain: publishKnowledgeAssets(params)
    Note right of Chain: kaCount + merkleRoot<br/>receiverSignatures (3+ r, vs)<br/>epochs + tokenAmount
    Note right of Chain: Contract derives publisher identity<br/>from msg.sender — no separate sig

    Chain ->> Chain: init() — resolve contracts from Hub
    opt tokenAmount is nonzero
        Chain ->> EVM: token.approve(kaAddress, amount)
        EVM -->> Chain: approve tx receipt
    end
    Chain ->> EVM: KnowledgeAssets.publishKnowledgeAssets(...)
    Note right of EVM: Verifies 3+ receiver sigs<br/>(all must be registered node<br/>operational keys)<br/>Derives publisher from msg.sender<br/>Reserves UAL range<br/>Creates KnowledgeBatch
    EVM -->> Chain: tx receipt with logs

    Chain ->> Chain: Parse UALRangeReserved event
    Chain ->> Chain: Parse KnowledgeBatchCreated event
    Chain ->> EVM: getBlock(blockNumber)
    EVM -->> Chain: blockTimestamp

    Chain -->> Publisher: OnChainPublishResult
    Note left of Chain: batchId / startKAId / endKAId<br/>txHash / blockNumber<br/>blockTimestamp / publisherAddress

    Note over Agent,RcvStore: Phase 5 — Confirmation + Commit

    Publisher ->> Publisher: Build V9 UAL
    Note right of Publisher: did:dkg:chainId/publisherAddr/startKAId

    Publisher ->> Store: store.insert(confirmedMetadata)
    Note right of Store: txHash / blockNumber / batchId<br/>status = confirmed

    Publisher ->> Publisher: eventBus.emit(KC_PUBLISHED)
    Publisher -->> Agent: PublishResult
    Agent -->> User: PublishResult
    Note right of User: kcId / merkleRoot<br/>kaManifest / status=confirmed<br/>onChainResult

    Note over RcvAgent,RcvStore: Receiver confirms via chain events (independent)

    RcvAgent ->> EVM: Poll/subscribe KnowledgeBatchCreated events
    EVM -->> RcvAgent: Event with matching merkleRoot
    RcvAgent ->> RcvStore: Promote tentative → committed
    Note right of RcvStore: Delete tentative status quad<br/>Insert confirmed status quad<br/>Clear expiry timeout

```

## LiftJob sequence

This sequence shows the explicit LiftJob state progression introduced for the
async lift-and-publish flow described in the async publisher spec. Unlike the
regular `publish()` path above, lift jobs start from data that is already in
workspace, skip gossip, and submit directly to chain. The happy path is
strictly linear, and every non-terminal state may transition to `failed` if
its step cannot complete.

### LiftJob states

| State | Meaning |
|------|------|
| `accepted` | Job is stored in the control-plane queue and has not been picked up by a worker yet. |
| `claimed` | A dedicated publisher wallet or worker has claimed the job for exclusive processing. |
| `validated` | Workspace slice, namespace authority, and transition type checks have all passed. |
| `broadcast` | The chain transaction has been submitted directly and the job now has a `txHash`. |
| `included` | The transaction is included in a block but is not final yet. |
| `finalized` | Chain finality is reached and the published canonical state is authoritative. |
| `failed` | Processing stopped due to an error, and full failure details are persisted. |

### Allowed transitions

- `accepted -> claimed`
- `claimed -> validated`
- `validated -> broadcast`
- `broadcast -> included`
- `included -> finalized`
- `accepted|claimed|validated|broadcast|included -> failed`
- `finalized` and `failed` are terminal

```mermaid
sequenceDiagram
    actor Caller
    participant Queue as LiftJob Queue
    participant Worker as Lift Worker
    participant Workspace as Workspace Store
    participant Validator as Validation Step
    participant Publisher as Batch Publisher
    participant Chain as Chain Watcher

    Caller->>Queue: enqueue lift request
    Queue-->>Worker: job accepted
    Note over Queue,Worker: state = accepted

    Worker->>Worker: claim exclusive work
    Note over Worker: state = claimed

    Worker->>Workspace: load workspace slice by roots
    Workspace-->>Worker: candidate triples

    Worker->>Validator: canonicalize URIs + validate authority
    Validator-->>Worker: payload valid for lift
    Note over Validator,Worker: state = validated

    Worker->>Publisher: compute merkle + sign + submit batch
    Publisher->>Chain: publishBatch()
    Chain-->>Publisher: txHash accepted
    Publisher-->>Worker: txHash recorded
    Note over Publisher,Worker: state = broadcast

    Chain-->>Worker: tx included in block
    Note over Worker,Chain: state = included

    Chain-->>Worker: finality reached
    Note over Worker: state = finalized

    alt error in any active step
        Worker-->>Queue: persist failure details
        Note over Queue,Worker: state = failed
    end
```

### Finality-aware recovery

The async publisher spec requires recovery to be chain-aware rather than
blindly retrying interrupted jobs. On startup, the worker checks interrupted
states and only requeues jobs when chain state proves they were not already
published.

```mermaid
sequenceDiagram
    participant Boot as Node Startup
    participant Store as Job Store
    participant Chain as Chain Adapter
    participant Wallets as Wallet Locks

    Boot->>Store: load jobs in claimed/validated/broadcast
    loop for each interrupted job
        alt job.state == broadcast
            Boot->>Chain: lookup txHash / finality status
            alt tx succeeded
                Boot->>Store: mark finalized
            else tx missing or not landed
                Boot->>Store: reset to accepted
            end
        else job.state == claimed or validated
            Boot->>Store: reset to accepted
        end
    end
    Boot->>Wallets: release stale wallet locks
```

Recovery rules from the spec:

- Inspect interrupted jobs in `claimed`, `validated`, and `broadcast`
- For `broadcast`, check chain state by `txHash` before changing the job
- Mark `finalized` when the transaction already succeeded on-chain
- Reset non-final interrupted jobs to `accepted` for retry
- Release stale wallet locks during recovery so workers can resume cleanly

## How tentative → committed is reflected in the graph

Tentative vs committed is **reflected only in the paranet’s meta graph**
(`did:dkg:paranet:{paranetId}/_meta`), not in the data graph. The data graph
holds the same triples either way; the meta graph records lifecycle and
on-chain provenance.

**Clean model:** For a given KC (UAL), the meta graph is in exactly one of two
states — never both:

- **Tentative:** There is a triple `(ual, dkg:status, "tentative")` and **no**
  blockchain provenance triples (txHash, blockNumber, etc.). The KC/KA structure
  may be present.
- **Confirmed:** There is **no** tentative triple; there is
  `(ual, dkg:status, "confirmed")` and optionally chain provenance triples
  (txHash, blockNumber, blockTimestamp, publisherAddress, batchId, chainId).

So an agent that queries for status sees either “tentative” or “confirmed”,
never ambiguous.

### Publisher node

- **On-chain tx fails:** Publisher inserts full KC/KA metadata plus
  `(ual, dkg:status, "tentative")` into the meta graph. Data stays in the data
  graph; the KC is tentative until it expires or is retried.
- **On-chain tx succeeds:** Publisher inserts **only** confirmed metadata: full
  KC/KA structure plus `(ual, dkg:status, "confirmed")` and chain provenance. No
  tentative triple is written. So the graph has either tentative or confirmed,
  never both.

Promotion on the publisher = **do not write tentative** when you are about to
write confirmed (success path inserts confirmed-only).

### Receiver node

- **Tentative:** On P2P receive, the receiver inserts triples into the **data
  graph** and **tentative metadata** into the **meta graph** (KC/KA +
  `dkg:status "tentative"`). It starts a 1-hour timeout; if no on-chain
  confirmation is seen, it deletes those data and metadata quads.
- **Committed:** When the receiver sees the matching `KnowledgeBatchCreated`
  event, it **deletes** the tentative status quad
  `(ual, dkg:status, "tentative")` from the meta graph, **inserts**
  `(ual, dkg:status, "confirmed")`, and clears the timeout. So the graph moves
  from “tentative only” to “confirmed only”; no KC has both status triples.

Promotion on the receiver = **delete tentative status quad, insert confirmed
status quad** in the meta graph, then clear the expiry timeout.
