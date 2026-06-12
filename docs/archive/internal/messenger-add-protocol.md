# Adding a protocol to the Universal Messenger

> Audience: a contributor who wants to migrate an existing
> `/dkg/10.0.0/*` protocol onto the substrate, or add a new
> short-message protocol from scratch.
>
> Status: shipping in `v10.0.0-rc.9`. Skeleton landed in PR-3
> (chat + skill pilot migration).

This is the recipe. Architecture rationale lives in
[`messenger.md`](./messenger.md); per-operator surfaces live in
[`messenger-operator.md`](./messenger-operator.md). When in doubt,
follow what the chat migration did — it's the worked example.

## The pitch

Every short-message protocol in DKG used to roll its own retry
queue + receiver dedup + error classification. The Universal
Messenger replaces that with one substrate so a new protocol only
has to ship its application payload — the substrate handles
delivery semantics.

## What you get for free

- **At-least-once delivery** with sender-side durable retry
  (survives daemon crash mid-retry; the SQLite outbox is
  restart-safe).
- **Exactly-once application semantics** via receiver-side
  idempotency by `messageId`.
- **Sender-side dedup** — a retry of an already-delivered message
  returns the cached response without a wire round-trip.
- **Stale-snapshot-safe retries** (the rc.9 #538 lesson, lifted into
  the generic substrate).
- **Caller-visible delivery state** — `{ delivered, queued,
  attempts, messageId, nextAttemptAtMs }` so MCP / HTTP callers can
  surface "queued" vs "sent" to the operator.
- **Opportunistic flush on `connection:open`** — when a peer
  reconnects, the substrate drains its pending queue immediately.

## Cost of opting in (per protocol)

- One protocol-prefix bump (e.g. `/dkg/10.0.0/foo` →
  `/dkg/10.0.1/foo`). Hard cutover. No mixed-frame negotiation.
- Replace `router.send(...)` / `router.register(...)` call sites with
  `messenger.sendReliable(...)` / `messenger.register(...)`.
- Delete any protocol-specific retry queue / dedup index you used to
  carry. The substrate's outbox + idempotency cache subsume them.

## Recipe

### 1. Bump the protocol prefix

In `packages/core/src/constants.ts`:

```ts
// Before
export const PROTOCOL_FOO = '/dkg/10.0.0/foo';

// After
export const PROTOCOL_FOO = '/dkg/10.0.1/foo';
```

The prefix bump is the version contract. Two daemons on different
prefixes don't talk on the migrated protocol until both reach
rc.9 — see [`messenger.md` "Wire format"](./messenger.md#wire-format)
for why we chose a hard cutover over a negotiation layer.

### 2. Migrate the sender

Find every site that previously called `router.send(peerId,
PROTOCOL_FOO, bytes)` and route it through the substrate:

```ts
// Before
const responseBytes = await this.router.send(peerId, PROTOCOL_FOO, requestBytes);

// After
const result = await this.messenger.sendReliable(
  peerId,
  PROTOCOL_FOO,
  requestBytes,
  { messageId: caller_supplied_or_undefined }, // optional; UUID v4 minted if omitted
);

if (!result.delivered) {
  // Either:
  //   - { queued: true, attempts, nextAttemptAtMs, error } — substrate enqueued for retry
  //   - rethrown if the error was non-recoverable (decode bug, unknown protocol)
  return handleQueued(result);
}

const responseBytes = result.response;
// ... and remember to handle RESPONSE_GONE if your response could exceed 256 KiB:
if (new TextDecoder().decode(responseBytes) === RESPONSE_GONE_MARKER) {
  // The receiver cached this messageId mark-only. Re-issue with a fresh messageId
  // if the response shape matters (e.g. /query-remote); otherwise treat as delivered.
}
```

The `ReliableSendResult` shape is the authoritative source of
truth — see `packages/agent/src/p2p/messenger.ts` JSDoc.

### 3. Migrate the receiver

Find the `router.register(PROTOCOL_FOO, handler)` site and switch to
`messenger.register`:

```ts
// Before
router.register(PROTOCOL_FOO, async (data, fromPeerId) => {
  const request = decode(data);
  // ... application logic ...
  return encode(response);
});

// After
messenger.register(PROTOCOL_FOO, async (payload, fromPeerId) => {
  // `payload` is already envelope-unwrapped. `fromPeerId` is a string
  // (was `{ toString(): string }` under router.register; the substrate
  // normalises to string before invoking your handler).
  const request = decode(payload);
  // ... application logic — UNCHANGED ...
  return encode(response);
});
```

Notes:

- The substrate decodes the `ReliableEnvelope` and unwraps the
  application payload before invoking your handler. Your handler
  doesn't see (or know about) the envelope.
- If `messageId` was already seen, the substrate returns the cached
  response (or `RESPONSE_GONE` marker) and your handler is **not
  invoked**. This is the exactly-once-application-semantics
  guarantee.
- The fromPeerId argument is a `string` rather than the libp2p
  `PeerId` object — one less `.toString()` call site.

### 4. Delete the protocol-specific retry queue

If your protocol had its own retry queue (e.g.
`JoinApprovalRetryQueue`, the deleted `MessageOutbox`,
ad-hoc `setTimeout` retries), delete it. The substrate's
`ProtocolOutbox` is the single source of truth, keyed by
`(peer, protocol, messageId)`.

The chat migration deleted:

- `packages/agent/src/message-outbox.ts` and its test
- `packages/agent/test/message-outbox.test.ts`
- `DKGAgent.processMessageOutboxTick` /
  `processMessageOutboxOnConnect` / `retryOutboxEntry` /
  `messageOutbox` field / `messageOutboxTimer` field

Equivalent surfaces are now on `Messenger`:

| Old (chat-specific)              | New (substrate)                       |
| -------------------------------- | ------------------------------------- |
| `messageOutbox.enqueueFailure`   | implicit via `sendReliable` failure   |
| `messageOutbox.markDelivered`    | implicit via `sendReliable` success   |
| `messageOutbox.pendingFor(peer)` | `messenger.listOutbox().filter(...)`  |
| `processMessageOutboxTick`       | `messenger.processOutboxTick(now)`    |
| `processMessageOutboxOnConnect`  | `messenger.processOutboxOnConnect(p)` |
| `messageOutboxTimer`             | `DKGAgent.messengerOutboxTimer`       |

The DKGAgent wires `processOutboxTick` + `processOutboxOnConnect` for
you. New protocols don't need to touch the lifecycle plumbing.

### 5. Update the per-protocol coverage table

Add a row to the table in [`messenger.md` § "Per-protocol coverage"](./messenger.md#per-protocol-coverage):

```md
| `/dkg/10.0.1/foo` | PR-### | 1 (or 2 if parallelPaths makes sense) | One-line note about migration risks. |
```

### 6. Test

Two test layers:

1. **Substrate semantics** — already covered generically in
   `packages/agent/test/messenger-substrate.test.ts`. Don't re-test
   the substrate per protocol.

2. **Your application semantics** — a focused test that:
   - Asserts your wire format still encodes correctly under the
     envelope.
   - Asserts your handler is invoked once on first receive, zero
     times on duplicate receive (the substrate gates via
     `Messenger.register`).
   - Asserts your existing application-layer assertions still hold.

For protocols with synchronous request/response semantics where the
caller blocks on the response (`/query-remote`, `/skill_request`),
add a test that verifies a `RESPONSE_GONE` return from
`sendReliable` is surfaced as an actionable error, not silently
treated as success.

### 7. CHANGELOG

Mention the prefix bump in the `v10.0.0-rc.9` CHANGELOG entry. Once
all 13 PRs land it will be a single line saying "all short-message
protocols moved to `/dkg/10.0.1/*` for envelope-wrapped reliable
delivery". Until then, list which protocols migrated in your PR.

## Worked example: chat (PR-3)

Files touched (search the PR for the actual diff):

- `packages/core/src/constants.ts` — `PROTOCOL_MESSAGE` bumped to
  `/dkg/10.0.1/message`.
- `packages/agent/src/messaging.ts`:
  - Constructor dropped its `ProtocolRouter` arg. It only needs the
    `Messenger` now.
  - `router.register(PROTOCOL_MESSAGE, this.handleIncoming)` →
    `messenger.register(PROTOCOL_MESSAGE, this.handleIncoming)`.
  - `messenger.sendToPeer(...)` calls in `sendChat` +
    `sendSkillRequest` → `messenger.sendReliable(...)`.
  - `sendChat` return type extended with `queued`, `attempts`,
    `nextAttemptAtMs` (the rc.8 outbox surface is preserved at this
    layer; just sourced from the substrate now).
  - `sendSkillRequest` treats `queued` as a failure (skill calls are
    sync request/response).
  - Handles `RESPONSE_GONE` defensively (chat ACKs are tiny so
    in practice it never fires; the branch is there for safety).
- `packages/agent/src/dkg-agent.ts`:
  - Deleted `MessageOutbox` import + `messageOutbox` field +
    `messageOutboxTimer` field + `processMessageOutboxTick` +
    `processMessageOutboxOnConnect` + `retryOutboxEntry`.
  - `listMessageOutbox()` now filters
    `messenger.listOutbox()` by `protocol === PROTOCOL_MESSAGE` —
    same operator-facing semantics, substrate-backed source.
  - `getPeerDiagnostics()` outbox snapshot now sources from
    `messenger.listOutbox()` instead of `messageOutbox.pendingFor`.
- `packages/agent/src/message-outbox.ts` — **deleted**.
- `packages/agent/test/message-outbox.test.ts` — **deleted** (test
  coverage replaced by `messenger-substrate.test.ts`).
- `packages/agent/test/dkg-agent-diagnostics.test.ts` — fixture
  switched from `MessageOutbox` to a `Messenger`-shaped stub.
- `packages/agent/test/p2p-resilience.test.ts` — references to
  `processMessageOutboxOnConnect` updated to `messenger.processOutboxOnConnect`;
  the stale-snapshot-guard regression deleted (already covered in
  `messenger-substrate.test.ts`).
- `packages/node-ui/src/db.ts` — V13 migration drops
  `idx_chat_msgid` partial unique index. `chat_messages.message_id`
  column preserved nullable for rollback safety.
- `packages/node-ui/test/db.test.ts` — V11 receiver-dedup tests
  rewritten to the V13 substrate-owned contract (duplicate
  `(peer, direction, messageId)` inserts now persist as separate
  rows because dedup happens upstream).
- `docs/messenger.md` — "Per-protocol coverage" row added /
  refined.
- This file (`docs/messenger-add-protocol.md`) — net-new.
- `CHANGELOG.md` — entry under `v10.0.0-rc.9` noting the in-flight
  queue behaviour during operator upgrade (no message loss; in-flight
  rc.8 messages drain via legacy code paths still resident in rc.8
  daemons, then PR-3+ daemons send everything new via the substrate).

## Rollback notes

A hot rollback from rc.9 to rc.8 is structurally safe:

- `chat_messages.message_id` column is preserved (nullable +
  unwritten by rc.9). rc.8 finds a column it knows about.
- `message_idempotency` and `protocol_outbox` tables stay in the
  database but rc.8 doesn't open them — orphaned but harmless.
- In-flight `protocol_outbox` entries on the upgraded node won't be
  retried by rc.8 (it doesn't run the substrate tick). Operators
  should drain the outbox via the dashboard before downgrading, or
  accept that any queued retries will sit dormant until a re-upgrade.

The protocol prefix bump is the irreversible part. Once two rc.9
nodes have exchanged messages on `/dkg/10.0.1/*`, the receiver's
idempotency table has cached those `messageId`s. A downgrade doesn't
break anything — just stops new traffic until both sides converge
on the same prefix again.

## FAQ

### Why a protocol-prefix bump and not a negotiation layer?

Negotiating envelope-vs-bare on the same prefix means every handler
gets a code path that "might be wrapped, might not be" and the
idempotency table risks recording responses against fabricated /
missing `messageId`s if the substrate ever sees a bare frame on a
substrate-registered protocol. Hard cutover keeps the substrate's
correctness proofs simple. Cost is a one-day Gate-A window where two
laptops must agree on the prefix; in practice we already require both
sides to be on the same release for chat to work, so the constraint
isn't new.

### What's the right way to pick a `messageId`?

- Default: omit it. The substrate mints a UUID v4 for you.
- Caller-supplied: pass `opts.messageId` when you want to correlate
  retries with your own bookkeeping (e.g. MCP tool layer threading
  an external request id through the call).
- The substrate dedupes on `(peer, protocol, messageId, direction)` —
  reusing the same id across DIFFERENT peers is fine, the
  per-peer namespaces are independent.

### What if my response can exceed 256 KiB?

Then your duplicate receive returns `RESPONSE_GONE_MARKER` (the
substrate stores the response mark-only beyond the cache budget). For
synchronous request/response protocols (`/query-remote`,
`/skill_request`) you should detect this and re-issue with a fresh
`messageId` — see the chat code's `RESPONSE_GONE` handling for the
pattern. For fire-and-forget protocols you can ignore it.

### Can I bypass the substrate for one-off calls?

`Messenger.sendToPeer` is still the legacy pass-through and stays
that way until every short-message protocol has migrated. Once
migration is done (Milestone C complete), `sendToPeer` may be
deprecated. For new protocols, just use `sendReliable` — there's no
upside to bypassing the substrate.
