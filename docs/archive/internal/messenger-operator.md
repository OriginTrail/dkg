# Universal Messenger — Operator Guide

> Audience: node operators (running a DKG daemon as a service). For
> the architecture-level reference, see [`messenger.md`](./messenger.md).
> For the new-protocol migration recipe, see
> [`messenger-add-protocol.md`](./messenger-add-protocol.md).
>
> Status: shipping in `v10.0.0-rc.9`.

This is the operator-facing manual for running a DKG node on top of
the Universal Messenger substrate. The two surfaces you'll touch in
practice are:

1. **`--relay-preferred`** _(PR-7)_ — when you stand up your own relay
   infrastructure, point your node at it first.
2. **`/api/slo`** _(PR-12)_ — per-protocol latency + delivery-rate
   histograms exposed on localhost; the source-of-truth for "is
   messaging healthy on this node?".

Most operators won't need either — defaults are safe, the public
testnet relay set works, and the substrate self-heals through the
recovery primitives documented in `messenger.md`. The surfaces below
exist for operators running custom infrastructure or chasing a
specific reliability tail.

## `--relay-preferred` — using operator-controlled relays

By default, every daemon reserves on the public testnet relay set
(declared in `network/<env>.json#relays`). The public relays work
well, but operators running their own infrastructure may want to
prioritise relays they control — for capacity, geography, or
operational independence.

### CLI flag

```bash
dkg start \
  --relay-preferred /ip4/203.0.113.10/tcp/4001/p2p/12D3KooWMyRelayOne... \
  --relay-preferred /dns4/relay.example.com/tcp/4001/p2p/12D3KooWMyRelayTwo...
```

Repeatable. Each `--relay-preferred` adds one multiaddr; the order
you pass them is the order libp2p attempts reservations. The public
testnet relays remain configured as fallback — if your operator-relay
disappears, the node keeps working through the public set.

### Persistent config

For a node you run continuously, write the same list into
`~/.dkg/config.json`:

```jsonc
{
  "name": "...",
  "preferredRelays": [
    "/ip4/203.0.113.10/tcp/4001/p2p/12D3KooWMyRelayOne...",
    "/dns4/relay.example.com/tcp/4001/p2p/12D3KooWMyRelayTwo..."
  ],
  // ... other config
}
```

CLI-flag entries take precedence over config entries; both are
deduped (first-seen order) before being prepended to the network
relay list.

### Verifying

After restart, the daemon logs:

```
Preferred relays (rc.9 PR-7): 2 operator-supplied multiaddr(s) prepended (sources: 2 from --relay-preferred, 0 from config.preferredRelays). Effective relayPeers count: 5.
```

You can also confirm via `/api/peer-info` (rc.8 PR #533) which
reservations the libp2p stack is currently holding.

### Relay-setup playbook (standing up your own relay)

You'll get the most reliability lift from running 2-3 relays in
geographically distinct regions. Each relay is a vanilla DKG node
configured as a circuit-relay-v2 server. The full step-by-step lives
in [`packages/cli/README.md`](../packages/cli/README.md#operator-relays-rc9-pr-7) — that's the
authoritative playbook with infra recommendations, port-forwarding
rules, and monitoring.

In summary:

1. **Provision a small cloud VM** (1 vCPU, 1 GiB RAM, 20 GiB disk is
   plenty for relay-only). Public IP + ports 4001/tcp open.
2. **Install + init DKG** as you would for any other node.
3. **Set `nodeRole: "core"`** in `config.json` so libp2p flips into
   relay-server mode (HOP streams + reservations).
4. **Capture the relay's multiaddr** from the startup log:
   `/ip4/<public-ip>/tcp/4001/p2p/<peer-id>` — this is what you
   share with your other nodes' `--relay-preferred`.
5. **Wire it up** on every node that should prefer your relay:

   ```bash
   dkg start --relay-preferred /ip4/<public-ip>/tcp/4001/p2p/<peer-id>
   ```

6. **Monitor** — the relay exposes the same `/api/peer-info`
   diagnostic, so a simple HTTP probe + a "reservations > 0" alert
   tells you if it's healthy.

## `/api/slo` — per-protocol SLO histogram

Localhost-only by default (binds to `127.0.0.1` like every other
`/api/*` route; same `Authorization: Bearer` requirement). One-shot
snapshot of the in-memory histogram — no cumulative on-disk store.
Returns the latest 1000 samples per protocol
(`DEFAULT_SLO_WINDOW_SAMPLES`).

```bash
curl -s http://127.0.0.1:9200/api/slo \
  -H "Authorization: Bearer $(grep -v '^#' ~/.dkg/auth.token | head -1)" \
  | jq .
```

```jsonc
{
  "protocols": {
    "/dkg/10.0.1/message": {
      "samples": 847,        // current window size (≤ DEFAULT_SLO_WINDOW_SAMPLES)
      "p50Ms": 42,           // nearest-rank percentile over samples
      "p95Ms": 380,
      "p99Ms": 1240,
      "delivered": 1602,     // monotonic counter (since daemon start)
      "queued": 14           // monotonic; "queued" = first send failed → outbox
    },
    "/dkg/10.0.1/storage-ack": { ... }
  },
  // rc.9 PR-A (SWM reliable fan-out, Step 0): two new sections,
  // additive — soak tooling and operators that only parse `protocols`
  // still work byte-identically.
  "gossip": {
    "publishFailures": {     // per-cgId count of `gossip.publish` errors
      "did:dkg:context-graph:lex/playground": 3
    },
    // Counts evicted into here once the per-cgId tracking map crosses
    // its hard cap (1024 distinct cgIds). Always 0 in normal
    // deployments; non-zero only when failing publishes against
    // thousands of distinct cgIds.
    "publishFailuresOverflow": 0,
    // Sticky boolean — true once the eviction path has fired. Means
    // the per-cgId breakdown is partial; the grand total
    // (sum(publishFailures) + publishFailuresOverflow) is still
    // accurate.
    "publishFailuresTruncated": false
  },
  "swm": {
    "redundantApplies": {    // per-cgId redundant-apply count (RFC-003)
      "did:dkg:context-graph:lex/playground": 5
    },
    // Sticky boolean — true once the receiver-side seenShareOps cap
    // eviction had to trim a still-live (non-TTL-expired) entry. When
    // true, `redundantApplies` is a lower bound for the operating
    // window. Operators can raise `seenOpsMaxSize` (default 50_000)
    // on the `SharedMemoryHandler` constructor for higher-throughput
    // nodes.
    "redundantAppliesLowerBound": false,
    // Sum of per-cgId counters evicted into overflow once the per-cgId
    // tracking map crosses its hard cap (default 1024 distinct cgIds).
    // Non-zero only when a peer has been forcing duplicate applies
    // against thousands of distinct cgIds.
    "redundantAppliesOverflow": 0,
    // Sticky boolean — true once the per-cgId cap eviction has fired.
    // Means the `redundantApplies` breakdown is partial; the grand
    // total is still `sum(redundantApplies) + redundantAppliesOverflow`.
    "redundantAppliesTruncated": false
  }
}
```

Empty body with all-zero counters means no substrate traffic has
flowed and no SWM share has either failed at gossip or been applied
— typically a freshly restarted idle daemon.

### `gossip` / `swm` reading guide

- **`gossip.publishFailures[cgId] > 0`** → the local node committed a
  share for `cgId` but `gossip.publish` threw. The share is NOT lost:
  the local commit succeeded and `runSyncOnConnect` will catch
  remote peers up on the next reconnect. A non-zero counter that
  keeps growing without delivery progress is the signal to
  investigate (mesh failure, no peers subscribed, etc.). The
  per-failure WARN in `daemon.log` carries both `errorClass=` and
  `error=` so distinct failure types stay greppable.
- **`gossip.publishFailuresTruncated = true`** → operations against
  >1024 distinct cgIds have failed since daemon start. The
  `publishFailures` map drops the smallest counters into
  `publishFailuresOverflow` to keep memory + response size bounded;
  the grand total is still accurate.
- **`swm.redundantApplies[cgId] > 0`** → a (cgId, shareOpId) was
  re-delivered within the TTL window and applied a second time.
  Pure measurement: behaviour is unchanged. Used to inform the rc10
  dedup decision (RFC-003 Concern-2).
- **`swm.redundantAppliesLowerBound = true`** → the receiver-side
  `seenShareOps` cap eviction had to trim a still-live entry to
  stay bounded. `redundantApplies` is now a lower bound for the
  operating window. Tune the `SharedMemoryHandler` constructor's
  `seenOpsMaxSize` upward for higher-throughput nodes.
- **`swm.redundantAppliesTruncated = true`** → duplicate applies have
  arrived against more than `redundantAppliesMaxCgs` (default 1024)
  distinct cgIds, so the per-cgId breakdown is partial. The grand
  total is still accurate via
  `sum(redundantApplies) + redundantAppliesOverflow`. If `Truncated`
  flips in normal operation (no hostile peer), raise the cap.

### Clock definition

The per-message latency clock starts the **first time**
`Messenger.sendReliable(peerId, protocol, payload)` is invoked for a
given `(peer, protocol, messageId)` triple, and stops when **any**
attempt (initial send or any background outbox retry) resolves to
`{ delivered: true }`. Concretely:

- Initial wire I/O time is included.
- Time spent waiting in the outbox between failed attempts is included.
- Re-issues with a fresh `messageId` (e.g. `RESPONSE_GONE` retry on
  `/query-remote`) are **separate** SLO samples; each `messageId` is
  its own user-visible operation.
- Receiver-side dedup hits are recorded as delivered with zero
  latency (the caller's effective "perceived" RTT).

This is the operator-visible "I clicked send → it arrived" time, which
is what the ship-gate SLO targets measure.

### SLO targets

| Protocol family                                                                  | SLO         |
| -------------------------------------------------------------------------------- | ----------- |
| chat / skill_request / query-remote                                              | ≥ 99%/15s   |
| swm-sender-key / private-access / join-request / storage-ack / verify-proposal   | ≥ 99.5%/15s |

The ship-gate runs the soak script
(`scripts/libp2p-soak-test.sh`) across both Lex and Miles for an
overnight run; `/api/slo` is the source of truth for go/no-go on the
`v10.0.0-rc.9` tag.

### Reading guide

- **Did we hit SLO?** For each protocol you care about, check
  `p99Ms` against the 15000 ms budget. If `p99Ms <= 15000`, that
  protocol is meeting the latency target for the last `samples`
  operations.
- **Delivery rate.** `delivered / (delivered + queued)` is the
  approximate single-attempt success rate. The substrate guarantees
  at-least-once delivery, so `queued` entries are eventually
  delivered too — they just took at least one retry. A high `queued`
  count with matching `delivered` growth means the substrate is
  doing its job; high `queued` with stalled `delivered` is the
  warning sign (the peer is unreachable for an extended period).
- **No `samples`, only `queued`?** The protocol has only ever seen
  failed first attempts — typically a brand-new peer where address
  resolution hasn't settled. Watch for `delivered` to start climbing
  as the outbox retries land; PR-5's DHT-walk-on-stall should kick
  in after 5 failed attempts (see `messenger.md` § Recovery
  primitives).
- **Soak runs.** `scripts/libp2p-soak-test.sh` writes a per-cycle
  snapshot of `/api/slo` to `~/.dkg/soak-test-*/slo.jsonl` alongside
  the existing `preflight.jsonl`, `sends.jsonl`, `inbox.jsonl`. The
  human-readable summary line in `main.log` reads e.g.
  `slo: message=d12/q0 p99=145ms, query-remote=d3/q0 p99=890ms, ...`.

### Caveats

- The histogram is **in-memory only**. Daemon restart resets all
  counters and samples. The SQLite outbox itself survives restart;
  the SLO view does not.
- Samples are recorded only for protocols routed through the
  substrate. Anything still on `/dkg/10.0.0/*` (none at rc.9 ship;
  the surface remains for future incremental migrations) is
  invisible to `/api/slo`.

## Debugging a stuck outbox entry

```bash
sqlite3 ~/.dkg/dashboard.db <<'SQL'
SELECT peer_id, protocol, message_id, attempts, last_error,
       datetime(last_attempt_at/1000, 'unixepoch') AS last_attempt,
       datetime(next_attempt_at/1000, 'unixepoch') AS next_attempt
FROM protocol_outbox
ORDER BY last_attempt_at DESC
LIMIT 20;
SQL
```

Or via the dashboard UI (`/ui/chat`) for chat-specific entries.

If you see entries with `attempts >= 5` and `last_error LIKE '%no
valid addresses%'`, the daemon is already retrying via the DHT-walk
recovery primitive (PR-5) and the entry will heal as soon as the
peer's reservations get re-discovered. If `attempts` keeps climbing
past 10 with the same error, the peer may be genuinely unreachable —
check your own internet connectivity (the rc.8 soak data showed "no
valid addresses" tails are often correlated with sender-side network
blips, not receiver-side outages).

### Forcing a flush

The substrate flushes opportunistically on `connection:open` events;
there's no operator command to force one. If a peer just came back
online and you want to verify the flush ran, watch the daemon log for
`Messenger.processOutboxOnConnect(<peerId>)` lines.

### Pruning the outbox

The outbox auto-prunes entries older than 24h via `DashboardDB.prune()`.
If you have a backlog larger than that and want to clear it manually
(e.g. after a multi-day outage), it's safe to `DELETE FROM
protocol_outbox WHERE last_attempt_at < <cutoff_ms>` — the substrate
will not retry deleted entries, and the receiver-side idempotency
table still absorbs duplicates if the same `messageId` ever shows up
on a re-issue path.

## Upgrade from rc.8 to rc.9

Wire-format break: all 8 short-message protocols moved from
`/dkg/10.0.0/*` to `/dkg/10.0.1/*`. Both daemons in a pair must be on
rc.9 for chat / skill / query / etc. to work between them. Mixed-pair
deploys (one node rc.8, one node rc.9) will fail negotiation on the
substrate-bumped protocols and surface as `delivered: false, queued:
true` outbox entries that drain once both sides upgrade.

Upgrade order recommendation:

1. Drain the rc.8 chat outbox on each node (let the daemon idle for
   one tick cycle — typically 30s).
2. Stop the rc.8 daemon.
3. Pull rc.9, start the rc.9 daemon. The V12 + V13 SQLite migrations
   run automatically.
4. Repeat on the paired node.

`chat_messages.message_id` column is preserved (nullable + unwritten
by rc.9) for hot-rollback safety; rc.8 finds a column it recognises
if you have to fall back.
