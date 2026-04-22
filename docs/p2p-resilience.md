# P2P Resilience for NAT'd edge nodes

Status: partial — this PR lands three hooks, the remaining items are tracked
as TODOs near the end.

## Context

Two common DKG deployments sit behind home/office NAT:

- Developer laptops running `dkg start` on a residential connection.
- Hobby/demo nodes on cloud providers where the container is reachable from
  the public internet but the *application* doesn't know its public IP.

These nodes depend on the testnet **circuit relay** peers to be dialable by
anyone else. The relay path is fragile by construction:

1. A reservation must be held on the relay (5-minute TTL in our config,
   `defaultDurationLimit: 5 * 60 * 1000` in `packages/core/src/node.ts`).
2. The TCP connection to the relay must stay alive.
3. Both sides must have a relay in common with live reservations, or one
   side must be directly dialable.

In practice we were seeing one or more of the following failure modes:

- Relay reservations silently expiring even while the underlying TCP
  connection to the relay stayed healthy (so existing watchdog said "all
  good"). This made the node unreachable from the outside without anyone
  noticing.
- A direct peer connection between two edge nodes surviving just long
  enough for the initial sync to fail, then dropping before any retry.
- An edge node coming online and only syncing on its first successful
  `peer:connect`; if that attempt failed over a lossy relay, no further
  attempt was made until the daemon was restarted.

## What this PR adds

### 1. Relay reservation renewal (primary fix)

`packages/core/src/node.ts` — the `watchdogTick` now detects **lapsed
reservations** in addition to **dropped TCP connections**.

On each tick, the watchdog snapshots `libp2p.getMultiaddrs()` and treats
the full set of circuit-relay reservations as a **pool**, not as
per-relay slots. This matches how js-libp2p's circuit-relay-v2 transport
behaves by default: it holds a single reservation at a time, rotating
among the configured relays as needed. A per-relay "reservation missing"
check would spuriously drop+redial idle relays forever; a pool-level
check targets the condition that actually kills reachability.

For every configured relay peer:

- **Happy path.** TCP connection up AND (this relay holds our
  reservation OR *any* relay does) → nothing to do.
- **Reservation pool empty.** TCP connection up but the set of
  `/p2p-circuit` self-addresses is empty → we are unreachable. The
  watchdog closes the existing connection and redials the relay; the
  circuit-relay transport re-listens on `/p2p-circuit`, which
  re-requests a fresh reservation. A per-relay grace window
  (`RELAY_RESERVATION_GRACE_MS`, 15 s) suppresses false-positive re-fires
  while a freshly-negotiated reservation is still on the wire.
- **Transport down.** No TCP connection → classic redial path
  (pre-existing behaviour, unchanged).

**Why this is the primary fix.** If our reservation on relay R has lapsed,
no peer anywhere on the network can reach us via R until we re-reserve.
No amount of application-level reconnection logic fixes this — the
circuit simply won't open. Every other hook in this document is a
complement that helps *after* the underlying reachability has been
restored.

### 2. Reconnect-on-gossip

`packages/agent/src/dkg-agent.ts` — `maybeDialGossipSender()`.

When any gossipsub message is delivered to us, the sender peer is both a
proof-of-life signal *and* a useful dial target:

- GossipSub messages are signed by the original publisher, so `from` is
  the author regardless of how many mesh hops the message took.
- If we're not currently connected to that peer, we best-effort dial
  them: first via peerStore (which may already know their multiaddrs
  from a previous direct exchange), then by constructing explicit
  `/p2p-circuit` multiaddrs through each configured relay.
- A 30-second per-peer cooldown (`GOSSIP_DIAL_COOLDOWN_MS`) prevents
  dial storms from chatty topics.

This catches the case where two edge nodes briefly lose their direct
circuit without either noticing, but gossipsub still routes their messages
to each other via the mesh. The arriving message becomes the trigger to
rebuild the direct link so subsequent sync requests have a path.

### 3. Catchup-on-connection:open

`packages/agent/src/dkg-agent.ts` — the agent now listens on
`connection:open` in addition to `peer:connect`.

`peer:connect` fires once, the first time libp2p sees a peer. If that
peer temporarily disconnects and later reconnects, `peer:connect` does
**not** fire again. Without this second listener, a first-contact sync
that failed over a flaky relay would never be retried.

A 60-second per-peer cooldown (`CATCHUP_ON_CONNECT_COOLDOWN_MS`) dedupes
overlapping direct + relayed connections for the same peer (each of
which fires its own `connection:open`).

## Remaining work

These are the follow-ups that didn't fit into this PR.

### DCUtR upgrade verification

`dcutr()` is enabled in the libp2p service stack, which should attempt to
upgrade relayed connections to direct NAT-holepunched ones. We do track
upgrades via `setupConnectionObservability` but we don't *verify* they
actually happen in the wild for our test peers. Need:

- A metric/log line per day counting how many relayed connections
  successfully upgrade to direct vs. stay relayed.
- An alert when that ratio trends to zero (indicates DCUtR is failing
  silently — e.g., because a firewall blocks the holepunch packets).

### Multi-relay fanout for reservations

Currently each node tries to hold a reservation on every configured
relay in `network.relays`. That's fine for a 4-relay testnet but doesn't
scale to a larger relay set. We should:

- Hold reservations on *N* diverse relays (e.g., 2–3), picked by network
  latency / geographic diversity rather than config order.
- Rotate which relays we hold reservations on if a subset becomes
  unhealthy.

### Rendezvous / peer exchange discovery

Today, discovering a peer for the first time requires either:

- They were in our `bootstrapPeers` (unlikely for edge peers), or
- We learned their addresses from on-chain agent profile publication
  (which only works if they've published a profile and we've synced
  the agents CG).

For ephemeral CGs like local tic-tac-toe games the second path is
overkill. A libp2p rendezvous service on the relays would let peers
announce "I'm in context graph X" and let other members discover them
directly. Worth prototyping once v2 of the demo flow is stable.

### Persistent per-peer routing hints

When `maybeDialGossipSender` successfully dials a peer via a specific
relay, we should persist that relay choice in peerStore. Right now each
gossip event re-runs the relay fanout from scratch. A simple `tag.value`
update per successful dial would let libp2p prefer known-good relays on
subsequent dials.

### Public dial-back / reachability signalling

An edge node can currently only be reached *through* a relay. Even when
AutoNAT knows the node is reachable (e.g., a cloud VM with a mapped
port), the node still treats itself as unreachable and hides behind the
relay. We should emit an `announce`-multiaddr when AutoNAT confirms a
direct address works, so other nodes can skip the relay entirely.

### Smoke test for reservation renewal

The reservation-renewal watchdog doesn't have a unit test because
simulating a lapsed reservation cleanly requires a real circuit-relay
server we can instruct to expire a reservation. An e2e smoke test using
two `DKGNode` instances + one relay instance would close this gap.

## Config knobs

All timing constants are in the source files above. Defaults:

| Knob                                | Default | Where                         |
|-------------------------------------|---------|-------------------------------|
| `RELAY_WATCHDOG_BASE_INTERVAL_MS`   | 10 s    | `packages/core/src/node.ts`   |
| `RELAY_WATCHDOG_MAX_INTERVAL_MS`    | 5 min   | `packages/core/src/node.ts`   |
| `RELAY_RESERVATION_GRACE_MS`        | 15 s    | `packages/core/src/node.ts`   |
| `GOSSIP_DIAL_COOLDOWN_MS`           | 30 s    | `packages/agent/src/dkg-agent.ts` |
| `GOSSIP_DIAL_TIMEOUT_MS`            | 10 s    | `packages/agent/src/dkg-agent.ts` |
| `CATCHUP_ON_CONNECT_COOLDOWN_MS`    | 60 s    | `packages/agent/src/dkg-agent.ts` |

## Testing

Unit tests for the two application-level hooks live in
`packages/agent/test/p2p-resilience.test.ts`:

- Reconnect-on-gossip dials on first message from an unconnected peer
- Reconnect-on-gossip skips peers already connected
- Reconnect-on-gossip ignores messages from our own peer id
- Reconnect-on-gossip throttles repeat attempts within the cooldown
- Catchup-on-connection:open fires `trySyncFromPeer` on each new conn
- Catchup-on-connection:open dedupes within cooldown
- Catchup-on-connection:open ignores our own peer id

The relay reservation renewal path is verified end-to-end only (two
laptops behind NAT, testnet relays) — see the "Smoke test for
reservation renewal" remaining-work item.
