# @dkg/publisher

Publishing protocol for DKG V9. Handles the complete lifecycle of getting Knowledge Assets from a node into the network — from RDF processing through Merkle tree construction to on-chain finalization.

## Features

- **DKGPublisher** — high-level publishing API: submit RDF, get back a finalized Knowledge Collection UAL
- **PublishHandler** — P2P protocol handler that processes incoming publish requests from other nodes, validates data, stores triples, and returns signed ACKs
- **WorkspaceHandler** — feeless "workspace mode" publishing for local-only or staging workflows
- **Merkle trees** — per-KA triple hashing, public/private sub-roots, and collection-level Merkle root computation
- **Skolemization** — blank node to skolemized URI conversion for deterministic RDF processing
- **Auto-partitioning** — splits a batch of RDF triples into individual Knowledge Assets by root entity
- **KC metadata** — generates on-chain metadata (merkle root, byte sizes, entity count) for Knowledge Collection creation
- **ChainEventPoller** — monitors on-chain events for KC finalization confirmations
- **Access control** — `AccessHandler` for serving private triple access requests; `AccessClient` for requesting them

## Usage

```typescript
import { DKGPublisher } from '@dkg/publisher';

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

- `@dkg/core` — P2P networking, protocol streams, crypto
- `@dkg/chain` — on-chain KC creation and finalization
- `@dkg/query` — entity resolution during publishing
- `@dkg/storage` — triple persistence
