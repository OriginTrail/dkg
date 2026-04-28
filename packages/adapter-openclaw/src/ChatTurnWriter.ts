import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface ChatTurnMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<{ type: string; text?: string }>;
  /**
   * Optional list of tool invocations the model issued in this assistant
   * step. Present on intermediate assistant messages that exist solely to
   * call a tool (no user-visible reply text); absent on the final reply.
   * Used by `computeDelta` to skip those intermediates so a tool-using
   * turn is persisted as one (user, final-assistant-reply) pair, not
   * one pair per intermediate assistant step.
   */
  toolCalls?: Array<unknown>;
  tool_calls?: Array<unknown>; // openclaw camelCase variant
}

export interface AgentEndContext {
  sessionId: string;
  messages: ChatTurnMessage[];
}

/**
 * Canonical shape mirrors `InternalHookEvent` from
 * `@openclaw/openclaw/src/hooks/internal-hook-types.ts`:
 *   - `sessionKey` is at the event root
 *   - actual message text + envelope metadata live on `event.context.content`,
 *     `event.context.channelId`, `event.context.success`, etc.
 *
 * `text` and `direction` at the root are accepted as a back-compat / test
 * fixture shorthand; production gateway envelopes always use `context`.
 */
export interface InternalMessageEvent {
  sessionKey: string;
  direction?: "inbound" | "outbound";
  text?: string;
  context?: {
    content?: string;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    success?: boolean;
    [k: string]: unknown;
  };
}

/**
 * Pull the message text out of the envelope, preferring the canonical
 * `context.content` over the test-fixture `text` shorthand.
 */
function readEventText(ev: InternalMessageEvent): string {
  const ctx = ev.context;
  if (ctx && typeof ctx.content === "string") return ctx.content;
  if (typeof ev.text === "string") return ev.text;
  return "";
}

export class ChatTurnWriter {
  private client: any;
  private logger: Logger;
  private stateDir: string;
  private cachedWatermarks: Map<string, number> = new Map();
  // FIFO queue per conversation key. Two inbound messages arriving before the
  // first reply are both retained; `onMessageSent` consumes the oldest so the
  // first outbound reply pairs with the first inbound, not the most recent.
  private pendingUserMessages: Map<string, string[]> = new Map();
  private debounceTimers: Map<string, { timer: NodeJS.Timeout; pendingIndex: number }> = new Map();
  private watermarkFilePath: string;
  // Cross-path dedup (W4a agent_end vs. W4b message:sent). The gateway fires
  // both for ordinary LLM turns and the deterministic turnId is identical
  // across paths, so the second persist would be a duplicate write.
  //
  // Keyed by `<sessionId>::<turnId>` so a session reset can clear only that
  // session's reservations (see resetSessionState).
  //
  // The TTL is bounded but generous (R18.1, was 3s). Slow outbound
  // channels (queued Telegram delivery, network glitch) can produce a
  // multi-second delay between `agent_end` and `message:sent`; a 3s TTL
  // expired the cross-path stamp before the second path even fired,
  // letting both paths persist the same turn. 60s comfortably covers
  // realistic slow-channel delivery without making the in-memory map
  // unbounded — entries are evicted opportunistically on each `markTurnIdSeen`
  // call and explicitly on session reset.
  //
  // Same-content false-dedup risk under the longer TTL is bounded by
  // R15.1's per-`messageId` in-flight key (the cross-path content-only
  // stamps are non-mutating peeks from the opposite path, so two
  // legitimate same-content turns with distinct messageIds do not
  // collide).
  private recentTurnIds: Map<string, number> = new Map();
  private static readonly TURNID_TTL_MS = 60_000;
  // R18.2 — Per-session count of W4b persists. In-memory only; rebuilt
  // from zero on gateway restart (acceptable because watermarks are
  // also disk-persisted via `cachedWatermarks` and the dedup map is
  // process-local). Used by `computeDelta` to advance `savedUpTo` past
  // turns that W4b persisted while typed hooks were unavailable
  // (e.g., during a `setup-runtime → full` upgrade where W4b runs
  // alone for a stretch and then W4a kicks in with backfill against
  // a -1 watermark). Without this, the first `agent_end` after the
  // upgrade re-persists every turn W4b already wrote.
  //
  // Trade-off: assumes one `message:sent` fire = one turn pair. For
  // chunked-delivery channels that emit multiple `message:sent` per
  // logical reply, the count can over-advance by the chunk count;
  // worst case is W4a skipping pairs that W4b actually wrote — same
  // failure mode as the lastIdx peek hit, no new data loss.
  private w4bSessionCounts: Map<string, number> = new Map();
  // In-flight persist tracking — `resetSessionState()` awaits these so a
  // pre-reset persist can't advance the just-reset watermark afterward.
  // Both W4a (`onAgentEnd`) and W4b (`onMessageSent`) MUST register their
  // persist jobs here, otherwise the reset assumption "all persists for
  // this session are tracked" is silently violated.
  private inFlightPersists: Map<string, Set<Promise<void>>> = new Map();
  // Per-session reset promises. `onAgentEnd` / `onMessageSent` await these
  // before processing so a compacted message array can't be read against
  // a stale watermark while the reset is still draining.
  private pendingResets: Map<string, Promise<void>> = new Map();

  constructor(options: { client: any; logger: Logger; stateDir: string }) {
    this.client = options.client;
    this.logger = options.logger;
    this.stateDir = options.stateDir;
    this.watermarkFilePath = path.join(this.stateDir, "dkg-adapter", "chat-turn-watermarks.json");
    this.initFromFile();
  }

  private initFromFile(): void {
    try {
      const dir = path.dirname(this.watermarkFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.watermarkFilePath)) {
        const content = fs.readFileSync(this.watermarkFilePath, "utf-8");
        const data = JSON.parse(content);
        if (data && typeof data === "object") {
          for (const [key, val] of Object.entries(data)) {
            if (typeof val === "number") {
              this.cachedWatermarks.set(key, val);
            }
          }
        }
      }
    } catch (err) {
      this.logger.warn?.("[ChatTurnWriter] Failed to load watermarks, starting fresh", { err });
    }
  }

  async onAgentEnd(event: AgentEndContext, ctx?: any): Promise<void> {
    try {
      // B5 — skip dkg-ui channel; DkgChannelPlugin.queueTurnPersistence
      // owns UI-channel persistence with richer metadata (correlation IDs,
      // attachment refs). Avoids double-persist under different sessionIds.
      if (ctx?.channelId === "dkg-ui") return;
      const sessionId = this.deriveSessionId(ctx);
      if (!sessionId) return;
      // If a compaction/reset is mid-flight for this session, wait for it
      // before reading the watermark. Otherwise we'd compute the delta
      // against stale state.
      const pendingReset = this.pendingResets.get(sessionId);
      if (pendingReset) await pendingReset;
      // R18.2 — Take the MAX of W4a's pair-indexed watermark and W4b's
      // session count (minus 1, because count is 1-based). When typed
      // hooks were unavailable for a stretch (e.g., the `setup-runtime`
      // phase before `full` mode comes online), W4b persisted turns
      // without W4a's watermark advancing, so the first `agent_end`
      // after the upgrade would otherwise treat every prior pair as
      // unsaved backfill and re-persist it. Using the W4b count as a
      // floor ensures `computeDelta` skips those.
      const w4aWatermark = this.loadWatermark(sessionId);
      const w4bCount = this.w4bSessionCounts.get(sessionId) ?? 0;
      const savedUpTo = Math.max(w4aWatermark, w4bCount - 1);
      const pairs = this.computeDelta(event.messages, savedUpTo);
      if (pairs.length === 0) return;
      // Persist sequentially so a transient failure on pair N leaves the
      // watermark at N-1 and the next agent_end call retries from the same
      // point. Without sequencing, a failed middle pair could be skipped
      // when the tail succeeds.
      const lastIdx = pairs.length - 1;
      const job = this.trackPersistJob(sessionId, async () => {
        for (let i = 0; i < pairs.length; i++) {
          const { user, assistant, pairIndex } = pairs[i];
          if (!user && !assistant) continue;
          // W4a turnId mixes pair position into the hash so backfill of
          // two same-text pairs (e.g. user said "hi" twice) produces
          // distinct turnIds and BOTH persist.
          const turnId = this.deterministicTurnId(sessionId, user, assistant, pairIndex);
          // Cross-path dedup: only the LAST pair in the loop is the
          // most-recent turn that W4b could plausibly have already
          // persisted. Earlier pairs are backfill (historical turns,
          // never seen by W4b), so they skip the W4b-origin check —
          // otherwise same-content backfill pairs would falsely dedup
          // against each other via the shared content hash.
          //
          // PEEK (non-mutating) — never stamp w4b-origin from W4a's
          // path. Stamping would let two legitimate same-content turns
          // within the TTL window collide on the W4a→W4a self-stamp
          // (R13.1).
          if (i === lastIdx) {
            const w4bOrigin = this.w4bOriginKey(user, assistant);
            if (this.peekTurnIdSeen(sessionId, w4bOrigin)) {
              // W4b already persisted this pair via `message:sent`. The
              // pair is logically saved, so advance the watermark to its
              // index — without this, a later `agent_end` (after the 3s
              // dedup TTL has expired) would re-pair the same pair as
              // unsaved backfill and write a duplicate (R14.1).
              this.bumpWatermark(sessionId, pairIndex);
              continue;
            }
          }
          if (this.markTurnIdSeen(sessionId, turnId)) continue;
          try {
            await this.persistOne(sessionId, user, assistant, turnId, { pairIndex });
            // Stamp W4a-origin so a same-cycle W4b fire dedups.
            this.markTurnIdSeen(sessionId, this.w4aOriginKey(user, assistant));
          } catch (err) {
            // Release the turnId reservation so a retry can re-attempt.
            // No w4b-origin release needed — W4a's last-pair check is
            // now a non-mutating peek (R13.1), so W4a never reserved it.
            this.releaseTurnIdReservation(sessionId, turnId);
            this.logger.error?.("[ChatTurnWriter.onAgentEnd] Persist failed", { err });
            return; // leave watermark at last successful pair
          }
        }
      });
      // Don't await the persist work itself — gateway must not block on
      // disk/network; the await above only covers the reset gate.
      job.catch(() => { /* outer try-catch already covered */ });
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onAgentEnd] Error", { err });
    }
  }

  /**
   * Wrap a persist job in the per-session `inFlightPersists` set so
   * `resetSessionState()` can `Promise.allSettled` everything that's
   * still running. Both W4a and W4b persist paths route through here so
   * the reset gate can't miss a fire-and-forget write.
   */
  private trackPersistJob(sessionId: string, run: () => Promise<void>): Promise<void> {
    let bucket = this.inFlightPersists.get(sessionId);
    if (!bucket) { bucket = new Set(); this.inFlightPersists.set(sessionId, bucket); }
    const job = run();
    bucket.add(job);
    job.finally(() => {
      const b = this.inFlightPersists.get(sessionId);
      if (b) {
        b.delete(job);
        if (b.size === 0) this.inFlightPersists.delete(sessionId);
      }
    }).catch(() => {});
    return job;
  }

  async onBeforeCompaction(event: any, ctx?: any): Promise<void> {
    try {
      this.flushSync();
      // Compaction shrinks or rewrites `messages`, but our pair-index
      // watermark is relative to the current array. A stale N-pair
      // watermark against a compacted 3-pair array would cause the next
      // `onAgentEnd` to skip every pair as "already persisted".
      // Reset is SESSION-SCOPED. The hook returns the reset promise so
      // OpenClaw's typed-hook dispatcher awaits it — the next `agent_end`
      // for this session can't race past the in-flight cleanup.
      await this.runReset(this.deriveSessionId(ctx));
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onBeforeCompaction] Error", { err });
    }
  }

  async onBeforeReset(event: any, ctx?: any): Promise<void> {
    try {
      this.flushSync();
      await this.runReset(this.deriveSessionId(ctx));
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onBeforeReset] Error", { err });
    }
  }

  /**
   * Track the reset promise on `pendingResets` so `onAgentEnd` /
   * `onMessageSent` can `await` it before processing a turn that arrived
   * mid-reset. Without this gate, a fast post-compaction `agent_end`
   * could read the stale watermark before the reset finishes draining.
   */
  private async runReset(sessionId: string): Promise<void> {
    if (!sessionId) return;
    const reset = this.resetSessionState(sessionId);
    this.pendingResets.set(sessionId, reset);
    try {
      await reset;
    } finally {
      // Only delete if no newer reset replaced ours.
      if (this.pendingResets.get(sessionId) === reset) {
        this.pendingResets.delete(sessionId);
      }
    }
  }

  /**
   * Clear all session state for a single session: pending debounce timer,
   * cached watermark, dedup reservations, AND any in-flight `persistOne`
   * jobs are awaited before the wipe. No-op when `sessionId` is empty.
   *
   * In-flight tracking is the load-bearing piece — without it, an `agent_end`
   * fires `persistOne` (fire-and-forget) and IMMEDIATELY a compaction event
   * arrives. The reset clears the watermark to -1, then the still-running
   * `persistOne` calls `saveWatermark(0)`, leaving stale state for the next
   * `agent_end` against a smaller post-compaction array.
   */
  private async resetSessionState(sessionId: string): Promise<void> {
    if (!sessionId) return;
    const inFlight = this.inFlightPersists.get(sessionId);
    if (inFlight && inFlight.size > 0) {
      // Snapshot the set — settle every job (success or failure) before
      // wiping watermark state so a late completion can't reintroduce it.
      const pending = Array.from(inFlight);
      await Promise.allSettled(pending);
    }
    this.inFlightPersists.delete(sessionId);
    this.cachedWatermarks.delete(sessionId);
    const entry = this.debounceTimers.get(sessionId);
    if (entry) {
      clearTimeout(entry.timer);
      this.debounceTimers.delete(sessionId);
    }
    // `conversationKeyFromInternalEvent` and `composeSessionId` produce the
    // same string shape (`openclaw:<channelId>:<accountId>:<conversationId>:<sessionKey>`),
    // so a session reset deletes its pending entry by exact key — no
    // sessionKey suffix matching, which would falsely clear unrelated
    // conversations whose sessionKey shares a trailing fragment OR contains
    // raw `:` (e.g. the `agent:<agentId>:<identity>` keys created in
    // `DkgChannelPlugin`).
    this.pendingUserMessages.delete(sessionId);
    this.clearSessionTurnIds(sessionId);
    // R18.2 — Reset the W4b session count too. After compaction the
    // `messages[]` array is rewritten, so the W4b count's "I persisted
    // N turns" no longer maps to the new pair indices. Leaving stale
    // count would skip new pairs in `computeDelta`.
    this.w4bSessionCounts.delete(sessionId);
    this.writeWatermarkFile();
  }

  onMessageReceived(ev: InternalMessageEvent): void {
    try {
      // B5 — skip dkg-ui channel; DkgChannelPlugin owns UI persistence.
      const channelId = (ev as any)?.context?.channelId ?? (ev as any)?.channelId;
      if (channelId === "dkg-ui") return;
      const conversationKey = this.conversationKeyFromInternalEvent(ev);
      if (!conversationKey) return;
      const text = readEventText(ev);
      // R15.2 — Skip attachment-only / non-text inbound events. `readEventText`
      // returns "" when the envelope carries no text payload (e.g. an image
      // upload from Telegram). Enqueueing an empty string here would let the
      // next `message:sent` pair its assistant reply with a blank user side,
      // persisting an assistant-only turn for a conversation that had no
      // textual inbound. Drop until we add a recoverable representation for
      // attachment-only turns.
      if (!text) return;
      const queue = this.pendingUserMessages.get(conversationKey) ?? [];
      queue.push(text);
      this.pendingUserMessages.set(conversationKey, queue);
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onMessageReceived] Error", { err });
    }
  }

  async onMessageSent(ev: InternalMessageEvent): Promise<void> {
    try {
      // B5 — skip dkg-ui channel; DkgChannelPlugin owns UI persistence.
      // Internal-hook envelope carries channelId on event.context per
      // openclaw/src/infra/outbound/deliver.ts.
      const channelId = (ev as any)?.context?.channelId ?? (ev as any)?.channelId;
      if (channelId === "dkg-ui") return;
      const conversationKey = this.conversationKeyFromInternalEvent(ev);
      if (!conversationKey) return;
      const sessionId = this.deriveSessionIdFromEvent(ev);
      // Wait for any compaction/reset on this session before pairing,
      // so we don't write a turn whose state was about to be wiped.
      const pendingReset = this.pendingResets.get(sessionId);
      if (pendingReset) await pendingReset;
      const success = (ev as any)?.context?.success ?? (ev as any)?.success;
      // Drop failed outbound sends: chat history should not show replies the
      // user never received. Still consume the oldest pending inbound so the
      // next successful turn does not pair its reply with a stale inbound
      // from the aborted exchange.
      if (success === false) {
        const failedQueue = this.pendingUserMessages.get(conversationKey);
        if (failedQueue && failedQueue.length > 0) failedQueue.shift();
        if (failedQueue && failedQueue.length === 0) this.pendingUserMessages.delete(conversationKey);
        return;
      }
      // Strip injected `<recalled-memory>` from assistant text — the model may
      // echo the auto-recall block, and if we persist the raw version here
      // while the W4a path persists the stripped version, the two turnIds
      // diverge and cross-path dedup misses. User text is NOT stripped:
      // legitimate pastes (XML, logs) containing the tag would otherwise be
      // silently corrupted.
      const assistantText = this.stripRecalledMemory(readEventText(ev));
      // R20.1 — Compute `assistantText` BEFORE consuming the pending user.
      // A `message:sent` with `success: true` but no textual content
      // (channel ack, attachment-only send, status broadcast) must not
      // eat the queued user message — otherwise the next REAL textual
      // outbound for this conversation would have nothing to pair with
      // and persist as an assistant-only turn.
      if (!assistantText) return;
      const queue = this.pendingUserMessages.get(conversationKey);
      // R21.2 — Bail when no pending user exists. Persisting an assistant-
      // only turn for a chunked-reply continuation (chunk 2+ of one
      // logical reply) or a proactive notification with no inbound would
      // pollute chat memory/search and break the one-turn-per-exchange
      // invariant. Drop the orphan; if proactive notifications need to
      // be persisted later, they should go through a dedicated path
      // that supplies a synthesized user side or a distinct schema.
      if (!queue || queue.length === 0) return;
      const userText = queue.shift()!;
      if (queue.length === 0) this.pendingUserMessages.delete(conversationKey);
      if (userText || assistantText) {
        // Cross-path dedup, W4b side:
        //   PEEK w4a-origin — non-mutating; if W4a already wrote this
        //   turn within the TTL window, skip.
        const w4aOrigin = this.w4aOriginKey(userText, assistantText);
        if (this.peekTurnIdSeen(sessionId, w4aOrigin)) return; // W4a already wrote
        // R15.1 — In-flight guard with per-turn discriminator.
        //   The cross-path stamp (`w4bOrigin`, content-only) is held for
        //   3s post-success so W4a's later last-pair peek can find it.
        //   That stamp must NOT also serve as the "another W4b path is
        //   in flight" check, because two LEGITIMATE non-LLM turns with
        //   identical text in the same conversation within the TTL
        //   window would collide on it and silently drop the second.
        //   Use the gateway-provided `messageId` as the per-turn key so
        //   distinct turns are never mis-deduped. Fall back to a
        //   monotonic in-process sequence when the envelope omits it
        //   (concurrent same-content fires for a single messageId-less
        //   turn are vanishingly rare in that path).
        const w4bInflight = this.w4bInflightKey(ev, userText, assistantText);
        if (this.markTurnIdSeen(sessionId, w4bInflight)) return; // concurrent W4b dispatch
        const turnId = this.deterministicTurnId(sessionId, userText, assistantText);
        // Route through the same tracked-job wrapper as onAgentEnd so the
        // reset gate sees this in-flight write and `Promise.allSettled`s
        // it. Without tracking, a `message:sent` write mid-compaction
        // could land its `saveWatermark()` after the reset clears state.
        this.trackPersistJob(sessionId, async () => {
          try {
            await this.persistOne(sessionId, userText, assistantText, turnId);
            // Post-success: stamp the content-only `w4bOrigin` key so
            // a later W4a `agent_end` last-pair peek can see that W4b
            // already persisted this turn and skip + bumpWatermark.
            this.markTurnIdSeen(sessionId, this.w4bOriginKey(userText, assistantText));
            // R18.2 — Track the W4b session count so a later `agent_end`
            // (typically after a `setup-runtime → full` upgrade) sees a
            // raised `savedUpTo` floor in `computeDelta` and doesn't
            // re-persist turns W4b already wrote.
            // R20.2 — Only count when the persist consumed BOTH a user
            // message and assistant text — i.e. it represents a complete
            // logical turn pair as `computeDelta` would emit. Counting
            // every successful `message:sent` (chunked replies, channel
            // broadcasts, multi-payload deliveries) advanced the count
            // past `event.messages` and the next `agent_end` skipped
            // real pairs as already persisted. The R20.1 fix above
            // already returns early on empty `assistantText`; the
            // additional `userText` check here filters chunk-2+ deliveries
            // that ran out of pending users on chunk 1.
            if (userText) {
              this.w4bSessionCounts.set(
                sessionId,
                (this.w4bSessionCounts.get(sessionId) ?? 0) + 1,
              );
            }
          } catch (err) {
            // W4b is the ONLY path with a copy of `userText` (it lives
            // ephemerally in the FIFO queue). On a hard persist failure
            // there's no `agent_end` backfill — the messages array doesn't
            // exist for non-LLM channels. Push the consumed user message
            // back to the FRONT of the queue so the next outbound delivery
            // for this conversation re-pairs and retries. Without this,
            // a transient daemon outage would silently drop the turn.
            if (userText) {
              const restored = this.pendingUserMessages.get(conversationKey) ?? [];
              restored.unshift(userText);
              this.pendingUserMessages.set(conversationKey, restored);
            }
            // Release the in-flight reservation so a retry can proceed.
            // No `w4bOrigin` release needed — we don't stamp it pre-persist
            // anymore; only stamping happens post-success above.
            this.releaseTurnIdReservation(sessionId, w4bInflight);
            this.logger.error?.("[ChatTurnWriter.onMessageSent] Persist failed", { err });
          }
        }).catch(() => {});
      }
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onMessageSent] Error", { err });
    }
  }

  /**
   * Cross-path dedup check. Returns `true` if `turnId` was already seen
   * within TTL (caller should skip the persist); `false` and reserves the
   * id otherwise. The reservation must be released via
   * `releaseTurnIdReservation(turnId)` on persist failure so retries are
   * not blocked by a stale mark. Evicts expired ids opportunistically.
   */
  private dedupKey(sessionId: string, turnId: string): string {
    return `${sessionId}::${turnId}`;
  }

  private markTurnIdSeen(sessionId: string, turnId: string): boolean {
    const key = this.dedupKey(sessionId, turnId);
    const now = Date.now();
    const ttl = ChatTurnWriter.TURNID_TTL_MS;
    for (const [k, ts] of this.recentTurnIds) {
      if (now - ts > ttl) this.recentTurnIds.delete(k);
    }
    if (this.recentTurnIds.has(key)) return true;
    this.recentTurnIds.set(key, now);
    return false;
  }

  /**
   * Non-mutating presence check. Returns `true` if the key is currently
   * reserved within the TTL window; `false` otherwise. Does NOT stamp.
   *
   * Use for OPPOSITE-path guards (W4a peeking w4b-origin, W4b peeking
   * w4a-origin). The set-on-miss behavior of `markTurnIdSeen` is wrong
   * for the opposite-path check because the peeker would falsely
   * reserve a key it has no business owning, then dedup against itself
   * on the next legitimate same-content turn within the TTL.
   *
   * Evicts the entry opportunistically if it's expired so the read is
   * accurate rather than stale.
   */
  private peekTurnIdSeen(sessionId: string, turnId: string): boolean {
    const key = this.dedupKey(sessionId, turnId);
    const ts = this.recentTurnIds.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts > ChatTurnWriter.TURNID_TTL_MS) {
      this.recentTurnIds.delete(key);
      return false;
    }
    return true;
  }

  /** Release a turnId reservation on persist failure so retries can proceed. */
  private releaseTurnIdReservation(sessionId: string, turnId: string): void {
    this.recentTurnIds.delete(this.dedupKey(sessionId, turnId));
  }

  /** Drop all dedup reservations belonging to one session. */
  private clearSessionTurnIds(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const k of this.recentTurnIds.keys()) {
      if (k.startsWith(prefix)) this.recentTurnIds.delete(k);
    }
  }

  /**
   * Drain everything before shutdown. Awaits all in-flight `persistOne`
   * jobs across every session, settles any pending session reset, and
   * commits the watermark file. `stop()` callers MUST await this — a
   * sync `flushSync()` only commits the file but leaves a fire-and-forget
   * `storeChatTurn()` in flight, so a shutdown right after a reply could
   * exit before the final turn is persisted to the daemon.
   *
   * R19.2 — Loops until `inFlightPersists` and `pendingResets` are both
   * empty. A previously-dispatched hook handler (e.g., `agent_end` /
   * `message:sent`) can still be running when `stop()` calls `flush()`;
   * if it reaches `trackPersistJob` AFTER our snapshot but BEFORE
   * `Promise.allSettled` returns, the job would otherwise be missed.
   * Re-snapshotting and re-awaiting closes that race. Bounded because
   * `stop()` calls `hookSurface.destroy()` BEFORE `flush()` (R19.2),
   * so no NEW handler invocations are dispatched while flush runs —
   * only the in-flight ones complete.
   */
  async flush(): Promise<void> {
    while (true) {
      const allJobs: Promise<void>[] = [];
      for (const bucket of this.inFlightPersists.values()) {
        for (const j of bucket) allJobs.push(j);
      }
      for (const reset of this.pendingResets.values()) {
        allJobs.push(reset);
      }
      if (allJobs.length === 0) break;
      await Promise.allSettled(allJobs);
    }
    this.flushSync();
  }

  flushSync(): void {
    let applied = false;
    for (const [sessionId, entry] of this.debounceTimers.entries()) {
      clearTimeout(entry.timer);
      this.cachedWatermarks.set(sessionId, entry.pendingIndex);
      applied = true;
    }
    this.debounceTimers.clear();
    if (applied) {
      this.writeWatermarkFile();
    }
  }

  /**
   * Return every unsaved (user, assistant) pair in order. `savedUpTo` is a
   * pair-count watermark: -1 means nothing saved, 0 means the first pair
   * has been saved, and so on. Iterates the full message array and emits
   * pairs whose 0-indexed position exceeds the watermark — a transient
   * failure during a previous call leaves earlier pairs unsaved, and the
   * next `onAgentEnd` will backfill them rather than dropping everything
   * except the most recent pair.
   */
  private computeDelta(
    messages: ChatTurnMessage[],
    savedUpTo: number,
  ): Array<{ user: string; assistant: string; pairIndex: number }> {
    const pairs: Array<{ user: string; assistant: string; pairIndex: number }> = [];
    // R19.1 — Queue of unmatched user messages. Two transcript shapes
    // were previously mis-parsed:
    //   * `[user1, user2, assistant]` — the prior single-slot
    //     `currentUser = ...` overwrote `user1` with `user2`, so only
    //     `user2` was paired with the reply and `user1` was lost.
    //   * `[user, assistant(toolCalls + text), tool, assistant(final)]`
    //     — the prior `if (!text && hasToolCalls)` skip didn't catch
    //     intermediate steps that included assistant text alongside
    //     the tool call, so the tool-call step was paired as a turn
    //     and the real final reply ended up paired with an empty user.
    // Both shapes are handled by accumulating consecutive user messages
    // into a queue and flushing the queue (joined) into the next
    // non-tool-call assistant turn. Any assistant carrying tool calls
    // is treated as intermediate regardless of whether it also has
    // text content.
    const pendingUsers: string[] = [];
    let pairIndex = 0;
    for (const msg of messages) {
      if (msg.role === "user") {
        pendingUsers.push(this.extractText(msg.content));
      } else if (msg.role === "assistant") {
        const text = this.extractText(msg.content);
        const hasToolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls.length > 0
          : Array.isArray(msg.tool_calls) ? msg.tool_calls.length > 0
          : false;
        if (hasToolCalls) {
          // Intermediate tool-call step — do NOT count as a pair, do NOT
          // advance pairIndex (the watermark counts user-visible turns),
          // and do NOT consume `pendingUsers`. The next non-tool-call
          // assistant is the real final reply that belongs to the
          // accumulated user side.
          continue;
        }
        if (pendingUsers.length === 0) {
          // R22.1 — Assistant message arrived without any pending user
          // (initial agent greeting, post-compaction artifact, system-
          // injected announcement). Don't emit an empty-user pair, and
          // crucially DON'T advance `pairIndex`: doing so would inflate
          // the watermark and let the next real (user, assistant) pair
          // be skipped as already-saved on the next agent_end. Skip the
          // orphan, leave the watermark untouched, mirror W4b's
          // R21.2 drop-orphan-assistant invariant on the W4a side.
          continue;
        }
        const userText = pendingUsers.join("\n");
        pendingUsers.length = 0;
        if (pairIndex > savedUpTo) {
          pairs.push({
            user: userText,
            assistant: this.stripRecalledMemory(text),
            pairIndex,
          });
        }
        pairIndex++;
      }
      // Skip `tool` and `system` messages — they don't form turns.
    }
    return pairs;
  }

  /**
   * Strip the auto-injected `<recalled-memory>` block from assistant text
   * before persistence. Prevents the per-turn auto-recall block from
   * boomeranging into future turn queries if the model verbatim-quotes
   * system-context.
   *
   * R15.3 — Only strip blocks that carry the `data-source="dkg-auto-recall"`
   * sentinel emitted by `formatRecalledMemoryBlock` in DkgNodePlugin.ts.
   * A user-emitted plain `<recalled-memory>` literal (XML examples,
   * documentation, debugging output) survives verbatim in the persisted
   * transcript. The sentinel match is case-insensitive on the tag/attribute
   * names but the value `dkg-auto-recall` is matched as-is.
   *
   * Handles:
   *   - well-formed sentinel pairs `<recalled-memory data-source="dkg-auto-recall" ...>...</recalled-memory>`
   *   - orphaned sentinel open tag at end-of-text (truncated model output)
   *
   * The sentinel value is load-bearing — keep in sync with
   * `formatRecalledMemoryBlock` in DkgNodePlugin.ts.
   */
  private stripRecalledMemory(text: string): string {
    if (!text) return "";
    // Sentinel attribute requirement: `data-source="dkg-auto-recall"` or
    // `data-source='dkg-auto-recall'`. The attribute may appear anywhere
    // inside the tag's attribute list, so the pattern is anchored on the
    // tag name + a flexible attr scan that requires the sentinel before
    // the closing `>`.
    // R23.3 — Match BOTH single- and double-quoted forms. A model echoing
    // the injected block with `data-source='dkg-auto-recall'` (single
    // quotes) would otherwise survive the strip and boomerang back into
    // future recall queries.
    const sentinelOpen = /<recalled-memory\b(?=[^>]*\bdata-source\s*=\s*(?:"dkg-auto-recall"|'dkg-auto-recall'))[^>]*>/i;
    // (a) well-formed sentinel pairs
    let out = text.replace(
      new RegExp(sentinelOpen.source + /[\s\S]*?<\/recalled-memory>/.source, "gi"),
      "",
    );
    // (b) orphaned sentinel open tag → strip from open-tag to end-of-string
    out = out.replace(
      new RegExp(sentinelOpen.source + /[\s\S]*$/.source, "i"),
      "",
    );
    return out.trim();
  }

  /**
   * Strip control chars and bound length without dropping the
   * distinguishing suffix. R13.2 — naive `substring(0, 64)` collapsed
   * distinct long `channelId` / `accountId` / `conversationId` /
   * `sessionKey` values that shared a long prefix into one composed
   * key, merging unrelated conversations' watermarks. Keep a readable
   * prefix; append a stable hash suffix so distinct overlong values
   * always produce distinct outputs.
   */
  private static readonly SANITIZE_MAX_LEN = 96;
  private static readonly SANITIZE_HASH_LEN = 16;
  private sanitize(part: string): string {
    const cleaned = part.replace(/[\x00-\x1f\x7f]/g, "");
    if (cleaned.length <= ChatTurnWriter.SANITIZE_MAX_LEN) return cleaned;
    const tag = createHash("sha256")
      .update(cleaned)
      .digest("hex")
      .substring(0, ChatTurnWriter.SANITIZE_HASH_LEN);
    const prefixLen =
      ChatTurnWriter.SANITIZE_MAX_LEN - ChatTurnWriter.SANITIZE_HASH_LEN - 1;
    return `${cleaned.substring(0, prefixLen)}~${tag}`;
  }

  /**
   * Cross-path dedup keys. Each path stamps its OWN origin key when it
   * persists; each path checks the OTHER path's origin key before
   * persisting. This makes dedup symmetric — neither order causes a
   * double-write.
   *
   *   - W4a stamps `w4a-content::<sha>` after each successful persist.
   *     `onMessageSent` (W4b) checks this up-front: if W4a already wrote
   *     the same content within the TTL, skip.
   *   - W4b reserves `w4b-content::<sha>` BEFORE persist (atomic mark).
   *     `onAgentEnd`'s LAST pair (the most-recent turn that W4b could
   *     plausibly have just persisted) checks this; backfill pairs
   *     (earlier pair indices) do not, because they correspond to
   *     historical turns W4b never saw.
   *
   * Hash includes only `user:assistant` text (no sessionId, no pair
   * index) — both paths see the same canonical content for the same
   * exchange and produce the same hash.
   */
  /**
   * R17.1 — Hash a STRUCTURED encoding (not raw `:`-joined) so a literal
   * `:` inside `user` or `assistant` cannot bleed across the boundary
   * and let two distinct turns collide on the same digest. Without
   * this, `(user="a:b", assistant="c")` and `(user="a", assistant="b:c")`
   * both hashed `"a:b:c"` and the cross-path dedup map treated them as
   * the same turn. `JSON.stringify` quotes and escapes each segment
   * unambiguously.
   */
  private contentHash(user: string, assistant: string): string {
    return createHash("sha256")
      .update(JSON.stringify([user, assistant]))
      .digest("hex")
      .slice(0, 16);
  }
  private w4aOriginKey(user: string, assistant: string): string {
    return `w4a-content::${this.contentHash(user, assistant)}`;
  }
  private w4bOriginKey(user: string, assistant: string): string {
    return `w4b-content::${this.contentHash(user, assistant)}`;
  }

  /**
   * R15.1 — Per-turn in-flight reservation key for the W4b path.
   * Distinct from the cross-path `w4bOrigin` (which is content-only and
   * held post-success so W4a's last-pair peek can find it). This key
   * exists only to dedup CONCURRENT same-content `message:sent`
   * dispatches for the same logical turn — released on persist
   * completion (success or failure).
   *
   * Prefer the gateway-provided `messageId` (one-per-delivery guarantee
   * from `openclaw/src/infra/outbound/deliver.ts:381`). Fall back to a
   * monotonic in-process sequence when the envelope omits it; in that
   * fallback the in-flight guard becomes effectively a no-op (each fire
   * gets a unique key), which is acceptable because messageId-less
   * envelopes don't exhibit the race in practice.
   */
  private w4bInflightSeq = 0;
  private w4bInflightKey(ev: InternalMessageEvent, user: string, assistant: string): string {
    const messageId = (ev as any)?.context?.messageId;
    if (typeof messageId === "string" && messageId.length > 0) {
      return `w4b-inflight::msg::${messageId}`;
    }
    this.w4bInflightSeq = (this.w4bInflightSeq + 1) >>> 0;
    return `w4b-inflight::seq::${this.w4bInflightSeq}::${this.contentHash(user, assistant)}`;
  }
  /**
   * @deprecated Kept temporarily for tests that inspect the dedup-map key
   * shape; new code should use `w4aOriginKey` / `w4bOriginKey`.
   */
  private contentAliasKey(_sessionId: string, user: string, assistant: string): string {
    return this.w4aOriginKey(user, assistant);
  }

  /**
   * R17.1 — Hash a STRUCTURED encoding (not raw `:`-joined) so a literal
   * `:` inside any segment cannot let two distinct turns collide. The
   * raw-join form had the same delimiter-collision bug as `contentHash`:
   * `(sessionId="s:1", user="u")` and `(sessionId="s", user="1:u")` both
   * hashed to `"s:1:u:..."`. `JSON.stringify` quotes each segment.
   */
  private deterministicTurnId(sessionId: string, user: string, assistant: string, pairIndex?: number): string {
    const parts: unknown[] = [sessionId, user, assistant];
    if (typeof pairIndex === "number") parts.push(pairIndex);
    return createHash("sha256")
      .update(JSON.stringify(parts))
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * DKG-side session id from the typed-hook `ctx`. Channels like Telegram
   * can legitimately share a `sessionKey` across threads, so the id also
   * includes `accountId` + `conversationId` when the gateway provides
   * them. Missing discriminators fall back to empty strings, keeping the
   * id stable across paths for the same conversation — and matching
   * `deriveSessionIdFromEvent` for dedup.
   */
  private deriveSessionId(ctx?: any): string {
    if (!ctx || !ctx.channelId || !ctx.sessionKey) return "";
    return this.composeSessionId({
      channelId: ctx.channelId,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      sessionKey: ctx.sessionKey,
    });
  }

  /**
   * DKG-side session id for an internal message event. Uses the full
   * envelope (`channelId + accountId + conversationId + sessionKey`)
   * so threads that legitimately share a `sessionKey` on the same
   * channel still persist to distinct DKG sessions — and turns across
   * those threads can't be mis-dedup'd as duplicates.
   */
  private deriveSessionIdFromEvent(ev: InternalMessageEvent): string {
    const ctx = (ev as any)?.context ?? {};
    return this.composeSessionId({
      channelId: ctx.channelId ?? (ev as any)?.channelId,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      sessionKey: ev.sessionKey,
    });
  }

  /**
   * Per-field encoder used before joining session-id segments with `:`.
   * Without encoding, raw `channelId` / `accountId` / `conversationId` /
   * `sessionKey` values that legitimately contain `:` (e.g. OpenClaw's
   * own `agent:<agentId>:<identity>` session keys) collapse different
   * tuples to the same composed string and merge unrelated conversations'
   * watermarks and pending queues.
   *
   * Percent-encode `:` as `%3A` and `%` as `%25` (so the encoding is
   * reversible). Cheap, deterministic, no third-party dependency.
   */
  private encodeIdField(s: string): string {
    return String(s ?? "").replace(/[%:]/g, (c) => (c === '%' ? '%25' : '%3A'));
  }

  private composeSessionId(parts: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
  }): string {
    const channelId = parts.channelId ?? "unknown";
    const accountId = parts.accountId ?? "";
    const conversationId = parts.conversationId ?? "";
    const sessionKey = parts.sessionKey ?? "";
    const ids = [channelId, accountId, conversationId, sessionKey].map((p) =>
      this.encodeIdField(this.sanitize(String(p ?? ""))),
    );
    return `openclaw:${ids.join(":")}`;
  }

  /**
   * Pending-message lookup key. Must distinguish every in-flight conversation
   * the gateway is juggling, so it includes channel + account + conversation +
   * sessionKey. Two Telegram threads sharing a sessionKey still get separate
   * slots, preventing reply mis-pairing.
   */
  private conversationKeyFromInternalEvent(ev: InternalMessageEvent): string {
    if (!ev.sessionKey) {
      this.logger.warn?.("[ChatTurnWriter] No sessionKey in internal event");
      return "";
    }
    const ctx = (ev as any)?.context ?? {};
    return this.composeSessionId({
      channelId: ctx.channelId ?? (ev as any)?.channelId,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      sessionKey: ev.sessionKey,
    });
  }

  private extractText(content: string | Array<{ type: string; text?: string }>): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((part) => part.type === "text")
        .map((part) => part.text || "")
        .join(" ");
    }
    return "";
  }

  private loadWatermark(sessionId: string): number {
    return this.cachedWatermarks.get(sessionId) ?? -1;
  }

  /**
   * Advance the per-session watermark to `pairIndex` if (and only if) it
   * is greater than the current pending or persisted index. Centralizes
   * the "MAX of current and pairIndex" guard so the cross-path-skip path
   * (R14.1) and `persistOne` use identical advancement semantics.
   */
  private bumpWatermark(sessionId: string, pairIndex: number): void {
    const pending = this.debounceTimers.get(sessionId);
    const currentIndex = pending ? pending.pendingIndex : this.loadWatermark(sessionId);
    if (pairIndex > currentIndex) {
      this.saveWatermark(sessionId, pairIndex);
    }
  }

  private saveWatermark(sessionId: string, index: number): void {
    const existing = this.debounceTimers.get(sessionId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.cachedWatermarks.set(sessionId, index);
      this.writeWatermarkFile();
      this.debounceTimers.delete(sessionId);
    }, 50);
    this.debounceTimers.set(sessionId, { timer, pendingIndex: index });
  }

  private async persistOne(
    sessionId: string,
    user: string,
    assistant: string,
    turnId: string,
    opts?: { pairIndex?: number }
  ): Promise<void> {
    let attempt = 0;
    while (attempt < 2) {
      try {
        // `turnId` stays in-process only — used for our cross-path dedup
        // map (W4a vs W4b). It is intentionally NOT sent to the daemon:
        // the daemon mints a fresh UUID per call (`daemon/routes/openclaw.ts`
        // → `chat-memory.ts: turnUri = ${CHAT_NS}turn:${turnId}`), so
        // passing our content-derived turnId would let two real-world
        // identical exchanges in the same session collide on the same RDF
        // subject URI.
        await this.client.storeChatTurn(sessionId, user, assistant);
        // Watermark advance:
        //   - W4a passes `pairIndex` (the position of the persisted pair
        //     in the messages array). We set the watermark to MAX of
        //     current and pairIndex — absolute position, not increment.
        //     This way if W4a and W4b both fire for the same turn (cross-
        //     path race), the watermark stays at pairIndex regardless of
        //     order and never drifts past it.
        //   - W4b omits `pairIndex` entirely; it does not advance the
        //     watermark. The watermark is only meaningful for W4a's
        //     `computeDelta`, which scans `messages[]`. W4b operates on
        //     ad-hoc internal-hook events that have no pair semantics.
        if (typeof opts?.pairIndex === "number") {
          this.bumpWatermark(sessionId, opts.pairIndex);
        }
        this.logger.debug?.("[ChatTurnWriter] Persisted turn", { sessionId, turnId });
        return;
      } catch (err) {
        attempt++;
        if (attempt < 2) {
          // Single 250ms backoff retry for transient daemon hiccups.
          // Longer outages are recovered by the next-call mechanisms:
          // W4a backfills via `computeDelta` against an unchanged
          // watermark; W4b restores the consumed user message to the
          // front of the FIFO queue (R12.3 / R12.7) so the next
          // outbound re-pairs and retries. No need for a multi-rung
          // ladder here — a 1000ms ladder rung was previously coded
          // but unreachable because `attempt < 2` exits after the
          // first retry; collapsed to one explicit backoff to keep
          // the persistence policy clear (R-feedback).
          await new Promise((resolve) => setTimeout(resolve, 250));
        } else {
          throw err;
        }
      }
    }
  }

  private writeWatermarkFile(): void {
    try {
      const data = Object.fromEntries(this.cachedWatermarks);
      const tmpPath = `${this.watermarkFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.watermarkFilePath);
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter] Failed to write watermark file", { err });
    }
  }
}
