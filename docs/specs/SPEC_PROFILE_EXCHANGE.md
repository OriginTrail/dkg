# Profile Exchange on Connect

**Status**: Draft
**Depends on**: [sync-flow.md](../diagrams/sync-flow.md), [SPEC_PART1_MARKETPLACE.md](../SPEC_PART1_MARKETPLACE.md)

---

## Problem

Full contextGraph sync (`/dkg/sync/1.0.0`) downloads all triples for the
agents contextGraph, which is comprehensive but potentially expensive for
large networks. In many cases, a connecting peer only needs to know about
the **immediate neighbor** it just connected to — for example, to send it
a message or invoke a skill.

## Approach

A lightweight pairwise protocol where two peers swap their own agent
profiles on connect. This is a complement to (not a replacement for)
full contextGraph sync.

### Protocol

```
Protocol:   /dkg/profile-exchange/1.0.0
Transport:  libp2p stream (bidirectional)

Message (UTF-8):
  N-Quads containing the sender's own agent profile triples.
  Same format as what publishProfile() stores in the agents contextGraph.
```

### Flow

1. Peer A connects to Peer B
2. Both peers open a `/dkg/profile-exchange/1.0.0` stream to each other
3. Each sends its own profile triples (N-Quads)
4. Each receives the other's profile and inserts into its local store

### Verification

Profile triples are a single KC with a merkle root. The receiver:
1. Recomputes the merkle root from the received triples
2. Compares to the claimed `dkg:merkleRoot` in the profile's metadata
3. Optionally (Tier 2): checks the chain for the on-chain record

### When to use

| Scenario | Use profile exchange? | Use full sync? |
|----------|----------------------|----------------|
| Two agents connecting directly | Yes | Optional |
| New node joining network | Yes (fast) | Yes (complete) |
| Relay node connecting | No (relays don't have profiles) | No |

### Advantages over full sync

- **Fast**: Only exchanges 1 profile, not the entire contextGraph
- **Symmetric**: Both peers learn about each other simultaneously
- **Lightweight**: No pagination needed; a single profile is small

### Limitations

- Only discovers the immediate peer, not the full network
- Doesn't help with "last to the party" for peers you never directly
  connect to (those come via full sync or GossipSub)

## Relationship to existing protocols

- **GossipSub**: Broadcasts profiles to all subscribers. Fire-and-forget.
  Misses latecomers.
- **Full sync** (`/dkg/sync/1.0.0`): Downloads entire contextGraph. Catches
  up latecomers. Expensive for large contextGraphs.
- **Profile exchange** (`/dkg/profile-exchange/1.0.0`): Pairwise swap
  of own profiles. Fast, lightweight, symmetric. Complement to both.
