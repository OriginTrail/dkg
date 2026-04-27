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
  // The TTL is intentionally short (3s). Cross-path double-fire happens in
  // the same delivery cycle — typically milliseconds between `agent_end` and
  // `message:sent`. A longer TTL would silently drop two legitimate real
  // turns in a short window whose text happens to be identical.
  private recentTurnIds: Map<string, number> = new Map();
  private static readonly TURNID_TTL_MS = 3_000;
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
      const pairs = this.computeDelta(event.messages, this.loadWatermark(sessionId));
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
          if (i === lastIdx) {
            const w4bOrigin = this.w4bOriginKey(user, assistant);
            if (this.markTurnIdSeen(sessionId, w4bOrigin)) continue; // W4b wrote it
          }
          if (this.markTurnIdSeen(sessionId, turnId)) continue;
          try {
            await this.persistOne(sessionId, user, assistant, turnId, { pairIndex });
            // Stamp W4a-origin so a same-cycle W4b fire dedups.
            this.markTurnIdSeen(sessionId, this.w4aOriginKey(user, assistant));
          } catch (err) {
            // Release reservations so a retry (next agent_end or the
            // paired internal hook) can re-attempt. The last-pair w4b
            // origin reservation MUST also be released — without it,
            // the next agent_end's last pair would falsely dedup
            // against the stale reservation and silently skip the turn.
            this.releaseTurnIdReservation(sessionId, turnId);
            if (i === lastIdx) {
              this.releaseTurnIdReservation(sessionId, this.w4bOriginKey(user, assistant));
            }
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
      // Drop failed outbound sends: chat history should not show replies the
      // user never received. Still consume the oldest pending inbound so the
      // next successful turn does not pair its reply with a stale inbound
      // from the aborted exchange.
      const success = (ev as any)?.context?.success ?? (ev as any)?.success;
      const queue = this.pendingUserMessages.get(conversationKey);
      const userText = queue && queue.length > 0 ? queue.shift()! : "";
      if (queue && queue.length === 0) this.pendingUserMessages.delete(conversationKey);
      if (success === false) return;
      // Strip injected `<recalled-memory>` from assistant text — the model may
      // echo the auto-recall block, and if we persist the raw version here
      // while the W4a path persists the stripped version, the two turnIds
      // diverge and cross-path dedup misses. User text is NOT stripped:
      // legitimate pastes (XML, logs) containing the tag would otherwise be
      // silently corrupted.
      const assistantText = this.stripRecalledMemory(readEventText(ev));
      if (userText || assistantText) {
        // Cross-path dedup, W4b side: check the W4a-origin key — if
        // `agent_end` already wrote this turn within the TTL window,
        // skip. Then reserve the W4b-origin key (atomic mark) so a
        // later `agent_end` whose LAST pair has the same content sees
        // it and skips. Symmetric across paths regardless of order.
        const w4aOrigin = this.w4aOriginKey(userText, assistantText);
        if (this.markTurnIdSeen(sessionId, w4aOrigin)) return; // W4a already wrote
        const w4bOrigin = this.w4bOriginKey(userText, assistantText);
        this.markTurnIdSeen(sessionId, w4bOrigin); // reserve for W4a's last-pair check
        const turnId = this.deterministicTurnId(sessionId, userText, assistantText);
        // Route through the same tracked-job wrapper as onAgentEnd so the
        // reset gate sees this in-flight write and `Promise.allSettled`s
        // it. Without tracking, a `message:sent` write mid-compaction
        // could land its `saveWatermark()` after the reset clears state.
        this.trackPersistJob(sessionId, async () => {
          try {
            await this.persistOne(sessionId, userText, assistantText, turnId);
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
            // Release both origin keys so the retry path can proceed.
            this.releaseTurnIdReservation(sessionId, this.w4bOriginKey(userText, assistantText));
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
   */
  async flush(): Promise<void> {
    const allJobs: Promise<void>[] = [];
    for (const bucket of this.inFlightPersists.values()) {
      for (const j of bucket) allJobs.push(j);
    }
    for (const reset of this.pendingResets.values()) {
      allJobs.push(reset);
    }
    if (allJobs.length > 0) await Promise.allSettled(allJobs);
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
    let currentUser = "";
    let pairIndex = 0;
    for (const msg of messages) {
      if (msg.role === "user") {
        currentUser = this.extractText(msg.content);
      } else if (msg.role === "assistant") {
        // Skip intermediate assistant messages that exist solely to call
        // tools — they have empty/absent text content and a populated
        // `toolCalls` / `tool_calls` array. A tool-using turn looks like
        // [user, assistant(tool_call), tool, assistant(final_reply)];
        // without this skip, computeDelta would emit two pairs (one
        // empty-reply, one empty-user-final-reply), and W4b's later
        // `message:sent` would fail to dedup because the content hashes
        // diverge from the canonical (user, final-reply) pair.
        const text = this.extractText(msg.content);
        const hasToolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls.length > 0
          : Array.isArray(msg.tool_calls) ? msg.tool_calls.length > 0
          : false;
        if (!text && hasToolCalls) {
          // Intermediate tool-call step — do NOT count as a pair, do NOT
          // advance pairIndex (the watermark counts user-visible turns).
          continue;
        }
        if (pairIndex > savedUpTo) {
          pairs.push({
            user: currentUser,
            assistant: this.stripRecalledMemory(text),
            pairIndex,
          });
        }
        pairIndex++;
        currentUser = "";
      }
      // Skip `tool` and `system` messages — they don't form turns.
    }
    return pairs;
  }

  /**
   * Strip `<recalled-memory>` blocks from assistant text before persistence.
   * Prevents the per-turn auto-recall block from boomeranging into future
   * turn queries if the model verbatim-quotes system-context. Handles:
   *   - well-formed `<recalled-memory>...</recalled-memory>` (any attrs, case-insensitive)
   *   - orphaned open tag at end-of-text (truncated model output)
   * The tag shape is load-bearing — keep in sync with
   * `formatRecalledMemoryBlock` in DkgNodePlugin.ts.
   */
  private stripRecalledMemory(text: string): string {
    if (!text) return "";
    // (a) well-formed pairs
    let out = text.replace(
      /<recalled-memory(\s[^>]*)?>[\s\S]*?<\/recalled-memory>/gi,
      "",
    );
    // (b) orphaned open tag → strip from open-tag to end-of-string
    out = out.replace(/<recalled-memory(\s[^>]*)?>[\s\S]*$/i, "");
    return out.trim();
  }

  private sanitize(part: string): string {
    return part.replace(/[\x00-\x1f\x7f]/g, "").substring(0, 64);
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
  private contentHash(user: string, assistant: string): string {
    return createHash("sha256").update(`${user}:${assistant}`).digest("hex").slice(0, 16);
  }
  private w4aOriginKey(user: string, assistant: string): string {
    return `w4a-content::${this.contentHash(user, assistant)}`;
  }
  private w4bOriginKey(user: string, assistant: string): string {
    return `w4b-content::${this.contentHash(user, assistant)}`;
  }
  /**
   * @deprecated Kept temporarily for tests that inspect the dedup-map key
   * shape; new code should use `w4aOriginKey` / `w4bOriginKey`.
   */
  private contentAliasKey(_sessionId: string, user: string, assistant: string): string {
    return this.w4aOriginKey(user, assistant);
  }

  private deterministicTurnId(sessionId: string, user: string, assistant: string, pairIndex?: number): string {
    const indexPart = typeof pairIndex === "number" ? `:${pairIndex}` : "";
    const combined = `${sessionId}:${user}:${assistant}${indexPart}`;
    return createHash("sha256").update(combined).digest("hex").slice(0, 16);
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
          const pending = this.debounceTimers.get(sessionId);
          const currentIndex = pending ? pending.pendingIndex : this.loadWatermark(sessionId);
          if (opts.pairIndex > currentIndex) {
            this.saveWatermark(sessionId, opts.pairIndex);
          }
        }
        this.logger.debug?.("[ChatTurnWriter] Persisted turn", { sessionId, turnId });
        return;
      } catch (err) {
        attempt++;
        if (attempt < 2) {
          const backoff = attempt === 1 ? 250 : 1000;
          await new Promise((resolve) => setTimeout(resolve, backoff));
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
