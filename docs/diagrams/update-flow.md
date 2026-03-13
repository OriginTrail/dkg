# Update Flow

Sequence diagram for updating an existing Knowledge Collection (KC). The
publisher replaces triples for specific root entities within an already-published
KC, recomputes the Merkle root, and submits an on-chain update transaction.

## Key differences from publish

| Aspect | Publish | Update |
|--------|---------|--------|
| UAL | New — reserved on-chain | Existing — reused |
| Old data | None | Deleted before insert |
| On-chain | `publishKnowledgeAssets` | `updateKnowledgeAssets` |
| Receiver signatures | Required (3+) | Not required |
| P2P broadcast | Full KC triples | Only changed entities |

Updates are simpler than publishes because:
- The KC already exists on-chain; only the merkle root needs updating
- No receiver signatures needed (the batch was already validated at publish time)
- Only the publisher can update (the contract enforces `msg.sender` ownership)

**Optional extension:** A node can optionally keep a snapshot of replaced triples
in a separate “historical” graph/namespace before deleting them, enabling
time-travel queries (see [Optional: Historical state](#optional-historical-state-time-travel) below). This is not required of core or receiver nodes.

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

    Note over User,Gossip: Phase 1 — Local Preparation

    User ->> Agent: update(kcId, paranetId, triples, privateTriples?)
    Agent ->> Agent: Generate operationId (UUID)
    Agent ->> Publisher: update(kcId, paranetId, triples, operationId)

    Publisher ->> Publisher: autoPartition(triples)
    Note right of Publisher: Groups triples by root entity

    Note over Publisher,Store: Phase 2 — Replace Local Data

    loop For each root entity
        opt storeHistory (optional)
            Publisher ->> Store: query triples by subject prefix (current state)
            Store -->> Publisher: old quads
            Publisher ->> Store: insert(old quads, historicalGraphUri(revisionId))
            Note right of Store: Snapshot stored in historical namespace
        end
        Publisher ->> Store: deleteBySubjectPrefix(dataGraph, rootEntity)
        Publisher ->> Store: deletePrivateTriples(paranetId, rootEntity)
        Note right of Store: Old triples removed

        Publisher ->> Store: store.insert(new public triples)
        opt Has private triples for this entity
            Publisher ->> Store: privateStore.storePrivateTriples(...)
        end
    end

    Note over Publisher,Crypto: Phase 3 — Recompute Merkle Root

    opt Has private triples
        Publisher ->> Crypto: hash(sorted ALL private triples)
        Crypto -->> Publisher: privateMerkleRoot
        Publisher ->> Publisher: Create synthetic anchor triple
    end

    alt entityProofs: false (default)
        Publisher ->> Crypto: hash(sorted all public triples + synthetic)
        Crypto -->> Publisher: newKcMerkleRoot
    else entityProofs: true
        loop For each root entity
            Publisher ->> Crypto: hash(entity's sorted triples)
            Crypto -->> Publisher: kaRoot
        end
        Publisher ->> Crypto: MerkleTree(sorted kaRoots)
        Crypto -->> Publisher: newKcMerkleRoot
    end

    Note over Publisher,EVM: Phase 4 — On-Chain Update

    Publisher ->> Chain: updateKnowledgeAssets(batchId, newMerkleRoot, byteSize)
    Note right of Chain: Contract verifies msg.sender<br/>is the original publisher
    Chain ->> EVM: KnowledgeAssets.updateKnowledgeAssets(...)
    EVM -->> Chain: tx receipt
    Chain -->> Publisher: TxResult

    Publisher ->> Publisher: eventBus.emit(KA_UPDATED)
    Publisher -->> Agent: PublishResult (status=confirmed)
    Agent -->> User: PublishResult

    Note over Agent,RcvAgent: Phase 5 — P2P Update Broadcast

    Agent ->> Agent: Serialize changed triples to N-Triples
    Agent ->> Gossip: publish(topic, updateMessage)
    Note right of Gossip: topic = dkg/paranet/id/update<br/>Contains kcId + new triples + new merkleRoot

    RcvAgent ->> EVM: Poll KnowledgeAssetsUpdated event
    EVM -->> RcvAgent: Event with matching batchId + newMerkleRoot

    RcvAgent ->> RcvAgent: Replace old triples with new
    RcvAgent ->> RcvAgent: Verify recomputed root matches on-chain root
```

## Update validation on receivers

There is no tentative phase for updates: receivers replace triples only after
they have seen the on-chain event. The **tentative → committed** lifecycle
(applying to the meta graph and timeout on the receiver) applies only to the
[initial publish](publish-flow.md#how-tentative--committed-is-reflected-in-the-graph), not to updates.

When a receiver gets an update broadcast, it:

1. **Checks the chain event** — the `KnowledgeAssetsUpdated` event must exist
   with a matching `batchId` and `newMerkleRoot`.
2. **Verifies the publisher** — the on-chain event's `msg.sender` must match
   the original publisher of the KC.
3. **Replaces triples** — deletes old triples for the affected root entities
   and inserts the new ones.
4. **Recomputes the merkle root** — the recomputed root from the new data must
   match the on-chain root. If not, the update is rejected and old data is
   kept.

---

## Optional: Historical state (time travel)

The default update flow **replaces** triples: old triples are deleted and new
ones inserted. The chain only stores the latest merkle root, so there is no
protocol-level requirement to keep previous states. Core nodes and receivers
are not incentivised to retain history.

A **publisher or a dedicated node** may still want to offer **time travel**:
the ability to query the graph as it was at a past revision or point in time.
This can be done by optionally storing a snapshot of the replaced state before
deleting it, without changing the core update or on-chain semantics.

### Design

- **Optional** — Controlled by a flag (e.g. `storeHistory: true`) on the
  update call. If set, before each `deleteBySubjectPrefix` the publisher (or
  node) copies the current triples for that root entity into a **historical**
  store.
- **Separate graph / namespace** — History is kept out of the main data graph.
  For example:
  - A separate Blazegraph **namespace** (e.g. `historical`), or
  - Named graphs in the same store with a convention such as  
    `urn:dkg:historical:{paranetId}:{kcId}:{rootEntity}:{revisionId}`.
- **Revision identifier** — Each snapshot is keyed by a revision. Using the
  existing `operationId` (UUID) gives a stable “revision R”. Optionally store
  a timestamp (e.g. from the update event or block time) to support “as of
  time T” queries.
- **What is stored** — For each root entity being updated: the triples that
  would be deleted (current state) are written into the historical graph for
  that revision. Private triples can be included in the same way if the node
  keeps a private historical store.
- **Receivers** — Receivers are not required to implement history. Only nodes
  that opt in (e.g. the publisher or a dedicated archive node) need a
  historical namespace and the copy-before-delete step.

### Querying past state

- **Current state** — Unchanged: query the normal data graph (and meta graph)
  as today.
- **Time travel** — To get “graph as of revision R” or “as of time T”, the
  client (or a query endpoint that supports it) targets the historical
  namespace: either the named graph for that revision or a union of historical
  graphs with a filter on revision/timestamp. The exact SPARQL or API shape
  can be defined where this feature is implemented (e.g. in the query engine or
  a dedicated historical API).
