# @origintrail-official/dkg-publisher

Publishing protocol for DKG V9. Handles the complete lifecycle of getting Knowledge Assets from a node into the network — from RDF processing through Merkle tree construction to on-chain finalization.

## Features

- **DKGPublisher** — high-level publishing API: submit RDF, get back a finalized Knowledge Collection UAL
- **PublishHandler** — P2P protocol handler that processes incoming publish requests from other nodes, validates data, stores triples, and returns signed ACKs
- **WorkspaceHandler** — feeless "workspace mode" publishing for local-only or staging workflows
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

const publisher = new DKGPublisher(agent);

const result = await publisher.publish({
  paranetId: 'urn:paranet:example',
  nquads: myTriples,
  private: ['urn:entity:secret'],
  epochs: 2,
});

console.log('Published KC:', result.ual);
```

## Internal Dependencies

- `@origintrail-official/dkg-core` — P2P networking, protocol streams, crypto
- `@origintrail-official/dkg-chain` — on-chain KC creation and finalization
- `@origintrail-official/dkg-query` — entity resolution during publishing
- `@origintrail-official/dkg-storage` — triple persistence
