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
  // T4 — Per-session promise chain for `onAgentEnd`. Without this,
  // two back-to-back `agent_end` fires for the same session can overlap
  // (the inner `trackPersistJob` is fire-and-forget). The later fire
  // sees the earlier fire's pair-N reservation in `recentTurnIds` →
  // `continue` (no bump) → moves on to pair N+1, persists, advances
  // the watermark. If the earlier fire then fails on pair N, releasing
  // its reservation, the watermark is already at N+1 and the next
  // `agent_end`'s `computeDelta` from N+1 never re-yields pair N.
  // Silent data loss. Chaining ensures each fire's `computeDelta` reads
  // the previous fire's settled watermark.
  private w4aSessionChains: Map<string, Promise<void>> = new Map();
  // T5 — Cross-path stamps (`w4aOriginKey`, `w4bOriginKey`) need a
  // SHORTER lifetime than the pair-indexed `recentTurnIds`. The 60s
  // `TURNID_TTL_MS` is right for in-flight reservations (where the
  // pairIndex / messageId discriminator prevents same-content
  // collisions), but content-only cross-path stamps with 60s TTL
  // false-dedup repeated same-content turns: Turn 1's `w4aOrigin "ok"`
  // would still be live when Turn 2's W4b peeks → W4b skips Turn 2 →
  // if Turn 2's W4a then fails, the turn is dropped.
  //
  // Holding stamps for ~5s covers normal-channel `agent_end →
  // message:sent` gaps (~50-200ms typical) and even queued-Telegram-
  // retry timing (~1-3s observed). Slow channels with >5s gaps now
  // miss the cross-path dedup → both paths persist → daemon writes a
  // duplicate turn record. That's a cosmetic dup vs the data-loss
  // failure mode T5 flagged; we accept the cosmetic cost as the
  // lesser evil.
  private crossPathStamps: Map<string, number> = new Map();
  private static readonly CROSS_PATH_TTL_MS = 5_000;
  // T10 — Cross-path IN-FLIGHT reservations. Distinct from
  // `crossPathStamps` (post-success) because the opposite path needs
  // to skip during the window BETWEEN persistOne entry and the
  // post-success stamp landing — without this, two paths racing on
  // the same content can both enter `persistOne` and the daemon
  // mints two distinct turn records (it does NOT dedup on our
  // in-process content turnId; see `persistOne` doc comment).
  // Stamped pre-persist, cleared in `finally` (success OR failure)
  // so a failed path doesn't leak a permanent reservation.
  // Defensive 60s timestamp eviction backstops a missed `finally`
  // (e.g. an unhandled throw outside the wrapped try/catch).
  private crossPathInflight: Map<string, number> = new Map();
  private static readonly CROSS_PATH_INFLIGHT_TTL_MS = 60_000;

  constructor(options: { client: any; logger: Logger; stateDir: string }) {
    this.client = options.client;
    this.logger = options.logger;
    this.stateDir = options.stateDir;
    this.watermarkFilePath = path.join(this.stateDir, "dkg-adapter", "chat-turn-watermarks.json");
    this.initFromFile();
  }

  /**
   * T18/T21/T22 — Migrate this writer to a new stateDir without losing
   * in-flight work or rolling back newer state at the destination.
   *
   * Steps (in order):
   *   1. `await flush()` — drain in-flight persists, pending resets,
   *      and per-session agent_end chains so we have a stable
   *      in-memory snapshot at the OLD path. T21 regression fix:
   *      pre-fix the migration used `flushSync()`, which only wrote
   *      the debounced watermark and missed in-flight `storeChatTurn`
   *      jobs that completed after the swap.
   *   2. Read the destination watermark file (if any) and MERGE
   *      per-session via max(w) and max(b). T22 regression fix:
   *      pre-fix unconditionally overwrote the destination, which
   *      rolled back newer state from a prior run at the workspace
   *      path. The destination file's session keys may also reference
   *      conversations this process never touched — those are
   *      preserved unchanged.
   *   3. Update internal paths atomically.
   *   4. Write the merged state to the new location.
   *   5. Best-effort delete the old file so a future fallback resolve
   *      doesn't repopulate from stale data.
   */
  async setStateDir(newStateDir: string): Promise<void> {
    if (newStateDir === this.stateDir) return;
    const newWatermarkFilePath = path.join(
      newStateDir, "dkg-adapter", "chat-turn-watermarks.json",
    );
    if (newWatermarkFilePath === this.watermarkFilePath) return;
    // Drain in-flight work BEFORE we touch any state. flush() awaits
    // all outstanding persists/resets/chains — we must capture their
    // effects before swapping paths.
    await this.flush();
    // T43 — Merge into TEMPORARY snapshots first; only commit to the
    // live `this.cachedWatermarks` / `this.w4bSessionCounts` after the
    // write to the new path succeeds. Pre-fix order was:
    //   (a) merge directly into live maps,
    //   (b) attempt write,
    //   (c) on failure, keep old paths.
    // That left the in-memory state polluted with destination's
    // watermarks even when the write failed. Concrete failure path:
    // unpersisted pair at idx 5 in old session, destination file's
    // same session at idx 7 (newer process or stale state) → merge
    // pushes live watermark to 7 → new-path write fails (e.g. disk
    // full) → writer keeps old path → next persist treats turn at
    // idx 6 as already saved (6 < 7) and silently drops it.
    //
    // Snapshot live state, mutate live maps for the write (so
    // `writeWatermarkFile` sees the merged data without a separate
    // override channel), restore from snapshot on failure.
    const wmSnapshot = new Map(this.cachedWatermarks);
    const bcSnapshot = new Map(this.w4bSessionCounts);
    try {
      if (fs.existsSync(newWatermarkFilePath)) {
        const raw = fs.readFileSync(newWatermarkFilePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          for (const [key, val] of Object.entries(parsed)) {
            let w = -1, b = 0;
            if (typeof val === "number") {
              w = val;
            } else if (val && typeof val === "object") {
              const obj = val as { w?: unknown; b?: unknown };
              if (typeof obj.w === "number") w = obj.w;
              if (typeof obj.b === "number") b = obj.b;
            }
            this.cachedWatermarks.set(
              key,
              Math.max(this.cachedWatermarks.get(key) ?? -1, w),
            );
            this.w4bSessionCounts.set(
              key,
              Math.max(this.w4bSessionCounts.get(key) ?? 0, b),
            );
          }
        }
      }
    } catch (err) {
      this.logger.warn?.("[ChatTurnWriter.setStateDir] Failed to merge destination file; proceeding with current state", { err });
    }
    // T27 — Write to the NEW path FIRST; only swap internal state on
    // confirmed success. Pre-fix the swap happened pre-write, so a
    // failed write left `this.stateDir` / `this.watermarkFilePath`
    // already pointing at the (broken) new location. The next
    // `setStateDir(newStateDir)` retry would short-circuit on the
    // same-path guard and never re-attempt the write — the writer
    // stayed permanently pinned to a path with no valid file.
    let wrote = false;
    try {
      const newDir = path.dirname(newWatermarkFilePath);
      if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
      wrote = this.writeWatermarkFile(newWatermarkFilePath);
    } catch (err) {
      // T23 — Surface BOTH mkdirSync failures (ENOTDIR / ENOENT on
      // an unwritable parent) AND writeWatermarkFile failures
      // through the same `wrote` boolean.
      this.logger.error?.(
        "[ChatTurnWriter.setStateDir] Failed to write watermark file at new path",
        { err, newWatermarkFilePath },
      );
      wrote = false;
    }
    if (!wrote) {
      // T43 — Restore the pre-merge in-memory state. Without this,
      // the live maps remain polluted with destination's watermarks
      // and turns can be incorrectly skipped on subsequent persists.
      this.cachedWatermarks = wmSnapshot;
      this.w4bSessionCounts = bcSnapshot;
    }
    if (wrote) {
      // Only NOW commit the swap. Subsequent normal writes via
      // `writeWatermarkFile()` (no explicit target) will hit the new
      // path.
      //
      // T35 — DO NOT unlink the old file. The old path is typically
      // the home-dir fallback (`~/.openclaw/dkg-adapter/...`), which
      // is potentially shared with OTHER writer processes that haven't
      // migrated yet (any process whose `runtime.state.resolveStateDir()`
      // / `OPENCLAW_STATE_DIR` / `api.workspaceDir` are all unavailable
      // falls back there). Deleting the shared file would silently wipe
      // those other processes' watermark state on their next disk read,
      // causing W4a backfill replays. Operators can clean up orphaned
      // fallback files manually after confirming no live process still
      // depends on them.
      this.stateDir = newStateDir;
      this.watermarkFilePath = newWatermarkFilePath;
    } else {
      // T23/T27 — Internal state stays at the OLD path so a future
      // setStateDir(newStateDir) retry re-attempts the write. The
      // old file is also preserved as a recovery source.
      this.logger.warn?.(
        "[ChatTurnWriter.setStateDir] Migration to new path failed; preserving old path and file. A future register() with the same target will retry.",
        { oldStateDir: this.stateDir, attemptedNewStateDir: newStateDir },
      );
    }
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
            // T17 — Two formats supported for backward compat:
            //   * Number `5`             → legacy: watermark only
            //   * Object `{ w: 5, b: 3 }` → watermark + W4b session count
            // Preserving w4bCount across restarts is load-bearing: in
            // setup-runtime mode only W4b runs, so a process restart
            // mid-conversation would otherwise reset the count to 0
            // while the watermark file is still -1, and the next
            // `agent_end` would re-emit every W4b-persisted pair as
            // backfill — daemon-side duplicate writes.
            if (typeof val === "number") {
              this.cachedWatermarks.set(key, val);
            } else if (val && typeof val === "object") {
              const obj = val as { w?: unknown; b?: unknown };
              if (typeof obj.w === "number") {
                this.cachedWatermarks.set(key, obj.w);
              }
              if (typeof obj.b === "number") {
                this.w4bSessionCounts.set(key, obj.b);
              }
            }
          }
        }
      }
    } catch (err) {
      this.logger.warn?.("[ChatTurnWriter] Failed to load watermarks, starting fresh", { err });
    }
  }

  async onAgentEnd(event: AgentEndContext, ctx?: any): Promise<void> {
    // B5 — skip dkg-ui channel; DkgChannelPlugin.queueTurnPersistence
    // owns UI-channel persistence with richer metadata (correlation IDs,
    // attachment refs). Avoids double-persist under different sessionIds.
    if (ctx?.channelId === "dkg-ui") return;
    const sessionId = this.deriveSessionId(ctx);
    if (!sessionId) return;
    // T4 — Serialize agent_end calls per session via a Promise chain.
    // The full computeDelta + per-pair persist loop runs INSIDE the
    // chain so a later fire's `computeDelta` reads the earlier fire's
    // settled watermark. Without this, concurrent fire-and-forget
    // persists race the per-pair turnId reservation and can drop
    // failed earlier pairs (see comment on `w4aSessionChains`).
    //
    // Crucially, this method does NOT `await` the chain — the gateway
    // must not block on disk/network (per R19.2). The chain alone
    // ensures the NEXT fire's work runs only after this fire's work
    // settles. `flush()` still drains the persist via `inFlightPersists`
    // tracked inside `runAgentEndPersist` → `trackPersistJob`.
    const previous = this.w4aSessionChains.get(sessionId) ?? Promise.resolve();
    const work = previous
      // Never block the next fire on the previous fire's failure.
      .catch(() => undefined)
      .then(() => this.runAgentEndPersist(event, sessionId));
    this.w4aSessionChains.set(sessionId, work);
    work.finally(() => {
      // Cleanup so idle sessions don't accumulate empty chains. Only
      // delete if our work is still the head — a newer fire may have
      // already replaced us.
      if (this.w4aSessionChains.get(sessionId) === work) {
        this.w4aSessionChains.delete(sessionId);
      }
    }).catch(() => undefined);
    // Fire-and-forget from the gateway's perspective. The chain serialises
    // ordering; flush() drains via inFlightPersists.
  }

  private async runAgentEndPersist(event: AgentEndContext, sessionId: string): Promise<void> {
    try {
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
            if (this.peekCrossPathStamp(sessionId, w4bOrigin)) {
              // W4b already persisted this pair via `message:sent`. The
              // pair is logically saved, so advance the watermark to its
              // index — without this, a later `agent_end` (after the
              // dedup TTL has expired) would re-pair the same pair as
              // unsaved backfill and write a duplicate (R14.1).
              // T16 — Consume the stamp so a future same-content turn
              // within the 5s window doesn't false-hit on W4b's stale
              // stamp. The watermark advance below provides the
              // independent backfill guard for THIS pair.
              this.consumeCrossPathStamp(sessionId, w4bOrigin);
              this.bumpWatermark(sessionId, pairIndex);
              continue;
            }
            // T10 — Cross-path in-flight check. If W4b is mid-persist
            // for this same pair (between persistOne entry and the
            // post-success stamp landing), skip WITHOUT advancing the
            // watermark. If W4b ultimately succeeds, the bumped
            // `w4bSessionCount` raises `savedUpTo` on the next
            // `agent_end` so this pair is excluded from `computeDelta`.
            // If W4b fails, it restores the user message to the queue
            // and a future outbound re-pairs; the unchanged watermark
            // means the next `agent_end` will re-yield this pair as
            // backfill (correct retry behavior).
            if (this.peekCrossPathInflight(sessionId, w4bOrigin)) {
              continue;
            }
          }
          if (this.markTurnIdSeen(sessionId, turnId)) continue;
          // T10 — Reserve cross-path in-flight on W4a-origin BEFORE
          // persistOne so a concurrent W4b fire's `peekCrossPathInflight`
          // catches the race. Only the LAST pair can plausibly race
          // with W4b (earlier pairs are historical backfill). Cleared
          // in `finally` so a failure doesn't leak the reservation.
          const w4aInflightKey = i === lastIdx ? this.w4aOriginKey(user, assistant) : null;
          if (w4aInflightKey) this.markCrossPathInflight(sessionId, w4aInflightKey);
          try {
            await this.persistOne(sessionId, user, assistant, turnId, { pairIndex });
            // Stamp W4a-origin so a same-cycle W4b fire dedups. Uses the
            // short-TTL cross-path map (T5) so a repeated same-content
            // turn outside the cross-path window doesn't false-dedup.
            this.markCrossPathStamp(sessionId, this.w4aOriginKey(user, assistant));
          } catch (err) {
            // Release the turnId reservation so a retry can re-attempt.
            // No w4b-origin release needed — W4a's last-pair check is
            // now a non-mutating peek (R13.1), so W4a never reserved it.
            this.releaseTurnIdReservation(sessionId, turnId);
            this.logger.error?.("[ChatTurnWriter.onAgentEnd] Persist failed", { err });
            if (w4aInflightKey) this.unmarkCrossPathInflight(sessionId, w4aInflightKey);
            return; // leave watermark at last successful pair
          }
          if (w4aInflightKey) this.unmarkCrossPathInflight(sessionId, w4aInflightKey);
        }
      });
      // T4 — AWAIT the persist job so the per-session chain in
      // `onAgentEnd` waits for completion. Concurrent `agent_end` fires
      // for the same session would otherwise race the per-pair turnId
      // reservations and silently drop a failed earlier pair when a
      // later fire advances the watermark past it. The previous
      // fire-and-forget pattern was safe in isolation (single fire) but
      // not under realistic gateway-driven concurrency.
      await job.catch(() => { /* outer try-catch already covered */ });
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
    // T4 — Drain any queued (but not yet started) agent_end chain
    // work BEFORE registering this reset in `pendingResets`. The
    // chain's `.then(() => runAgentEndPersist(...))` delays
    // `trackPersistJob` registration by one microtask, so a chained-
    // but-not-yet-running fire wouldn't appear in `inFlightPersists`
    // (which `resetSessionState` awaits). Critically, this drain
    // happens BEFORE `pendingResets.set` — otherwise the chained
    // `runAgentEndPersist` would see our pending reset, await it,
    // and deadlock against itself. Draining first lets the chained
    // work see no-pending-reset and run with the pre-compaction
    // state; the reset then wipes after the work completes.
    const chain = this.w4aSessionChains.get(sessionId);
    if (chain) {
      await chain.catch(() => undefined);
    }
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
    this.w4aSessionChains.delete(sessionId);
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
      // user never received. Consume the SAME set of pending inbounds that
      // a successful send would have collapsed into one user-side, so the
      // next REAL textual outbound for this conversation does not pair
      // its reply with stale inbounds from the aborted exchange.
      // T19 — Pre-fix this path shifted only the OLDEST pending message.
      // After T15 the success path drains the WHOLE queue (joined into
      // one logical user-side), so leaving siblings queued on failure
      // makes them get mis-paired with the next unrelated reply. Delete
      // the whole queue here to match the success consumption.
      if (success === false) {
        this.pendingUserMessages.delete(conversationKey);
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
      // T15 — Collapse the ENTIRE pending queue into one user-side,
      // matching `computeDelta`'s pendingUsers join semantics. If a
      // user sends `u1` then `u2` before the agent fires, both belong
      // to the same logical turn (one assistant reply addresses both).
      // Pre-fix, W4b shifted only the oldest, leaving `u2` queued —
      // it would then be wrongly paired with the NEXT outbound, OR
      // (in setup-runtime, where W4a doesn't run) silently never
      // persist. The collapsed user-side also makes the W4a-stamped
      // `crossPathStamps[w4aOrigin]` content key match what W4b
      // computes here, so cross-path dedup stays symmetric.
      // Snapshot before consuming so the persist-failure restore
      // path below can re-queue the ORIGINAL items (not the joined
      // string), preserving structure if a later inbound arrives
      // before the retry.
      const queuedItems = [...queue];
      const userText = queuedItems.join("\n");
      this.pendingUserMessages.delete(conversationKey);
      if (userText || assistantText) {
        // Cross-path dedup, W4b side (T5: short-TTL stamp map):
        //   PEEK w4a-origin — non-mutating; if W4a already wrote this
        //   turn within the cross-path TTL window (5s), skip. The
        //   short window means a repeated same-content turn fired
        //   later won't collide with the previous turn's stamp.
        const w4aOrigin = this.w4aOriginKey(userText, assistantText);
        if (this.peekCrossPathStamp(sessionId, w4aOrigin)) {
          // T16 — Consume the stamp so a future same-content turn
          // within the 5s window doesn't false-hit on W4a's stale
          // stamp (which would make W4b drop turn 2's items even
          // though W4a never persisted turn 2). Narrows the data-
          // loss window from "any 5s same-content turn" to "5s
          // same-content turn where W4a fired for turn 1 but skipped
          // turn 2" — much rarer in practice.
          this.consumeCrossPathStamp(sessionId, w4aOrigin);
          return; // W4a already wrote
        }
        // T10 — Cross-path in-flight check. If W4a is mid-persist for
        // this pair, skip; W4a will own the persist. We've already
        // consumed the pending user above (line 508), which is correct
        // because W4a IS persisting it.
        if (this.peekCrossPathInflight(sessionId, w4aOrigin)) return;
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
        // T33 — Mix the gateway-provided `messageId` (or the
        // monotonic fallback) into the daemon-facing turnId so
        // restarts after a successful POST find the SAME RDF
        // subject URI on the daemon and overwrite-idempotently
        // instead of duplicating the turn. messageId is durable
        // (the gateway's outbound log persists it), so this hash
        // is stable across process boundaries. Two LEGITIMATE same-
        // content turns within a session still get distinct ids
        // because their messageIds differ.
        const w4bDiscriminator = this.w4bDaemonTurnIdDiscriminator(ev);
        const turnId = this.deterministicTurnId(sessionId, userText, assistantText, w4bDiscriminator);
        // T10 — Reserve cross-path in-flight on W4b-origin BEFORE
        // persistOne so a concurrent W4a `agent_end` fire's
        // `peekCrossPathInflight` catches the race and skips. Cleared
        // in `finally` below regardless of outcome.
        const w4bOriginKey = this.w4bOriginKey(userText, assistantText);
        this.markCrossPathInflight(sessionId, w4bOriginKey);
        // Route through the same tracked-job wrapper as onAgentEnd so the
        // reset gate sees this in-flight write and `Promise.allSettled`s
        // it. Without tracking, a `message:sent` write mid-compaction
        // could land its `saveWatermark()` after the reset clears state.
        this.trackPersistJob(sessionId, async () => {
          try {
            await this.persistOne(sessionId, userText, assistantText, turnId);
            // Post-success: stamp the content-only `w4bOrigin` key on
            // the SHORT-TTL cross-path map (T5) so a later W4a
            // `agent_end` last-pair peek can see that W4b already
            // persisted THIS turn and skip + bumpWatermark, but a
            // repeated same-content turn arriving outside the 5s
            // cross-path window doesn't false-dedup against this stamp.
            this.markCrossPathStamp(sessionId, this.w4bOriginKey(userText, assistantText));
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
              // T17 — Persist the new count to disk via the
              // debounced flush so a process restart preserves
              // the "skip these pairs in computeDelta" floor.
              // Without this, setup-runtime → restart → upgrade
              // to full would replay every W4b-persisted turn as
              // backfill (count resets to 0, watermark file is
              // still -1, savedUpTo computes to -1, computeDelta
              // emits everything).
              this.scheduleWatermarkFlush(sessionId);
            }
          } catch (err) {
            // W4b is the ONLY path with a copy of `userText` (it lives
            // ephemerally in the FIFO queue). On a hard persist failure
            // there's no `agent_end` backfill — the messages array doesn't
            // exist for non-LLM channels. Push the consumed user messages
            // back to the FRONT of the queue so the next outbound delivery
            // for this conversation re-pairs and retries. Without this,
            // a transient daemon outage would silently drop the turn.
            // T15 — Restore the ORIGINAL queue items (not the joined
            // `userText` string) so a later inbound that arrives between
            // the failure and the next outbound queues normally — the
            // next outbound will collapse the full queue (old items +
            // new) into one user-side, matching W4a's pairing.
            if (queuedItems.length > 0) {
              const restored = this.pendingUserMessages.get(conversationKey) ?? [];
              restored.unshift(...queuedItems);
              this.pendingUserMessages.set(conversationKey, restored);
            }
            // Release the in-flight reservation so a retry can proceed.
            // No `w4bOrigin` release needed — we don't stamp it pre-persist
            // anymore; only stamping happens post-success above.
            this.releaseTurnIdReservation(sessionId, w4bInflight);
            this.logger.error?.("[ChatTurnWriter.onMessageSent] Persist failed", { err });
          } finally {
            // T10 — Always release the cross-path in-flight reservation,
            // success OR failure. On success the post-success stamp at
            // `crossPathStamps` (markCrossPathStamp above) covers the
            // 5s post-success window; on failure the reservation must
            // not leak to block legitimate later same-content turns.
            this.unmarkCrossPathInflight(sessionId, w4bOriginKey);
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

  /**
   * T5 — Set semantics on the SHORT-TTL cross-path map. Used for
   * `w4aOrigin` / `w4bOrigin` content-only stamps. Lifetime is
   * `CROSS_PATH_TTL_MS` (5s) — long enough for the opposite path to
   * fire on the same logical turn, short enough that a repeated same-
   * content turn outside the window doesn't false-dedup.
   * Opportunistic eviction prevents unbounded growth.
   */
  private markCrossPathStamp(sessionId: string, key: string): void {
    const compositeKey = this.dedupKey(sessionId, key);
    const now = Date.now();
    const ttl = ChatTurnWriter.CROSS_PATH_TTL_MS;
    for (const [k, ts] of this.crossPathStamps) {
      if (now - ts > ttl) this.crossPathStamps.delete(k);
    }
    this.crossPathStamps.set(compositeKey, now);
  }

  /**
   * T16 — Consume a cross-path stamp after a successful peek-hit.
   * The 5s TTL is generous to cover slow channels, but a content-only
   * stamp left in place can false-dedup a legitimate same-content
   * turn that arrives within the window. Consuming on peek-hit
   * narrows the false-dedup risk to the very specific case where
   * the OWNING path (e.g., W4a) fires for turn 1 but skips turn 2,
   * within the same 5s window. Each path consumes at most ONE stamp
   * per logical turn (W4a's last-pair peek and W4b's pre-persist
   * peek both run once per turn).
   */
  private consumeCrossPathStamp(sessionId: string, key: string): void {
    this.crossPathStamps.delete(this.dedupKey(sessionId, key));
  }

  /**
   * T5 — Non-mutating presence check on the cross-path map. Returns
   * `true` if the key is currently within the 5s window.
   */
  private peekCrossPathStamp(sessionId: string, key: string): boolean {
    const compositeKey = this.dedupKey(sessionId, key);
    const ts = this.crossPathStamps.get(compositeKey);
    if (ts === undefined) return false;
    if (Date.now() - ts > ChatTurnWriter.CROSS_PATH_TTL_MS) {
      this.crossPathStamps.delete(compositeKey);
      return false;
    }
    return true;
  }

  /**
   * T10 — Mark a cross-path in-flight reservation pre-persist. The
   * opposite path's `peekCrossPathInflight` then catches the active
   * race and skips its own persist. Always paired with `unmarkCrossPathInflight`
   * in a `finally` block so failures don't leak the reservation.
   */
  private markCrossPathInflight(sessionId: string, key: string): void {
    const compositeKey = this.dedupKey(sessionId, key);
    const now = Date.now();
    const ttl = ChatTurnWriter.CROSS_PATH_INFLIGHT_TTL_MS;
    for (const [k, ts] of this.crossPathInflight) {
      if (now - ts > ttl) this.crossPathInflight.delete(k);
    }
    this.crossPathInflight.set(compositeKey, now);
  }

  /** T10 — Release a cross-path in-flight reservation. */
  private unmarkCrossPathInflight(sessionId: string, key: string): void {
    this.crossPathInflight.delete(this.dedupKey(sessionId, key));
  }

  /**
   * T10 — Non-mutating presence check on the in-flight map. Returns
   * `true` if the opposite path is currently mid-persist for this
   * content. Defensive timestamp eviction guards against leaked
   * entries from a missed `finally`.
   */
  private peekCrossPathInflight(sessionId: string, key: string): boolean {
    const compositeKey = this.dedupKey(sessionId, key);
    const ts = this.crossPathInflight.get(compositeKey);
    if (ts === undefined) return false;
    if (Date.now() - ts > ChatTurnWriter.CROSS_PATH_INFLIGHT_TTL_MS) {
      this.crossPathInflight.delete(compositeKey);
      return false;
    }
    return true;
  }

  /** Drop all dedup reservations belonging to one session. */
  private clearSessionTurnIds(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const k of this.recentTurnIds.keys()) {
      if (k.startsWith(prefix)) this.recentTurnIds.delete(k);
    }
    // T5 — also clear the short-TTL cross-path stamps for this session.
    for (const k of this.crossPathStamps.keys()) {
      if (k.startsWith(prefix)) this.crossPathStamps.delete(k);
    }
    // T10 — clear in-flight cross-path reservations for this session.
    for (const k of this.crossPathInflight.keys()) {
      if (k.startsWith(prefix)) this.crossPathInflight.delete(k);
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
      // T4 — Also await the per-session agent_end chain heads. The
      // chain serialises onAgentEnd calls so a queued (but not yet
      // started) `runAgentEndPersist` won't have populated
      // `inFlightPersists` yet. Without this, `flush()` could return
      // before the queued work even reaches its persist call.
      for (const chain of this.w4aSessionChains.values()) {
        allJobs.push(chain.catch(() => undefined));
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
        // T28 — Skip image/attachment-only user messages whose
        // `extractText()` returns "" (the multi-modal content array
        // contained no `type === "text"` parts). W4b's
        // `onMessageReceived` already drops empty inbound text via
        // R15.2 to avoid persisting blank-user turns; W4a must mirror
        // that semantic in `computeDelta` or it produces an
        // assistant-only pair (`{ user: "", assistant: reply }`)
        // for any image-only user message followed by a reply.
        const userText = this.extractText(msg.content);
        if (userText) pendingUsers.push(userText);
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
        if (!text) {
          // T37 — Symmetric to T28's empty-user skip and W4b's
          // R20.1 empty-assistant guard. Attachment-only / non-text
          // assistant outputs (image generation, structured tool-
          // emitted artifacts that surface as non-text content
          // parts) produce `extractText() === ""`. Persisting
          // `(user, "")` pollutes chat memory/search and breaks the
          // "one user-visible turn = one pair" invariant. Mirror
          // W4b's `onMessageSent` empty-assistant bail (R20.1):
          // skip the pair, leave `pendingUsers` intact (the next
          // textual assistant reply pairs with them), do NOT
          // advance `pairIndex`. The R22.1 watermark-doesn't-drift
          // logic above handles the consequence — pairIndex stays
          // put so a later real reply gets the same index.
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
   * T33 — Discriminator mixed into the W4b daemon-facing turnId so the
   * resulting hash is unique per logical turn AND durable across process
   * restart. Prefers `messageId` (durable: the gateway persists outbound
   * delivery records keyed by it). Falls back to a sequence counter for
   * messageId-less envelopes — the fallback is NOT durable across
   * restart, but in practice OpenClaw's outbound path always carries
   * messageId; the fallback exists only so test fixtures and pathological
   * envelopes don't crash here.
   *
   * Distinct from `w4bInflightKey`'s sequence fallback, which intentionally
   * always varies per-call (own-path concurrent dispatch dedup). The
   * daemon-id fallback can collide on same-content same-session same-
   * fallback-counter — but the messageId path is the production case
   * and is unambiguously stable.
   */
  private w4bDaemonTurnIdDiscriminator(ev: InternalMessageEvent): string {
    const messageId = (ev as any)?.context?.messageId;
    if (typeof messageId === "string" && messageId.length > 0) {
      return `msg::${messageId}`;
    }
    // Reuse the same monotonic counter — fallback is rare and best-effort.
    this.w4bInflightSeq = (this.w4bInflightSeq + 1) >>> 0;
    return `seq::${this.w4bInflightSeq}`;
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
  private deterministicTurnId(
    sessionId: string,
    user: string,
    assistant: string,
    discriminator?: number | string,
  ): string {
    const parts: unknown[] = [sessionId, user, assistant];
    // T33 — Accepts a string discriminator (W4b passes the gateway-
    // provided `messageId`) in addition to the pair-index number that
    // W4a uses. Mixing the discriminator into the hash makes the
    // resulting turnId DURABLE across process restart: a crash after
    // a successful daemon write but before the watermark hits disk
    // produces the SAME id on retry, so the daemon's RDF subject URI
    // (built from the caller-supplied turnId) is identical and the
    // restart's POST is an idempotent overwrite — not a duplicate
    // ChatTurn subject. Pre-fix, persistOne's per-invocation
    // `randomUUID()` only made retries WITHIN the same process
    // idempotent; restart still duplicated.
    if (discriminator !== undefined) parts.push(discriminator);
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

  /**
   * T17 — Schedule a debounced watermark-file flush WITHOUT changing
   * the pending watermark value. Used by W4b's `w4bSessionCounts`
   * increment so the new count lands on disk via the same file write
   * that watermark updates use. If a flush is already scheduled, no-op
   * — it will pick up the new w4bCount when it fires.
   */
  private scheduleWatermarkFlush(sessionId: string): void {
    if (this.debounceTimers.has(sessionId)) return;
    const currentWatermark = this.cachedWatermarks.get(sessionId) ?? -1;
    const timer = setTimeout(() => {
      this.writeWatermarkFile();
      this.debounceTimers.delete(sessionId);
    }, 50);
    this.debounceTimers.set(sessionId, { timer, pendingIndex: currentWatermark });
  }

  private async persistOne(
    sessionId: string,
    user: string,
    assistant: string,
    turnId: string,
    opts?: { pairIndex?: number }
  ): Promise<void> {
    // T29 / T33 — Use the caller's deterministic `turnId` as the
    // daemon-facing request id (NOT a per-invocation random UUID).
    // The daemon's `/api/openclaw-channel/persist-turn` route accepts
    // a caller-supplied `turnId` and uses it to mint the RDF subject
    // URI; passing the SAME id on every retry — including across
    // process restart — keeps the RDF subject stable so a successful
    // POST followed by an unexpected crash (before the watermark
    // debounce flushes) and replay produces an idempotent overwrite,
    // not a duplicate ChatTurn subject.
    //
    // Both paths now feed `persistOne` a turnId that's both unique-
    // per-logical-turn AND durable across restart:
    //   * W4a — `deterministicTurnId(sessionId, user, assistant, pairIndex)`.
    //     pairIndex is recomputable from `messages` on restart, so the
    //     same pair re-derives the same hash.
    //   * W4b — `deterministicTurnId(sessionId, user, assistant, "msg::" + messageId)`.
    //     messageId is persisted by the gateway's outbound delivery
    //     log (`openclaw/src/infra/outbound/deliver.ts`), so a replay
    //     of the same `message:sent` event re-derives the same hash.
    //
    // Pre-T33 the implementation generated a fresh UUID once per
    // `persistOne` invocation, which made retries WITHIN a process
    // idempotent but not across restart. The daemon was free to mint
    // two distinct subject URIs (one per UUID) for the same logical
    // turn whenever we crashed mid-flush.
    let attempt = 0;
    while (attempt < 2) {
      try {
        await this.client.storeChatTurn(sessionId, user, assistant, { turnId });
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

  private writeWatermarkFile(targetPath: string = this.watermarkFilePath): boolean {
    try {
      // T17 — Emit the new `{ w: <watermark>, b: <w4bCount> }` shape so
      // the W4b session count is preserved across process restarts.
      // The union of session keys spans both maps because a session
      // can have a watermark without ever incrementing w4bCount (and
      // vice versa). Reader handles both legacy (number) and current
      // (object) shapes — see `initFromFile`.
      // T27 — `targetPath` defaults to the current watermarkFilePath
      // for normal writes, but `setStateDir` passes an explicit
      // destination so it can write-then-swap (instead of swap-then-
      // write). Without the explicit override, a failed migration
      // would leave the writer's internal state pointing at the new
      // path even though no valid file exists there, and the next
      // setStateDir(newStateDir) would short-circuit on same-path.
      const allKeys = new Set<string>([
        ...this.cachedWatermarks.keys(),
        ...this.w4bSessionCounts.keys(),
      ]);
      const data: Record<string, { w: number; b: number }> = {};
      for (const key of allKeys) {
        data[key] = {
          w: this.cachedWatermarks.get(key) ?? -1,
          b: this.w4bSessionCounts.get(key) ?? 0,
        };
      }
      const tmpPath = `${targetPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, targetPath);
      // T23 — Return true so callers (notably `setStateDir`) can gate
      // destructive follow-up actions like deleting the OLD file on
      // a confirmed-successful write at the new path. Without this,
      // a swallowed write failure would let the migration delete
      // the only valid watermark file.
      return true;
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter] Failed to write watermark file", { err });
      return false;
    }
  }
}
