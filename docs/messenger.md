# Universal Messenger

> Status: PR-13 docs branch, stacked on PR-12. This branch contains the
> substrate primitives, Messenger class, chat/skill pilot migration,
> and `/api/slo`. Later stack PRs (#545, #546, #548, #550, #551,
> #554, #555) finish multi-path, DHT-walk recovery, relay preference,
> and the remaining protocol migrations.

The Universal Messenger is the reliability substrate for short
peer-to-peer DKG protocols as they migrate onto it. It generalises the
chat-specific outbox + receiver-dedup work from rc.8 (PRs #533, #534,
#536, #537, #538) into a single layer that wraps `ProtocolRouter.send`
and gives substrate callers the same delivery guarantees:

- **At-least-once delivery** with sender-side durable retry (survives
  daemon crash mid-retry).
- **Exactly-once application semantics** via receiver-side idempotency
  by `messageId`.
- **Stale-snapshot-safe retries** (the rc.9 #538 lesson, lifted into
  the generic substrate).
- **Caller-visible delivery state** — `{ delivered, queued, attempts,
  messageId }` so MCP / HTTP callers can surface "queued" vs "sent"
  to the operator.

This page is the architecture reference. Two siblings live alongside it:

- [`messenger-add-protocol.md`](./messenger-add-protocol.md) — recipe
  for migrating an existing protocol onto the Messenger, or adding a
  new short-message protocol.
- [`messenger-operator.md`](./messenger-operator.md) — how to read
  `/api/slo`, how the planned `--relay-preferred` surface is expected
  to work after PR #548 lands, and how to debug a peer that "should
  be" reachable but isn't.

## Architecture

```
caller (chat, query, etc.)
  │
  ▼
Messenger.sendToPeer(peerId, protocol, payload, { messageId? })
  │  1. (sender-side) check `MessageIdempotencyStore` for direction='out':
  │       seen? → return cached response (re-issue path)
  │  2. wrap payload in `ReliableEnvelope { messageId, version, tsMs, payload }`
  │  3. ProtocolRouter.send (existing low-level wire I/O)
  │  4a. success → record `(peer, protocol, msgId, 'out')` in idempotency store
  │  4b. failure → enqueue in `ProtocolOutboxStore`; background tick + connect-flush retry
  ▼
ProtocolRouter.send  (unchanged; just wire I/O + path selection)
  │
  ▼
[ libp2p / circuit-relay / direct ]
  │
  ▼
ProtocolRouter receives
  │
  ▼
Messenger.register(protocol, handler)
  │  1. decode `ReliableEnvelope`
  │  2. check `MessageIdempotencyStore` for direction='in':
  │       seen + cached response → return cached response (no app handler call)
  │       seen + mark-only       → return RESPONSE_GONE
  │       not seen               → invoke handler(payload, peerId)
  │  3. record `(peer, protocol, msgId, 'in', responseBytes)`
  ▼
application handler (existing protocol-specific code)
```

The substrate is composed of:

1. **`ReliableEnvelope` proto** (`packages/core/src/proto/reliable-envelope.ts`)
   — uniform `{ messageId, version, tsMs, payload }` outer wrapper.
   The application payload (chat protobuf, JSON request, pipe-
   delimited frame) stays inside `payload` byte-identical.

2. **`MessageIdempotencyStore`** (interface in
   `packages/core/src/messenger-types.ts`; SQLite-backed in
   `packages/node-ui/src/db.ts`'s `SqliteMessageIdempotencyStore`) —
   keyed by `(peer, protocol, messageId, direction)`, with inline
   response cache up to 256 KiB and mark-only beyond.

3. **`ProtocolOutbox` + `ProtocolOutboxStore`**
   (`packages/core/src/protocol-outbox.ts`; SQLite-backed in
   `SqliteProtocolOutboxStore`) — durable send-side retry queue keyed
   by `(peer, protocol, messageId)`. Backoff ladder: 5s → 15s → 30s →
   60s → 5m → 30m → 2h, capped 24h.

4. **`Messenger`** class (`packages/agent/src/p2p/messenger.ts`) — wires
   the above together around `ProtocolRouter`. Provides `sendReliable`
   + `register` as the only public surface every migrated protocol
   needs.
   Legacy `sendToPeer` is retained as a bare pass-through for any
   `/dkg/10.0.0/*` caller that has not migrated yet.

## Topology + sequence flows

The relay is a transparent libp2p hop — it sees Noise/TLS-encrypted
frames at the connection layer; the `ReliableEnvelope` + payload is
opaque to it, so the relay can't dedup, can't retry, and can't read
message content. Both daemons run the identical Messenger stack.
Whichever side initiates a send is labelled "sender" in the diagrams;
the same code paths exist on both nodes.

### Flow 0 — Topology

```mermaid
flowchart LR
  subgraph SenderNode [Sender daemon]
    SApp[App caller]
    SMS[Messenger]
    SIdem[(IdempotencyStore<br/>SQLite)]
    SOut[(OutboxStore<br/>SQLite)]
    SRouter[ProtocolRouter]
    SLib[libp2p stack]
  end
  subgraph RelaySet [Testnet relay set — core nodes]
    R1[Relay R1]
    R2[Relay R2]
    R3[Relay R3]
    R4[Relay R4]
  end
  subgraph ReceiverNode [Receiver daemon — IDENTICAL stack]
    RLib[libp2p stack]
    RRouter[ProtocolRouter]
    RMS[Messenger]
    RIdem[(IdempotencyStore<br/>SQLite)]
    ROut[(OutboxStore<br/>SQLite)]
    RApp[App handler]
  end

  SApp --> SMS
  SMS <--> SIdem
  SMS <--> SOut
  SMS --> SRouter --> SLib

  SLib -.circuit-relay v2.-> R1
  SLib -.circuit-relay v2.-> R2
  SLib -.circuit-relay v2.-> R3
  SLib -.circuit-relay v2.-> R4

  R1 -.forward.-> RLib
  R2 -.forward.-> RLib
  R3 -.forward.-> RLib
  R4 -.forward.-> RLib

  RLib --> RRouter --> RMS
  RMS <--> RIdem
  RMS <--> ROut
  RMS --> RApp
```

Key topology facts:

- Every agent daemon reserves on **2-4 relays simultaneously**
  (multi-reservation, rc.8 PR #526). The relay set today is the
  testnet core nodes; PR #548 will add `--relay-preferred` so
  operators can prioritise their own relays (see
  [`messenger-operator.md`](./messenger-operator.md)).
- The relay is a transparent libp2p hop: it forwards encrypted
  frames; the `ReliableEnvelope` is opaque to it.
- Both daemons run the identical Messenger stack — including the
  outbox. If sender→receiver path breaks, the **sender's** outbox
  holds the entry; the **sender's** tick + `connection:open` flushes
  it; the **receiver's** idempotency absorbs any duplicates.
- Failure modes live at the `SLib ↔ Relay ↔ RLib` boundary
  (reservation expired, receiver disconnected from a given relay,
  relay restarted, direct connection died). The substrate layer is
  what survives those failures.

### Flow 1 — Happy path

Applies to every protocol that has migrated onto the substrate. The
relay forwards bytes opaquely.

```mermaid
sequenceDiagram
    autonumber
    participant SApp as Sender App
    participant SMS as Sender Messenger
    participant SIdem as Sender Idem
    participant SLib as Sender libp2p
    participant Relay as Relay R (one of N reserved)
    participant RLib as Receiver libp2p
    participant RMS as Receiver Messenger
    participant RIdem as Receiver Idem
    participant RApp as Receiver App

    Note over Relay: Sees Noise/TLS-encrypted frames only;<br/>ReliableEnvelope opaque to relay

    SApp->>SMS: sendReliable(receiverPid, "/dkg/10.0.1/X", payload)
    SMS->>SMS: messageId = uuid()
    SMS->>SIdem: check(receiverPid, X, messageId, 'out')
    SIdem-->>SMS: { seen: false }
    SMS->>SMS: env = ReliableEnvelope.encode({messageId, v:1, tsMs, payload})
    SMS->>SLib: ProtocolRouter.send via /p2p/relayPid/p2p-circuit/p2p/receiverPid
    SLib->>Relay: open circuit-relay-v2 stream
    Relay->>RLib: forward bytes (no inspection)
    RLib->>RMS: deliver to Messenger.register wrapper for X
    RMS->>RMS: env = ReliableEnvelope.decode(bytes)
    RMS->>RIdem: check(senderPid, X, env.messageId, 'in')
    alt duplicate receive (e.g. multi-path race)
        RIdem-->>RMS: { seen: true, cachedResponse }
        RMS-->>RLib: respond with cached (or RESPONSE_GONE if mark-only)
    else first receive
        RIdem-->>RMS: { seen: false }
        RMS->>RApp: handler(env.payload, senderPid)
        RApp-->>RMS: responseBytes
        RMS->>RIdem: record(senderPid, X, messageId, 'in', responseBytes if cached)
        RMS-->>RLib: respond(responseBytes)
    end
    RLib->>Relay: response bytes
    Relay->>SLib: forward
    SLib->>SMS: response
    SMS->>SIdem: record(receiverPid, X, messageId, 'out', response)
    SMS-->>SApp: { delivered: true, response, messageId, attempts: 1 }
```

The receiver-side app handler never sees the envelope or the relay
topology. It receives the original `payload` (its existing protobuf /
JSON bytes, unchanged from rc.8) and returns its existing
`responseBytes`. Reliability + dedup happens transparently around it
on **both sides**.

### Flow 2 — Path breaks → outbox → recovery → flush

The dominant failure mode in the rc.8 8h soak. Shows two relays in
different broken states + how the recovery primitives heal the path.

```mermaid
sequenceDiagram
    autonumber
    participant SMS as Sender Messenger
    participant SLib as Sender libp2p
    participant R1 as Relay R1 (stale reservation)
    participant R2 as Relay R2 (receiver gone)
    participant R3 as Relay R3 (receiver re-reserves here later)
    participant RLib as Receiver libp2p
    participant SOut as Sender Outbox
    participant Recov as Sender recovery<br/>(DHT walk / inbound from receiver)

    Note over SMS,RLib: First attempt — every cached path is broken

    SMS->>SLib: send envelope to receiverPid
    SLib->>R1: try /p2p/R1/p2p-circuit/p2p/receiverPid
    R1-->>SLib: NO_RESERVATION
    SLib->>R2: try /p2p/R2/p2p-circuit/p2p/receiverPid
    R2-->>SLib: peer not reachable via this relay
    SLib-->>SMS: error: no valid addresses for peer
    SMS->>SOut: enqueue(receiverPid, X, messageId, env, error, now)
    Note over SOut: durable across daemon restart<br/>(SQLite, unlike rc.8's in-memory chat outbox)

    Note over Recov,RLib: Time passes — multiple recovery channels race

    par DHT walk (PR-5) after attempts >= 5
        Recov->>SLib: peerRouting.findPeer(receiverPid) — populates peerStore with R3
    and Inbound from receiver (rc.8 #536 + #537)
        RLib->>R3: receiver opens connection to sender via R3
        R3->>SLib: inbound circuit connection arrives
        Note over SLib: rc.8 PR #536 enriches peerStore with reverse path;<br/>rc.8 PR #537 fast-path reuses existing conn for outbound stream
    end

    Note over SLib,SMS: Connection event triggers opportunistic flush

    SLib->>SMS: connection:open(receiverPid)
    SMS->>SOut: pendingFor(receiverPid)
    SOut-->>SMS: [entry]
    SMS->>SOut: tryBeginAttempt + hasEntry (stale-snapshot guard, rc.8 PR #538)
    SOut-->>SMS: still pending
    SMS->>SLib: send envelope via R3 (now in peerStore) or existing inbound conn
    SLib->>R3: open stream
    R3->>RLib: forward
    Note over RLib: Receiver-side idempotency dedupes if this is a re-attempt
    RLib-->>R3: response
    R3-->>SLib: forward back
    SLib-->>SMS: response
    SMS->>SOut: markDelivered(receiverPid, X, messageId)
```

This is exactly the failure recipe the rc.8 8h soak surfaced. The new
substrate makes outbox durability the floor (no chat-specific limit);
pending PR #546 adds the DHT-walk-on-stall recovery channel on top of
the inbound-from-receiver path that rc.8 already provides.

### Planned Flow 3 — Multi-path parallel send (PR #545)

After PR #545 lands, the sender can race N relays in parallel;
whichever forwards first wins, and receiver dedup absorbs anything
from losing paths.

```mermaid
sequenceDiagram
    autonumber
    participant SMS as Sender Messenger
    participant SLib as Sender libp2p
    participant R1 as Relay R1
    participant R2 as Relay R2
    participant R3 as Relay R3
    participant RLib as Receiver libp2p
    participant RMS as Receiver Messenger
    participant RIdem as Receiver Idem
    participant RApp as Receiver App

    SMS->>SLib: send(env, {parallelPaths: 2})
    SLib->>SLib: enumerate from peerStore + getConnections() (reuses rc.8 PR #537 walk)
    par parallel newStream on diverse relays
        SLib->>R1: open circuit stream
    and
        SLib->>R2: open circuit stream
    end

    R1-xRLib: stream forward fails (relay dropped reservation between enum and dial)
    R2->>RLib: stream forward succeeds
    RLib->>RMS: handler wrapper (path R2)
    RMS->>RIdem: check(senderPid, X, env.messageId, 'in')
    RIdem-->>RMS: { seen: false }
    RMS->>RApp: handler runs once
    RApp-->>RMS: responseBytes
    RMS->>RIdem: record(... 'in', responseBytes)

    Note over R3,RLib: If a slower path arrived later (parallelPaths > 2):<br/>idempotency returns cached; RApp NOT called again

    R2-->>SLib: response (winner)
    SLib->>SLib: abort loser streams as redundant
    SLib-->>SMS: response from R2
```

Critical guard in PR #545: `parallelPaths > 1` is only safe for
substrate-routed protocols on the `/dkg/10.0.1/*` prefix where
receiver dedup is mandatory. Default `parallelPaths` per protocol is
in the [per-protocol coverage table](#per-protocol-coverage) below.
`/storage-ack` + `/verify-proposal` stay at **1** in the planned ACK
migration because they already fan out at the app layer — N=3 would
be 9x amplification.

## Wire format

Every message on `/dkg/10.0.1/*` is `ReliableEnvelope` encoded:

```protobuf
message ReliableEnvelope {
  string message_id = 1;     // UUID v4, Messenger-managed
  uint32 version = 2;        // 1 = current
  uint64 ts_ms = 3;          // sender wall-clock at send time
  bytes payload = 4;         // original protocol bytes (existing protobuf, JSON, etc.)
}
```

**Protocol prefix bump from `/dkg/10.0.0/*` → `/dkg/10.0.1/*`** is the
coarse-grained compatibility break that signals "envelope wrapper now
present"; the `version` field inside the envelope handles fine-grained
evolution within the prefix. Hard cutover — no negotiation logic, no
codepath that mixes wrapped + bare frames. Two nodes on different
prefixes simply don't talk on the migrated protocol until both reach
rc.9.

## V12 schema (PR-1)

The SQLite-backed stores live in `DashboardDB` (`packages/node-ui/src/db.ts`).
V12 migration is pure additive — chat continues to write to
`chat_messages.message_id` until PR-3 cuts over.

```sql
CREATE TABLE message_idempotency (
  peer_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  response_blob BLOB,            -- inline cache up to 256 KiB; NULL = mark-only
  response_size INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  PRIMARY KEY (peer_id, protocol, message_id, direction)
);
CREATE INDEX idx_idem_ts ON message_idempotency(ts);

CREATE TABLE protocol_outbox (
  peer_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload BLOB NOT NULL,         -- envelope-wrapped wire bytes (not raw app payload)
  attempts INTEGER NOT NULL DEFAULT 0,
  first_failure_at INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY (peer_id, protocol, message_id)
);
CREATE INDEX idx_outbox_next_attempt ON protocol_outbox(next_attempt_at);
```

Periodic prune (24h TTL) runs in `DashboardDB.prune()`.

## Response caching policy

Fixed at 256 KiB inline cache. No per-protocol or per-call knob.

| Response size                       | Behaviour                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `<=` 256 KiB                        | Stored inline in `response_blob`. Duplicate receive returns cached bytes.                |
| `>` 256 KiB                         | Stored mark-only (`response_blob = NULL`, `response_size` set). Duplicate → RESPONSE_GONE. |

Callers on the receive of `RESPONSE_GONE` decide whether to re-issue
with a fresh `messageId` (planned for `/query-remote` in PR #551 since
SPARQL is idempotent at the app layer) or surface a terminal error.

## Per-protocol coverage

This docs branch is stacked on PR-12, so the table separates what is
available in this branch from later migrations in the rc.9 stack. The
migration recipe (for adding a hypothetical 9th protocol later) is in
[`messenger-add-protocol.md`](./messenger-add-protocol.md).

| Protocol                       | Status in this branch | parallelPaths | Notes                                                                                            |
| ------------------------------ | --------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `/dkg/10.0.1/message` (chat)   | Shipped in PR-3       | 1 here; 2 after PR #545 | Pilot. Wire-format break replaces `chat_messages.message_id` index uniqueness.          |
| `/dkg/10.0.1/skill_request`    | Shipped in PR-3       | 1             | Migrated alongside chat (shares `agent.sendMessage` path).                                       |
| `/dkg/10.0.1/swm-sender-key`   | Pending PR #550       | 1             | Planned batch with `/private-access`.                                                           |
| `/dkg/10.0.1/private-access`   | Pending PR #550       | 1             | Planned batch with `/swm-sender-key`; `AccessClient` takes the minimal `AccessSendSurface` interface. |
| `/dkg/10.0.1/query-remote`     | Pending PR #551       | 1             | Planned `RESPONSE_GONE` retry path; `sendQueryReliable` re-issues with fresh messageId (cap 2).  |
| `/dkg/10.0.1/join-request`     | Pending PR #554       | 1             | Planned removal of `JoinApprovalRetryQueue` in favour of generic outbox persistence.             |
| `/dkg/10.0.1/storage-ack`      | Pending PR #555       | 1             | ACKCollector quorum unchanged; only transport swaps. parallelPaths=1 prevents 9x fan-out.        |
| `/dkg/10.0.1/verify-proposal`  | Pending PR #555       | 1             | Same shape as storage-ack. `/dkg/10.0.0/verify-approval` stays bare (not a substrate caller).    |

## Recovery primitives

- **Outbox-driven retry** — backoff ladder above. SQLite-persisted;
  survives daemon restart.
- **Opportunistic-flush on `connection:open`** — when a peer
  reconnects, drain its `pendingFor(peer)` queue immediately rather
  than wait for backoff. Stale-snapshot-safe via `hasEntry` guard
  (rc.8 #538 lesson, lifted into the substrate).
- **`parallelPaths`** _(pending PR #545)_ — `Messenger.sendReliable`
  opts can race N candidate paths; receiver dedup absorbs duplicates.
  Only safe on `/dkg/10.0.1/*` where dedup is mandatory.
- **DHT walk on stall** _(pending PR #546)_ — outbox entry with ≥ 5
  attempts of "no valid addresses for peer" triggers a time-bounded
  (`DHT_WALK_TIMEOUT_MS=10s`), rate-limited
  (`DHT_WALK_RATE_LIMIT_MS=5min/peer`) `libp2p.peerRouting.findPeer()`.
- **Gossip peer-hints** _(PR-6, cancelled per Gate B)_ — Gate B
  decision was to skip; pending DHT walk + inbound-from-receiver are
  expected to be sufficient. If a post-ship soak shows DHT walk
  insufficient, PR-6 lands as a fast follow-up under the original
  gossip-hints design.

## SLO

### Clock definition

The per-message latency clock starts the **first time**
`Messenger.sendReliable(peerId, protocol, payload)` is invoked for a
given `(peer, protocol, messageId)` triple, and stops when **any**
attempt (initial send or any background outbox retry) resolves to
`{ delivered: true }`. Concretely:

- Initial wire I/O time is included.
- Time spent waiting in the outbox between failed attempts is included.
- Re-issues with a fresh `messageId` (e.g. the planned
  `RESPONSE_GONE` retry on `/query-remote` in PR #551) are
  **separate** SLO samples; each
  `messageId` is its own user-visible operation.
- Sender-side and receiver-side idempotency cache hits are not new
  deliveries. They return cached bytes or `RESPONSE_GONE` without
  adding a latency sample or incrementing `delivered`.

This is the operator-visible "I clicked send → it arrived" time, which
is what the 99.9%/15s ship-gate target measures.

### Target

These are the final rc.9 stack targets. On this branch, only migrated
protocols contribute samples.

| Protocol family                                                          | SLO       |
| ------------------------------------------------------------------------ | --------- |
| chat / skill_request / query-remote                                      | ≥ 99%/15s |
| swm-sender-key / private-access / join-request / storage-ack / verify-proposal | ≥ 99.5%/15s |

The ship-gate runs the soak script (`scripts/libp2p-soak-test.sh`)
across both Lex and Miles for an overnight run; the `/api/slo`
endpoint is the source of truth for go/no-go on `v10.0.0-rc.9` tag.

### `/api/slo` endpoint (PR-12)

Localhost-only by default (binds to `127.0.0.1` like every other
`/api/*` route; same `Authorization: Bearer` requirement). One-shot
snapshot of the in-memory histogram — no cumulative on-disk store.
Returns the latest 1000 samples per protocol (`DEFAULT_SLO_WINDOW_SAMPLES`).

```
GET /api/slo
Authorization: Bearer <token from ~/.dkg/auth.token>
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
      "queued": 14           // monotonic counter; "queued" = first send failed → outbox
    }
  }
}
```

Empty body `{ "protocols": {} }` means no substrate traffic has flowed
since daemon start — either the node is idle, or the protocols it has
exercised are still on `/dkg/10.0.0/*` and have not been migrated on
this branch.

### Reading guide

- **Did we hit SLO?** For each protocol where you care about the
  target, check `p99Ms` against the 15000 ms budget. If `p99Ms <=
  15000`, that protocol is meeting the latency target for the last
  `samples` operations.
- **Delivery and queue counters.** `delivered` and `queued` are
  independent monotonic totals since daemon start, not disjoint
  buckets. A message can increment `queued` after its first send
  fails and later increment `delivered` when an outbox retry lands, so
  `delivered / (delivered + queued)` is not a success rate. Use
  `queued` growth as "first attempt needed retry" pressure and
  compare it with `delivered` growth to spot stuck peers.
- **No `samples`, only `queued`?** The protocol has only ever seen
  failed first attempts — typically a brand-new peer where address
  resolution hasn't settled. Watch for `delivered` to start climbing
  as the outbox retries land; after PR #546 lands, DHT-walk-on-stall
  should kick in after 5 failed attempts.
- **Soak runs.** `scripts/libp2p-soak-test.sh` writes a per-cycle
  snapshot of `/api/slo` to `~/.dkg/soak-test-*/slo.jsonl` alongside
  the existing `preflight.jsonl`, `sends.jsonl`, `inbox.jsonl`. The
  human-readable summary line in `main.log` reads e.g.
  `slo: message=d12/q0 p99=145ms, skill_request=d3/q0 p99=890ms, ...`.

### Caveats

- The histogram is **in-memory only**. Daemon restart resets all
  counters and samples. The SQLite outbox itself survives restart;
  the SLO view does not.
- Samples are recorded only for protocols routed through the
  substrate. Protocols still on `/dkg/10.0.0/*` (any not in the
  per-protocol coverage table above) are invisible to `/api/slo`.

## Open questions / future work

- Multi-recipient fan-out (broadcast to N peers with single
  `messageId`) — out of scope for rc.9; explored in a follow-up RFC.
- Cross-process idempotency (multiple daemons sharing the same store)
  — not needed today (one daemon per node) but the schema accommodates it.
- Operator-relay infrastructure — code-side is planned in PR #548
  (`--relay-preferred`); actual relay provisioning is an out-of-band
  ops track. See [`messenger-operator.md`](./messenger-operator.md).
- `Messenger.sendToPeer` legacy pass-through: kept at rc.9 for any
  future incremental migration; may be deprecated in a later rc once
  the substrate has had enough operator-time to confirm no surprise
  caller emerges.
- Persistent SLO histogram: today the histogram is in-memory only
  (resets on daemon restart). If operators report that they need
  multi-day rolling SLO views, a follow-up RFC would persist the
  histogram to a `slo_samples` SQLite table with a windowed prune.
