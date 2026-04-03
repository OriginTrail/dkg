# @origintrail-official/dkg-core

Foundation package for DKG V9. Provides P2P networking, protocol messaging, cryptographic primitives, and shared utilities used by every other package in the stack.

## Features

- **libp2p node** — full P2P networking: TCP + WebSocket transports, Noise encryption, Yamux multiplexing, AutoNAT, circuit relay, DCUtR hole-punching
- **GossipSub** — pub/sub message broadcast across the network, with per-topic subscription management
- **Protocol router** — request/response protocol streams over libp2p with handler registration
- **Peer discovery** — mDNS for local networks, Kademlia DHT + bootstrap peers for global discovery
- **Ed25519 crypto** — peer identity generation, signing, and verification
- **Protobuf messages** — efficient serialization for all DKG protocol messages
- **Event bus** — centralized internal event system (`DKGEvent`) for decoupled component communication
- **Logger** — structured logging with operation context tracking
- **Genesis ontology** — built-in DKG ontology quads and system paranet definitions
- **Constants** — network IDs, protocol paths, topic naming conventions

## Usage

```typescript
import { DKGNode, TypedEventBus, DKGEvent, Logger } from '@origintrail-official/dkg-core';

const eventBus = new TypedEventBus();
const node = new DKGNode(config);
await node.start();

eventBus.on(DKGEvent.PEER_CONNECTED, (peer) => {
  console.log('Peer connected:', peer);
});
```

## Internal Dependencies

None — this is the base package. All other `@origintrail-official/dkg-*` packages depend on it.
