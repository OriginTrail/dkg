# Plan: Workspace Upsert Semantics & Knowledge Asset Updates

## Motivation

The DKG is designed as **shared memory for AI agent coordination**. Agents need:

1. **Mutable working memory** (workspace) — agents constantly update shared state
   during coordination (player status, task assignments, resource allocations).
2. **Immutable attested knowledge** (data graph) — consensus-verified facts that
   are permanent and auditable.
3. **Owner-controlled updates** to attested knowledge — the creator of a knowledge
   asset can update it on-chain, with a transaction proving intent.

Currently, **Rule 4 (entity exclusivity)** applies equally to workspace writes and
publishes, which forces app developers to mint synthetic unique URIs instead of
naturally updating entities. This creates friction, graph bloat, and doesn't match
how agents actually work.

---

## Part A: Workspace Creator-Only Upsert

### Design Principle

Workspace is pre-consensus working memory. Each agent can **create** new entities
and **update entities it created**. Agents cannot overwrite each other's entities.
This mirrors the data graph model (batch publisher = owner) and prevents accidental
or malicious corruption while enabling natural state updates.

### 3-Agent Coordination Example

```
Alice (peerA), Bob (peerB), Carol (peerC) coordinate via paranet "data-ops"

Step 1 — Alice creates a task:
  Alice writes:  <task/t1>  status "open", createdBy <player/peerA>
  Result:        ✅ new entity, Alice becomes creator of <task/t1>
  All nodes:     <task/t1> → creator: peerA

Step 2 — Bob registers himself:
  Bob writes:    <player/peerB>  status "available", skills "cleaning"
  Result:        ✅ new entity, Bob is creator of <player/peerB>

Step 3 — Alice assigns the task to Bob (upsert her own entity):
  Alice writes:  <task/t1>  status "in-progress", assignedTo <player/peerB>
  Result:        ✅ Alice is creator of <task/t1> → upsert allowed
                 Old triples for <task/t1> are REPLACED with new ones

Step 4 — Bob tries to update the task directly:
  Bob writes:    <task/t1>  status "done"
  Result:        ❌ REJECTED — Bob is not the creator of <task/t1>
                 Bob must signal via gossip; Alice (or consensus) updates

Step 5 — Bob updates his own status:
  Bob writes:    <player/peerB>  status "busy", currentTask <task/t1>
  Result:        ✅ Bob is creator of <player/peerB> → upsert allowed
```

### How Ownership Is Tracked (Off-Chain)

#### Current state

```
workspaceOwnedEntities: Map<paranetId, Set<rootEntity>>
```

A flat set — knows an entity exists in the workspace, but not who wrote it.

#### New state

```
workspaceOwnedEntities: Map<paranetId, Map<rootEntity, creatorPeerId>>
```

Maps each root entity to the peerId that first wrote it. This is the **single
source of truth** for workspace ownership on each node.

#### Where ownership data comes from

The `publisherPeerId` is **already present** in every workspace gossip message:

```protobuf
WorkspacePublishRequest {
  paranetId:            string    // field 1
  nquads:               bytes     // field 2
  manifest:             repeated  // field 3 — list of rootEntities
  publisherPeerId:      string    // field 4 ← THIS IS THE CREATOR
  workspaceOperationId: string    // field 5
  timestampMs:          uint64    // field 6
}
```

And it's already stored in the workspace metadata graph:

```turtle
<urn:dkg:workspace:{paranetId}:{opId}>
    rdf:type              dkg:WorkspaceOperation ;
    prov:wasAttributedTo  "{publisherPeerId}" ;   ← creator provenance
    dkg:rootEntity        <entity-uri> ;
    dkg:publishedAt       "2026-03-06T..." .
```

So **no protocol changes** are needed. The `publisherPeerId` already flows through
every write — we just need to store it in memory alongside the entity.

#### Persistence across restarts

On node restart, `workspaceOwnedEntities` is rebuilt from the workspace metadata
graph by querying:

```sparql
SELECT ?entity ?peerId WHERE {
  GRAPH <{workspaceMetaGraph}> {
    ?op  dkg:rootEntity         ?entity ;
         prov:wasAttributedTo   ?peerId .
  }
}
```

This is a one-time query per paranet at startup. The data is already there —
we're just not using it yet.

### Implementation Details

#### 1. Type change: `Set<string>` → `Map<string, string>`

**Files affected:**

| File | Change |
|------|--------|
| `packages/publisher/src/dkg-publisher.ts` | `workspaceOwnedEntities: Map<string, Map<string, string>>` |
| `packages/publisher/src/workspace-handler.ts` | Same type change, same shared reference |
| `packages/agent/src/dkg-agent.ts` | Creates and passes the shared map |

The map signature: `Map<paranetId, Map<rootEntity, creatorPeerId>>`

#### 2. Validation change

**`packages/publisher/src/validation.ts`**

Add an options parameter:

```typescript
export interface ValidationOptions {
  /** When true, skip Rule 4 for entities in `upsertableEntities`. */
  allowUpsert?: boolean;
  /** Entities that the current writer is allowed to upsert (their own). */
  upsertableEntities?: Set<string>;
}

export function validatePublishRequest(
  nquads: Quad[],
  manifest: KAManifestEntry[],
  paranetId: string,
  existingEntities: Set<string>,
  options?: ValidationOptions,
): ValidationResult {
  // ...
  // Rule 4: Entity exclusivity
  for (const m of manifest) {
    if (existingEntities.has(m.rootEntity)) {
      if (options?.allowUpsert && options.upsertableEntities?.has(m.rootEntity)) {
        continue; // creator is updating their own entity — allowed
      }
      errors.push(
        `Rule 4: rootEntity "${m.rootEntity}" already exists in paranet "${paranetId}"`,
      );
    }
  }
  // ...
}
```

#### 3. writeToWorkspace flow (publisher)

**`packages/publisher/src/dkg-publisher.ts`**

```typescript
async writeToWorkspace(paranetId, quads, options) {
  // ... partition, manifest ...

  const dataOwned = this.ownedEntities.get(paranetId) ?? new Set();
  const wsOwned = this.workspaceOwnedEntities.get(paranetId) ?? new Map();

  // Entities in data graph — always blocked (must use update/publish path)
  // Entities in workspace owned by THIS writer — allowed (upsert)
  // Entities in workspace owned by ANOTHER writer — blocked
  const existing = new Set<string>([...dataOwned, ...wsOwned.keys()]);
  const upsertable = new Set<string>();
  for (const [entity, creator] of wsOwned) {
    if (creator === options.publisherPeerId) {
      upsertable.add(entity);
    }
  }

  const validation = validatePublishRequest(
    quads, manifest, paranetId, existing,
    { allowUpsert: true, upsertableEntities: upsertable },
  );
  if (!validation.valid) throw new Error(...);

  // Delete-then-insert for upserted entities
  const workspaceGraph = this.graphManager.workspaceGraphUri(paranetId);
  for (const m of manifest) {
    if (wsOwned.has(m.rootEntity)) {
      await this.store.deleteBySubjectPrefix(workspaceGraph, m.rootEntity);
    }
  }

  // Insert new triples
  await this.store.insert(normalized);

  // Track ownership: new entities get this writer as creator
  if (!this.workspaceOwnedEntities.has(paranetId)) {
    this.workspaceOwnedEntities.set(paranetId, new Map());
  }
  for (const r of rootEntities) {
    if (!wsOwned.has(r)) {
      // New entity — record creator
      this.workspaceOwnedEntities.get(paranetId)!.set(r, options.publisherPeerId);
    }
    // Existing entity by same creator — ownership unchanged
  }

  // ... encode gossip message (unchanged) ...
}
```

#### 4. WorkspaceHandler flow (gossip receiver)

**`packages/publisher/src/workspace-handler.ts`**

Same logic but uses `publisherPeerId` from the decoded gossip message:

```typescript
async handle(data: Uint8Array, fromPeerId: string) {
  const { publisherPeerId, manifest, ... } = decodeWorkspacePublishRequest(data);

  const wsOwned = this.workspaceOwnedEntities.get(paranetId) ?? new Map();
  const existing = new Set<string>([...wsOwned.keys()]);
  const upsertable = new Set<string>();
  for (const [entity, creator] of wsOwned) {
    if (creator === publisherPeerId) {
      upsertable.add(entity);
    }
  }

  const validation = validatePublishRequest(
    quads, manifest, paranetId, existing,
    { allowUpsert: true, upsertableEntities: upsertable },
  );
  if (!validation.valid) {
    this.log.warn(ctx, `Rejected: ${validation.errors.join('; ')}`);
    return; // silently drop on gossip
  }

  // Delete-then-insert for upserted entities
  for (const m of manifest) {
    if (wsOwned.has(m.rootEntity)) {
      await this.store.deleteBySubjectPrefix(workspaceGraph, m.rootEntity);
    }
  }

  await this.store.insert(normalized);

  // Track ownership
  for (const r of rootEntities) {
    if (!wsOwned.has(r)) {
      this.workspaceOwnedEntities.get(paranetId)!.set(r, publisherPeerId);
    }
  }
}
```

#### 5. Startup rehydration

**`packages/agent/src/dkg-agent.ts`** (or publisher init)

On startup, rebuild the ownership map from the workspace metadata graph:

```typescript
private async rehydrateWorkspaceOwnership(paranetId: string): Promise<void> {
  const metaGraph = this.graphManager.workspaceMetaGraphUri(paranetId);
  const result = await this.store.query(
    `SELECT ?entity ?peerId WHERE {
       GRAPH <${metaGraph}> {
         ?op  <${DKG}rootEntity>       ?entity ;
              <${PROV}wasAttributedTo>  ?peerId .
       }
     }`
  );
  const wsOwned = new Map<string, string>();
  for (const row of result.bindings) {
    const entity = row.entity;
    const peerId = stripLiteral(row.peerId);
    // First writer wins (earliest op); if multiple, latest op wins
    wsOwned.set(entity, peerId);
  }
  this.workspaceOwnedEntities.set(paranetId, wsOwned);
}
```

This query returns all `(entity, peerId)` pairs from workspace metadata.
If an entity was upserted, multiple operations exist for it — the latest one
(by insertion order) represents the current creator. Since creator-only upsert
guarantees the same peerId for all writes to an entity, order doesn't matter.

---

## Part B: Knowledge Asset Updates (Data Graph)

### Design Principle

The creator (batch publisher) of a knowledge asset can update its triples on-chain.
This requires a transaction, and only the batch publisher's address can submit it.
Other nodes verify the transaction before applying the update locally.

### Current State

`publisher.update(kcId, options)` already exists:
- Deletes old triples by subject prefix in the data graph
- Inserts new triples
- Calls `chain.updateKnowledgeAssets({ batchId, newMerkleRoot, newPublicByteSize })`
- Contract checks `msg.sender == batch.publisherAddress`

What's missing:
- No gossip propagation of updates to other nodes
- No `ownedEntities` bookkeeping that allows re-publishing updated entities
- `publish()` rejects entities that already exist (Rule 4) even if this node owns them

### Changes

#### 1. Gossip propagation of updates

New message type in `packages/core/src/proto/`:

```protobuf
KAUpdateRequest {
  paranetId:       string    // field 1
  batchId:         uint64    // field 2
  nquads:          bytes     // field 3
  manifest:        repeated  // field 4
  publisherPeerId: string    // field 5
  txHash:          string    // field 6  ← on-chain proof
  blockNumber:     uint64    // field 7
  timestampMs:     uint64    // field 8
}
```

Receiving nodes:
1. Verify `txHash` on-chain (confirm `updateKnowledgeAssets` was called for
   this `batchId` by the batch publisher)
2. Delete old triples for the updated root entities
3. Insert new triples
4. Update local metadata

#### 2. Smart publish with auto-update

Add `{ allowUpdate?: boolean }` option to `publish()`:

```typescript
async publish(options: PublishOptions & { allowUpdate?: boolean }) {
  const manifest = autoPartition(quads);
  const owned = this.ownedEntities.get(paranetId) ?? new Set();

  const newEntities = [];
  const updateEntities = [];

  for (const [rootEntity, quads] of manifest) {
    if (owned.has(rootEntity)) {
      if (!options.allowUpdate) {
        throw new Error(`Rule 4: entity already exists`);
      }
      updateEntities.push({ rootEntity, quads });
    } else {
      newEntities.push({ rootEntity, quads });
    }
  }

  // Publish new entities normally (new batch, new NFTs)
  if (newEntities.length > 0) {
    await this.publishNew(...);
  }

  // Update existing entities (same batch, replace triples)
  if (updateEntities.length > 0) {
    // Find batchId for each entity, group by batch, call update()
    await this.updateExisting(...);
  }
}
```

---

## Ownership Model Summary

```
                    ┌──────────────────────────────────────┐
                    │     Workspace (mutable, off-chain)    │
                    │                                      │
                    │  Creator-only upsert:                │
                    │  • New entity → anyone can create    │
                    │  • Update → only creator (by peerId) │
                    │  • Ownership tracked in-memory       │
                    │  • Rehydrated from workspace_meta    │
                    │  • No protocol changes needed        │
                    └────────────────┬─────────────────────┘
                                     │ enshrine
                                     ▼
                    ┌──────────────────────────────────────┐
                    │    Data Graph (attested, on-chain)    │
                    │                                      │
                    │  Owner-only update:                  │
                    │  • New entity → Rule 4 (exclusive)   │
                    │  • Update → batch publisher only     │
                    │  • Ownership = ERC1155 NFT holder    │
                    │  • Update requires on-chain tx       │
                    │  • Other nodes verify tx via gossip  │
                    └──────────────────────────────────────┘
```

---

## Implementation Order

### Phase 1: Workspace Creator-Only Upsert ✅ COMPLETE

| Step | Package | File(s) | Description | Status |
|------|---------|---------|-------------|--------|
| 1.1 | publisher | `validation.ts` | Add `ValidationOptions` with `allowUpsert` + `upsertableEntities` | ✅ |
| 1.2 | publisher | `dkg-publisher.ts` | Change `workspaceOwnedEntities` to `Map<string, Map<string, string>>`, implement upsert logic in `writeToWorkspace` | ✅ |
| 1.3 | publisher | `workspace-handler.ts` | Same type change, same upsert logic for gossip-received writes | ✅ |
| 1.4 | agent | `dkg-agent.ts` | Update shared map type, populate creator from `prov:wasAttributedTo` in sync | ✅ |
| 1.5 | publisher | `test/workspace.test.ts` | Workspace upsert: same creator overwrites; different creator blocked; handler gossip upsert | ✅ |
| 1.6 | publisher | `test/pure-functions.test.ts` | Rule 4 tests for `allowUpsert`: pass/fail/mixed-batch | ✅ |

### Phase 2: Data Graph Updates via Gossip ✅ COMPLETE

| Step | Package | File(s) | Description | Status |
|------|---------|---------|-------------|--------|
| 2.1 | core | `proto/ka-update.ts` | `KAUpdateRequest` message type + encode/decode | ✅ |
| 2.2 | core | `constants.ts` | `paranetUpdateTopic()` topic function | ✅ |
| 2.3 | chain | `chain-adapter.ts`, `mock-adapter.ts` | `verifyKAUpdate()` interface + mock impl | ✅ |
| 2.4 | publisher | `update-handler.ts` | Handle incoming update messages: verify tx, delete-then-insert | ✅ |
| 2.5 | publisher | `dkg-publisher.ts` | `update()` returns `onChainResult` with txHash/blockNumber | ✅ |
| 2.6 | agent | `dkg-agent.ts` | Subscribe to update topic; `agent.update()` broadcasts `KAUpdateRequest` after chain confirm | ✅ |
| 2.7 | publisher | `test/ka-update.test.ts` | Round-trip encoding, verified update, rejected attacker, multi-entity, local update | ✅ |

### Phase 3: Smart Publish (convenience, lower priority)

| Step | Package | File(s) | Description |
|------|---------|---------|-------------|
| 3.1 | publisher | `dkg-publisher.ts` | `publish({ allowUpdate: true })` auto-routes to update for owned entities |
| 3.2 | agent | `dkg-agent.ts` | Expose `agent.publish(..., { allowUpdate: true })` |
| 3.3 | — | tests | End-to-end: publish → update → verify on other node |

---

## Impact on Existing Apps

### OriginTrail Game (oregon-trail-dkg)
- **Phase 1** eliminates the `SwarmMembership` workaround entirely
- `playerJoinedQuads` can use `playerUri(peerId)` as the subject again
- `publishPlayerProfile` no longer needs the existence check
- Game state updates in workspace become natural upserts by the coordinator

### Chat Memory (packages/node-ui)
- `storeChatExchange` no longer needs `sessionExistsInWorkspace()` check
- Sessions can be freely updated without synthetic URIs

### Future Agent Apps
- Any agent coordination app benefits from mutable workspace
- Each agent writes to its own entities, reads everyone's
- Shared state changes go through coordination (gossip + votes)

---

## Testing Strategy

1. **Unit tests** (publisher package):
   - Same-creator upsert: write entity, write again, verify triples replaced
   - Different-creator rejection: A writes entity, B tries to update → rejected
   - Data-graph exclusivity: entity published to data graph → workspace write blocked
   - Ownership rehydration: restart, rebuild map from metadata, verify ownership preserved
   - Gossip upsert: receive workspace write for entity owned by sender → apply

2. **Integration tests** (agent package):
   - Two-node workspace upsert via gossip
   - Two-node data graph update propagation
   - Mixed flow: workspace upsert → enshrine → attempt workspace re-write (blocked)

3. **Game e2e tests** (oregon-trail-dkg):
   - Player joins, leaves, joins again — no Rule 4 errors
   - Player A cannot overwrite Player B's status
   - Turn results enshrined correctly
