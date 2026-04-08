# @origintrail-official/dkg-publisher

Publishing protocol for DKG V9. Handles the complete lifecycle of getting Knowledge Assets from a node into the network — from RDF processing through Merkle tree construction to on-chain finalization.

## Features

- **DKGPublisher** — high-level publishing API: submit RDF, get back a finalized Knowledge Collection UAL
- **PublishHandler** — P2P protocol handler that processes incoming publish requests from other nodes, validates data, stores triples, and returns signed ACKs
- **SharedMemoryHandler** — feeless shared-memory publishing for local-only or staging workflows (`WorkspaceHandler` remains as a compatibility alias)
- **Context Graphs** — `createContextGraph` and `publishToContextGraph` for M/N signature-gated subgraphs within paranets
- **Context Oracle** — `ContextOracle` class providing verifiable read operations on Context Graphs: `queryWithProofs` (SPARQL with Merkle inclusion proofs), `entityWithProofs` (entity lookup with proofs), and `proveTriple` (single triple existence proof). Provenance triples are scoped to subjects discovered in the query results for efficiency.
- **Merkle trees** — per-KA triple hashing, public/private sub-roots, and collection-level Merkle root computation
- **Skolemization** — blank node to skolemized URI conversion for deterministic RDF processing
- **Auto-partitioning** — splits a batch of RDF triples into individual Knowledge Assets by root entity
- **KC metadata** — generates on-chain metadata (merkle root, byte sizes, entity count) for Knowledge Collection creation
- **ChainEventPoller** — monitors on-chain events for KC finalization confirmations
- **Access control** — `AccessHandler` for serving private triple access requests; `AccessClient` for requesting them

## Usage

```typescript
import { DKGPublisher } from '@origintrail-official/dkg-publisher';

const publisher = new DKGPublisher(config);

// Publish a Knowledge Collection
const result = await publisher.publish({
  paranetId: 'urn:paranet:example',
  quads: myTriples,
  privateQuads: sensitiveTriples,
  accessPolicy: 'ownerOnly',
});
console.log('Published KC:', result.ual);

// Write to shared memory (feeless staging)
await publisher.writeToSharedMemory('urn:paranet:example', quads, {
  publisherPeerId: agent.peerId,
});

// Conditional write with Compare-and-Swap
await publisher.writeConditionalToSharedMemory('urn:paranet:example', quads, {
  publisherPeerId: agent.peerId,
  conditions: [
    { subject: 'urn:entity:1', predicate: 'urn:status', expectedValue: '"pending"' },
  ],
});
```

## Internal Dependencies

- `@origintrail-official/dkg-core` — P2P networking, protocol streams, crypto
- `@origintrail-official/dkg-chain` — on-chain KC creation and finalization
- `@origintrail-official/dkg-query` — entity resolution during publishing
- `@origintrail-official/dkg-storage` — triple persistence

## Async lift publisher control-plane

The async lift publisher persists queue/recovery state in TripleStore control-plane
graphs. This state is internal to the publisher implementation.

| Graph | URI | Contents |
|---|---|---|
| Jobs | `urn:dkg:publisher:control-plane` | `LiftJob`, `LiftRequest`, state-machine progress, retries, timeouts, failures, recovery metadata |
| Wallet locks | `urn:dkg:publisher:wallet-locks` | active wallet lease records used during claim and recovery |

Key points:

- `LiftJob` uses an explicit state machine: `accepted -> claimed -> validated -> broadcast -> included -> finalized`, with failure transitions to `failed`.
- `LiftRequest` is stored separately from `LiftJob` and linked from the job record.
- Async lift uses shared-memory terminology first: `memoryOperationId` / `memoryId`, while preserving legacy `workspaceOperationId` / `workspaceId` aliases for compatibility.
- Resolution is keyed by `memoryOperationId` (or legacy `workspaceOperationId`). `memoryId` / `workspaceId` is optional alias data and is not the resolver key.
- If both legacy and current alias fields are provided, they must match; conflicting `workspace*` and `memory*` values are rejected.
- `jobId` is opaque. `jobSlug` is readable and derived from `paranet/scope/transition/memoryOperationId/root-range`.
- Async `CREATE` lift subtracts exact quads that are already confirmed authoritative data in the canonical paranet meta graph path. If nothing remains after subtraction, the job finalizes as a no-op and no new chain publish is submitted.
- Unknown failures from the `included` phase are currently persisted as terminal `failed` jobs instead of being rethrown.
- Wallet locks are operational leases, not shared-memory state. They are acquired on claim, renewed while jobs stay active, deleted on terminal/reset paths, and swept during recovery if expired or orphaned.
- Control-plane data is distinct from shared-memory graphs and distinct from published graph state.

Current caveats:

- Blank-string alias inputs still have a known normalization edge case during request normalization. Treat empty-string alias values as unsupported for now.
- Confirmed publish metadata is expected to land in the canonical graph-manager meta graph path for the target paranet.

See `../../docs/diagrams/publish-flow.md#liftjob-sequence` for the state diagram,
control-plane layout, and recovery notes.

### Running the async publisher

The async publisher worker can be run in two ways.

1. Standalone worker command

```bash
dkg publisher wallet add <privateKey>
dkg publisher start
```

2. Integrated into the normal daemon startup

```bash
dkg publisher wallet add <privateKey>
dkg publisher enable --poll-interval 1000 --error-backoff 1000
dkg start
```

Useful wallet commands:

```bash
dkg publisher wallet list
dkg publisher wallet remove <address>
dkg publisher disable
```

Operational notes:

- Publisher wallets are stored in `publisher-wallets.json` under `DKG_HOME`.
- `dkg publisher start` runs the worker directly.
- `dkg start` also launches the async publisher when `config.publisher.enabled` is set.
- The worker always runs `recover()` before processing new jobs.
