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

export interface InternalMessageEvent {
  sessionKey: string;
  direction: "inbound" | "outbound";
  text: string;
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
  // across paths, so the second persist would be a duplicate write. Daemon
  // does not dedup (ADR-002), so we gate here before calling storeChatTurn.
  private recentTurnIds: Map<string, number> = new Map();
  private static readonly TURNID_TTL_MS = 60_000;

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

  onAgentEnd(event: AgentEndContext, ctx?: any): void {
    try {
      // B5 — skip dkg-ui channel; DkgChannelPlugin.queueTurnPersistence
      // owns UI-channel persistence with richer metadata (correlation IDs,
      // attachment refs). Avoids double-persist under different sessionIds.
      if (ctx?.channelId === "dkg-ui") return;
      const sessionId = this.deriveSessionId(ctx);
      if (!sessionId) return;
      const pairs = this.computeDelta(event.messages, this.loadWatermark(sessionId));
      if (pairs.length === 0) return;
      // Persist sequentially so a transient failure on pair N leaves the
      // watermark at N-1 and the next agent_end call retries from the same
      // point. Without sequencing, a failed middle pair could be skipped
      // when the tail succeeds.
      (async () => {
        for (const { user, assistant } of pairs) {
          if (!user && !assistant) continue;
          const turnId = this.deterministicTurnId(sessionId, user, assistant);
          if (this.markTurnIdSeen(turnId)) continue; // cross-path dedup
          try {
            await this.persistOne(sessionId, user, assistant, turnId);
          } catch (err) {
            // Release the reservation so a retry (next agent_end or the
            // paired internal hook) can re-attempt rather than silently
            // skipping this turn for 60s.
            this.releaseTurnIdReservation(turnId);
            this.logger.error?.("[ChatTurnWriter.onAgentEnd] Persist failed", { err });
            return; // leave watermark at last successful pair
          }
        }
      })().catch(() => {
        /* outer try-catch already covered; here only to satisfy floating-promise */
      });
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onAgentEnd] Error", { err });
    }
  }

  onBeforeCompaction(event: any, ctx?: any): void {
    try { this.flushSync(); } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onBeforeCompaction] Error", { err });
    }
  }

  onBeforeReset(event: any, ctx?: any): void {
    try { this.flushSync(); } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onBeforeReset] Error", { err });
    }
  }

  onMessageReceived(ev: InternalMessageEvent): void {
    try {
      // B5 — skip dkg-ui channel; DkgChannelPlugin owns UI persistence.
      const channelId = (ev as any)?.context?.channelId ?? (ev as any)?.channelId;
      if (channelId === "dkg-ui") return;
      const conversationKey = this.conversationKeyFromInternalEvent(ev);
      if (!conversationKey) return;
      const queue = this.pendingUserMessages.get(conversationKey) ?? [];
      queue.push(ev.text);
      this.pendingUserMessages.set(conversationKey, queue);
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onMessageReceived] Error", { err });
    }
  }

  onMessageSent(ev: InternalMessageEvent): void {
    try {
      // B5 — skip dkg-ui channel; DkgChannelPlugin owns UI persistence.
      // Internal-hook envelope carries channelId on event.context per
      // openclaw/src/infra/outbound/deliver.ts.
      const channelId = (ev as any)?.context?.channelId ?? (ev as any)?.channelId;
      if (channelId === "dkg-ui") return;
      const conversationKey = this.conversationKeyFromInternalEvent(ev);
      if (!conversationKey) return;
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
      const assistantText = this.stripRecalledMemory(ev.text);
      const sessionId = this.deriveSessionIdFromEvent(ev);
      if (userText || assistantText) {
        const turnId = this.deterministicTurnId(sessionId, userText, assistantText);
        if (this.markTurnIdSeen(turnId)) return; // already written via agent_end path
        this.persistOne(sessionId, userText, assistantText, turnId).catch((err) => {
          this.releaseTurnIdReservation(turnId);
          this.logger.error?.("[ChatTurnWriter.onMessageSent] Persist failed", { err });
        });
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
  private markTurnIdSeen(turnId: string): boolean {
    const now = Date.now();
    const ttl = ChatTurnWriter.TURNID_TTL_MS;
    for (const [id, ts] of this.recentTurnIds) {
      if (now - ts > ttl) this.recentTurnIds.delete(id);
    }
    if (this.recentTurnIds.has(turnId)) return true;
    this.recentTurnIds.set(turnId, now);
    return false;
  }

  /** Release a turnId reservation on persist failure so retries can proceed. */
  private releaseTurnIdReservation(turnId: string): void {
    this.recentTurnIds.delete(turnId);
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
        await this.client.storeChatTurn(sessionId, user, assistant, { turnId });
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
