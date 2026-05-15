import { RetryQueue, type RetryEntry } from '@origintrail-official/dkg-core';

/**
 * In-memory retry queue for outbound agent-to-agent chat messages.
 *
 * Background
 * ----------
 * `MessageHandler.sendChat` was a one-shot send: it dialled the recipient
 * peer through `Messenger.sendToPeer` → `ProtocolRouter.send`, and on any
 * transport failure (`'no valid addresses for peer'` from a cold-dial
 * with empty peerStore, `'Remote closed connection during opening'` from
 * a relay flap mid-handshake, dial timeout, AbortSignal) returned
 * `{ delivered: false, error }` to the caller and dropped the message
 * on the floor. The MCP `dkg_send_message` tool then surfaced an error
 * to the operator — but the actual user-typed text was gone. They had
 * to retype and re-send manually.
 *
 * This is the symmetric failure mode of the curator-side
 * `notifyJoinApproval` silent drop that PR #510 fixed via
 * `JoinApprovalRetryQueue`. The bug was discovered in the same
 * two-laptop debug session that produced PR #517 — invitee-side
 * `dkg_send_message` from Miles to Lex's node failed silently for ~17
 * minutes after the recipient peer briefly disconnected from the relay
 * mesh, even though the recipient was online and had configured ACL
 * entries that would have accepted the message. Lex's queue absorbed
 * the curator-side asymmetry; this queue absorbs the invitee-side one.
 *
 * Design notes
 * ------------
 *
 *   * Per-message keys, per-recipient FIFO. Each enqueued message is a
 *     distinct entry in the underlying generic `RetryQueue`, keyed by
 *     `${recipientPeerId}::${messageId}`. The caller supplies a unique
 *     `messageId` per send (typically a uuidv4 or sequence number);
 *     repeat enqueueFailure on the same key bumps `attempts`. To drain
 *     in send-order for a given recipient, callers sort the
 *     `pendingFor(peerId)` result by `firstFailureAt` ascending. This
 *     differs from `JoinApprovalRetryQueue` which is one-entry-per-pair
 *     (set semantics, latest-write-wins) — chat needs ordered delivery
 *     across N pending messages to the same peer.
 *
 *   * Caller-visible delivery state. The queued/attempts/nextAttemptAt
 *     fields are surfaced via `agent.sendChat` → `/api/chat` → the MCP
 *     `dkg_send_message` tool, so the agent talking through the MCP
 *     can decide whether to await or surface a "queued for retry"
 *     state to the operator. This is the UX win the join-approval
 *     queue couldn't deliver because the curator caller (the node
 *     itself) doesn't have an interactive operator to inform.
 *
 *   * Backoff ladder. Tighter than join-approval (5s → 15s → 30s →
 *     60s → 5m → 30m → 2h, capped) because chat is interactive — an
 *     operator who typed a message expects feedback within seconds,
 *     not minutes. Total budget is still ~24h so a long peer outage
 *     doesn't drop the message. Lex's design suggestion in the chat
 *     thread on PR #510.
 *
 *   * In-memory only for now. Daemon restart drops pending entries —
 *     the operator can either re-send via MCP (idempotent) or wait
 *     for the next session. SQLite-backed durability is tracked as
 *     `OriginTrail/dkg#518`, which lifts a `RetryQueueStorage<TPayload>`
 *     port into the generic queue so both this outbox and
 *     `JoinApprovalRetryQueue` get persistence in one place. Building
 *     the persistence path was the original Lex proposal but was
 *     scoped out of this PR to keep the diff focused on the silent-
 *     drop fix; the persistent path is the obvious next stack.
 *
 *   * Pure helper. No I/O, no clocks (caller supplies `now` everywhere),
 *     no libp2p references. Test it in isolation; integrate via thin
 *     wiring in `DKGAgent`.
 */

/** Domain payload retained per pending chat message. */
export interface ChatOutboxPayload {
  /** libp2p peerId of the intended recipient. */
  recipientPeerId: string;
  /** Plain-text message body. Encryption happens at send time, not enqueue. */
  text: string;
  /**
   * Optional context graph the sender is talking on behalf of. Carried
   * in the encrypted payload so the recipient's ACL can validate the
   * claim (see `chat-acl.ts`).
   */
  contextGraphId?: string;
  /**
   * Caller-supplied unique id for this message. Used as part of the
   * queue key so multiple distinct messages to the same recipient each
   * get their own entry (per-recipient FIFO via `firstFailureAt` sort).
   */
  messageId: string;
}

/** A single chat-outbox entry: payload + retry metadata. */
export type ChatOutboxRetryEntry = RetryEntry<ChatOutboxPayload>;

export interface MessageOutboxOptions {
  /**
   * Backoff ladder in milliseconds. `attempts=1` (first failure) uses
   * `backoffs[0]`, `attempts=N` uses `backoffs[min(N-1, backoffs.length-1)]`.
   * Must be non-empty.
   */
  backoffs?: readonly number[];
  /**
   * Max age (ms) from `firstFailureAt` before an entry is dropped.
   * Default 24h.
   */
  maxAgeMs?: number;
}

/**
 * Default backoff ladder for chat outbox: 5s → 15s → 30s → 60s → 5m →
 * 30m → 2h, capped at 2h. Tighter than the join-approval ladder
 * because operators expect interactive-timescale feedback.
 */
export const DEFAULT_CHAT_OUTBOX_BACKOFFS_MS: readonly number[] = [
  5_000,
  15_000,
  30_000,
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];

/** Default max retry age: 24h since first failure. */
export const DEFAULT_CHAT_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Compose the canonical queue key for a `(recipient, message)` pair. */
export function chatOutboxKey(recipientPeerId: string, messageId: string): string {
  return `${recipientPeerId}::${messageId}`;
}

export class MessageOutbox {
  private readonly queue: RetryQueue<ChatOutboxPayload>;
  /**
   * Per-key inflight set to prevent concurrent retry attempts for the
   * same `(recipient, messageId)` pair. The retry surface has two
   * triggers — the periodic `processMessageOutboxTick` and the
   * `connection:open` opportunistic flush in `processMessageOutboxOnConnect`
   * — and they can interleave: the tick can call
   * `messageHandler.sendChat` for entry E, JS yields, the recipient's
   * `connection:open` fires DURING the in-flight send, the on-connect
   * handler reads `pendingFor(peer)` (entry E is still in the queue —
   * `markDelivered` hasn't fired yet because the in-flight send hasn't
   * resolved), and starts a CONCURRENT second `sendChat` for the same
   * entry. Worst case both succeed and the recipient sees the same
   * message twice.
   *
   * Same race shape exists in `JoinApprovalRetryQueue` but the
   * consequences there are harmless (join-approved is idempotent at
   * the receiver — re-confirms subscription state). For chat the
   * duplicate is real user-visible UX corruption, so we guard at the
   * MessageOutbox layer with an atomic check-and-set: the second
   * concurrent attempter sees `tryBeginAttempt` return false and
   * exits without dialing. Identified by Lex review on PR #521.
   *
   * Receiver-side dedup would need a wire-format change (heavyweight,
   * crosses two PRs); a single shared retry lock would prevent
   * legitimate concurrent multi-recipient delivery (chat retries can
   * fan out across many recipients on the same `connection:open`
   * burst). Per-key inflight is the strictly-contained fix.
   *
   * Worth lifting into the generic `RetryQueue<TPayload>` eventually
   * so `JoinApprovalRetryQueue` can use the same primitive (its race
   * is harmless today but the symmetry helps with future-resilience).
   * Left as a follow-up adjacent to OriginTrail/dkg#518.
   */
  private readonly inflight = new Set<string>();

  constructor(options: MessageOutboxOptions = {}) {
    this.queue = new RetryQueue<ChatOutboxPayload>({
      backoffs: options.backoffs ?? DEFAULT_CHAT_OUTBOX_BACKOFFS_MS,
      maxAgeMs: options.maxAgeMs ?? DEFAULT_CHAT_OUTBOX_MAX_AGE_MS,
    });
  }

  /**
   * Atomic check-and-set for the per-key inflight guard. Returns
   * `true` if the caller now owns the in-flight slot for this
   * `(recipient, messageId)` and should proceed with the send;
   * returns `false` if another caller is already attempting it and
   * the current caller should exit without dialing.
   *
   * MUST be paired with `endAttempt(recipient, messageId)` in a
   * try/finally — leaking an inflight entry would permanently block
   * future retries for that key, which would silently lose the
   * message until `dropExpired` evicts it 24h later.
   */
  tryBeginAttempt(recipientPeerId: string, messageId: string): boolean {
    const key = chatOutboxKey(recipientPeerId, messageId);
    if (this.inflight.has(key)) return false;
    this.inflight.add(key);
    return true;
  }

  /** Release the per-key inflight slot. Idempotent. */
  endAttempt(recipientPeerId: string, messageId: string): void {
    this.inflight.delete(chatOutboxKey(recipientPeerId, messageId));
  }

  /**
   * Mark a chat send as failed. Creates a new entry on first failure
   * for this `(recipient, messageId)` pair, bumps `attempts` and
   * reschedules `nextAttemptAt` on subsequent failures with the same
   * key. Returns the resulting entry so the caller can surface
   * delivery-state fields to the MCP tool.
   */
  enqueueFailure(payload: ChatOutboxPayload, error: string, now: number): ChatOutboxRetryEntry {
    return this.queue.enqueueFailure(
      chatOutboxKey(payload.recipientPeerId, payload.messageId),
      payload,
      error,
      now,
    );
  }

  /**
   * Mark a chat send as successful and drop any pending retry for it.
   * Returns `true` when an entry was actually removed (i.e. this was
   * a retry success, not a first-attempt success).
   */
  markDelivered(recipientPeerId: string, messageId: string): boolean {
    return this.queue.markDelivered(chatOutboxKey(recipientPeerId, messageId));
  }

  /**
   * Return all entries whose `nextAttemptAt` is at or before `now`.
   * Used by the periodic tick to find what to retry. Result is in
   * insertion order; callers that need per-recipient ordering should
   * sort by `firstFailureAt`.
   */
  due(now: number): ChatOutboxRetryEntry[] {
    return this.queue.due(now);
  }

  /**
   * Return ALL pending entries for a specific recipient, regardless of
   * `nextAttemptAt`. Used by the `connection:open` opportunistic flush:
   * a peer just reconnecting is exactly the signal we were waiting
   * for, so it's worth attempting NOW even if `nextAttemptAt` is still
   * in the future. Sorted by `firstFailureAt` ascending so callers
   * can drain in send-order (per-recipient FIFO).
   */
  pendingFor(recipientPeerId: string): ChatOutboxRetryEntry[] {
    return this.queue
      .list()
      .filter((e) => e.recipientPeerId === recipientPeerId)
      .sort((a, b) => a.firstFailureAt - b.firstFailureAt);
  }

  /**
   * Drop every entry whose `firstFailureAt` is older than `maxAgeMs`
   * from `now`. Returns the dropped entries so the caller can log
   * them — useful diagnostic for "the operator typed a message hours
   * ago and we never got it through".
   */
  dropExpired(now: number): ChatOutboxRetryEntry[] {
    return this.queue.dropExpired(now);
  }

  /** Get the entry for a `(recipient, messageId)` pair if any. */
  getEntry(recipientPeerId: string, messageId: string): ChatOutboxRetryEntry | undefined {
    return this.queue.getEntry(chatOutboxKey(recipientPeerId, messageId));
  }

  /** Snapshot of all entries for diagnostics. */
  list(): ChatOutboxRetryEntry[] {
    return this.queue.list();
  }

  /** Number of entries currently queued. */
  size(): number {
    return this.queue.size();
  }

  /** Drop everything (for shutdown / tests). */
  clear(): void {
    this.queue.clear();
  }
}
