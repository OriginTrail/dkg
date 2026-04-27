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
      const job = this.trackPersistJob(sessionId, async () => {
        for (const { user, assistant } of pairs) {
          if (!user && !assistant) continue;
          const turnId = this.deterministicTurnId(sessionId, user, assistant);
          if (this.markTurnIdSeen(sessionId, turnId)) continue; // cross-path dedup
          try {
            await this.persistOne(sessionId, user, assistant, turnId);
          } catch (err) {
            // Release the reservation so a retry (next agent_end or the
            // paired internal hook) can re-attempt rather than silently
            // skipping this turn within the dedup window.
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
        const turnId = this.deterministicTurnId(sessionId, userText, assistantText);
        if (this.markTurnIdSeen(sessionId, turnId)) return; // already written via agent_end path
        // Route through the same tracked-job wrapper as onAgentEnd so the
        // reset gate sees this in-flight write and `Promise.allSettled`s
        // it. Without tracking, a `message:sent` write mid-compaction
        // could land its `saveWatermark()` after the reset clears state.
        this.trackPersistJob(sessionId, async () => {
          try {
            await this.persistOne(sessionId, userText, assistantText, turnId);
          } catch (err) {
            this.releaseTurnIdReservation(sessionId, turnId);
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
  ): Array<{ user: string; assistant: string }> {
    const pairs: Array<{ user: string; assistant: string }> = [];
    let currentUser = "";
    let pairIndex = 0;
    for (const msg of messages) {
      if (msg.role === "user") {
        currentUser = this.extractText(msg.content);
      } else if (msg.role === "assistant") {
        if (pairIndex > savedUpTo) {
          // Only strip `<recalled-memory>` from the assistant side. User text
          // is untouched — a user pasting XML/log content that happens to
          // contain the tag would otherwise be silently corrupted, while
          // only the assistant-side text can echo the system-injected block.
          pairs.push({
            user: currentUser,
            assistant: this.stripRecalledMemory(this.extractText(msg.content)),
          });
        }
        pairIndex++;
        currentUser = "";
      }
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

  private deterministicTurnId(sessionId: string, user: string, assistant: string): string {
    const combined = `${sessionId}:${user}:${assistant}`;
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
      this.sanitize(String(p ?? "")),
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
    const channelId = ctx.channelId ?? (ev as any)?.channelId ?? "unknown";
    const accountId = ctx.accountId ?? "";
    const conversationId = ctx.conversationId ?? "";
    const parts = [channelId, accountId, conversationId, ev.sessionKey].map((p) =>
      this.sanitize(String(p ?? "")),
    );
    return `openclaw:${parts.join(":")}`;
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
    turnId: string
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
        // Prefer the pending debounced index (in-flight increments not yet
        // committed to cachedWatermarks) so two persists inside the 50ms
        // debounce window each advance the watermark instead of both
        // computing the same cached+1. Without this, a restart after a
        // burst would re-persist every turn past the first as a "delta".
        const pending = this.debounceTimers.get(sessionId);
        const currentIndex = pending ? pending.pendingIndex : this.loadWatermark(sessionId);
        this.saveWatermark(sessionId, currentIndex + 1);
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
