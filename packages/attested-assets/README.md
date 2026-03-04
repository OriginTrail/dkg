# @dkg/attested-assets

> **Experimental** — This package implements the Attested Knowledge Assets (AKA) protocol, which is under active development. APIs may change.

Session-scoped, multi-party consensus protocol for DKG V9. Enables bounded groups of nodes to run deterministic state machines with cryptographic attestation and quorum-based finality.

## What are Attested Knowledge Assets?

Standard Knowledge Assets are published to open paranets — any node can write. Attested Knowledge Assets add a **session** layer on top: a fixed set of members, a deterministic reducer (state machine), and a quorum policy. State transitions only finalize when enough members independently validate and sign off.

Use cases: multiplayer games, collaborative agent workflows, multi-party computations, supply chain checkpoints.

See the full protocol spec at [`docs/SPEC_ATTESTED_KNOWLEDGE_ASSETS.md`](../../docs/SPEC_ATTESTED_KNOWLEDGE_ASSETS.md).

## Features

- **SessionManager** — orchestrates the full session lifecycle: creation, membership acceptance, activation, round progression, timeout/view-change, and abort
- **Deterministic reducers** — `ReducerRegistry` for registering application-specific state machines that produce identical output for identical input
- **Canonical encoding** — RFC 8785 JSON Canonicalization Scheme for deterministic hashing and Ed25519 signing with domain separation (`AKA-v1`)
- **Quorum engine** — configurable quorum policies (fraction-based, e.g., 2/3 majority) with `isQuorumMet` checks
- **Session validator** — enforces membership, state linkage, replay protection, timing, proposer authority, signature verification, and equivocation detection
- **GossipSub integration** — `AKAGossipHandler` for broadcasting and receiving AKA events over paranet and session-specific topics
- **Protobuf serialization** — efficient encode/decode for all AKA event types
- **REST API routes** — `createSessionRoutes()` exposes session management and round operations via HTTP

## Session Lifecycle

```
PROPOSED → ACCEPTED → ACTIVE → rounds... → COMPLETED
                                    ↘ ABORTED (on failure/timeout)
```

Each round follows: **start → collect inputs → propose → validate & ACK → quorum check → finalize**.

## Usage

```typescript
import { SessionManager, ReducerRegistry } from '@dkg/attested-assets';

// Register a reducer for your application
ReducerRegistry.register({
  name: 'my-game',
  version: '1.0.0',
  hash: computedHash,
  reduce(state, inputs) {
    // Deterministic state transition logic
    return { ...state, turn: state.turn + 1 };
  },
});

// Create a session
const session = await sessionManager.createSession({
  paranetId: 'urn:paranet:my-app',
  members: [{ peerId: 'peer-1', role: 'validator' }, ...],
  quorum: { numerator: 2, denominator: 3 },
  reducer: { name: 'my-game', version: '1.0.0', hash: '...' },
});
```

## Internal Dependencies

- `@dkg/core` — P2P node, GossipSub, event bus, crypto primitives
- `@dkg/storage` — session state persistence
