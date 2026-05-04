import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import {
  canonicalPathForCompare,
  legacyWatermarkPathForStateDir,
  watermarkPathForStateDir,
  type ChatTurnWriterStateLayout,
} from "./state-dir-path.js";

/**
 * Durable direct-channel marker lifecycle:
 * `markExternalTurnPersistedDurable` creates content-bound markers only after
 * channel-side daemon `storeChatTurn` succeeds; marker keys include `turnId`
 * plus canonical user/assistant text to avoid false dedupe for reused IDs or
 * content. W4a matches them in `consumeExternalTurnMarkersForPair` during
 * `runAgentEndPersist`, advancing pair watermarks only after durable commit.
 * Create failures roll back marker snapshots when `commitWatermarkStateSync`
 * fails; `setStateDir` migrates per-session `m`
 * markers, and graceful `DkgChannelPlugin.stop()` drains in-flight first writes.
 * Telegram persistence is owned by W4a `agent_end` plus the colon-form
 * internal W4b hooks (`message:received` / `message:sent`). W4b replay
 * markers are retained and bound to provider message IDs so repeated
 * reset/compaction replays skip same-text occurrences safely.
 */

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface ChatTurnMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<{ type: string; text?: string }>;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
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

interface ComputedChatTurnPair {
  user: string;
  assistant: string;
  pairIndex: number;
  externalTurnIds: string[];
  externalDirect: boolean;
  messageIds: string[];
  assistantMessageIds: string[];
}

interface ExternalMarkerAction {
  skip: boolean;
  markers: string[];
  rollbackMarkers: string[];
}

interface WatermarkStateSnapshot {
  cachedHad: boolean;
  cachedIndex?: number;
  pendingIndex?: number;
}

interface LegacyMergeSource {
  markerKey: string;
  contentHash: string;
  watermarkFilePath: string;
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

interface PendingUserMessageMeta {
  messageId?: string;
  arrivalId?: string;
  typedSessionIdFallback?: boolean;
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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export class ChatTurnWriter {
  private client: any;
  private logger: Logger;
  private stateDir: string;
  private stateLayout: ChatTurnWriterStateLayout;
  private cachedWatermarks: Map<string, number> = new Map();
  // FIFO queue per conversation key. Two inbound messages arriving before the
  // first reply are both retained; `onMessageSent` consumes the oldest so the
  // first outbound reply pairs with the first inbound, not the most recent.
  private pendingUserMessages: Map<string, string[]> = new Map();
  // Parallel metadata queue for pending user messages. Some gateway
  // `message:sent` envelopes lack an outbound messageId, so we carry the inbound
  // provider messageId forward and use it as the durable W4b turnId
  // discriminator when the outbound envelope cannot provide one.
  private pendingUserMessageMeta: Map<string, PendingUserMessageMeta[]> = new Map();
  private pendingUserMessageSeq = 0;
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
  // Direct-channel persists (Node-UI through DkgChannelPlugin) bypass
  // ChatTurnWriter's daemon write path but append to the same OpenClaw
  // transcript. These durable correlation markers let later W4a backfill
  // skip exactly those already-persisted UI pairs across restarts without
  // confusing two legitimate same-content turns.
  private externalTurnMarkers: Map<string, Map<string, number>> = new Map();
  // In-flight persist tracking — `resetSessionState()` awaits these so a
  // pre-reset persist can't advance the just-reset watermark afterward.
  // Both W4a (`onAgentEnd`) and W4b (`onMessageSent`) MUST register their
  // persist jobs here, otherwise the reset assumption "all persists for
  // this session are tracked" is silently violated.
  private inFlightPersists: Map<string, Set<Promise<void>>> = new Map();
  // Job-scoped content origins for active W4b persists. These let a later W4a
  // skip the exact in-flight turn without copying queues/counts/jobs from a
  // conversationless session into an unrelated concrete chat.
  private persistJobOriginKeys: Map<Promise<void>, Set<string>> = new Map();
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
  private messageHookDedup: Map<string, number> = new Map();
  private messageHookInboundQueueKeys: Map<string, string> = new Map();
  private messageHookDedupSessionKeys: Map<string, string> = new Map();
  private messageHookNoIdInboundBatch: Set<string> = new Set();
  private messageHookNoIdInboundBatchClearScheduled = false;
  private static readonly MESSAGE_HOOK_DEDUP_TTL_MS = 60_000;
  private static readonly MESSAGE_HOOK_DEDUP_SWEEP_INTERVAL_MS = 5_000;
  private static readonly MESSAGE_HOOK_DEDUP_MAX_ENTRIES = 2_048;
  private static readonly MESSAGE_HOOK_NO_ID_INBOUND_PREFIX = "message-hook::inbound::text-batch::";
  private messageHookLastSweepAt = 0;
  private static readonly WEAK_SESSION_PREFIX = "weak-";

  constructor(options: {
    client: any;
    logger: Logger;
    stateDir: string;
    stateLayout?: ChatTurnWriterStateLayout;
    legacyStateDirs?: string[];
  }) {
    this.client = options.client;
    this.logger = options.logger;
    this.stateDir = options.stateDir;
    this.stateLayout = options.stateLayout ?? "nested";
    this.watermarkFilePath = watermarkPathForStateDir(this.stateDir, this.stateLayout);
    const activeWatermarkFileLoaded = this.initFromFile();
    this.migrateLegacyWatermarkFiles(
      this.legacyWatermarkFilePathsForLayout(
        this.stateDir,
        this.stateLayout,
        options.legacyStateDirs ?? [],
      ),
      { ignoreMigrationMarkers: !activeWatermarkFileLoaded },
    );
  }

  setClient(client: any): void {
    this.client = client;
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
   *   5. Leave the old file untouched so failed writes can retry and
   *      operator-owned fallback paths are not silently deleted.
   */
  async setStateDir(
    newStateDir: string,
    options: { stateLayout?: ChatTurnWriterStateLayout; legacyStateDirs?: string[] } = {},
  ): Promise<void> {
    const newStateLayout = options.stateLayout ?? this.stateLayout;
    const newWatermarkFilePath = watermarkPathForStateDir(newStateDir, newStateLayout);
    if (newWatermarkFilePath === this.watermarkFilePath) return;
    // Drain in-flight work BEFORE we touch any state. flush() awaits
    // all outstanding persists/resets/chains — we must capture their
    // effects before swapping paths.
    await this.flush();
    // T43/T45 — Build merged TEMP maps; never mutate live state during
    // merge. Pre-fix versions of this code path mutated live first,
    // then either wrote+committed (success) or attempted to restore
    // on failure. Both shapes were vulnerable to concurrent persists
    // arriving in the merge+write window:
    //   - T43: write fails, snapshot restore wipes destination's data
    //          AND any concurrent persist's watermark advance.
    //   - T45: hooks stay live across `await this.flush()`, so a
    //          new turn fired after flush returned could mutate live
    //          maps mid-merge; on failure the snapshot restore
    //          erased the new persist's increment, on success the
    //          merge clobbered the new persist's value.
    //
    // Fix: live state is read-only until commit. `mergedWm` /
    // `mergedBc` carry the (live ∪ destination_file) view as input
    // to `writeWatermarkFile`'s explicit-override channel. On write
    // success we union back into live (max-merge) so any concurrent
    // persist's increment that landed in live during the write
    // window is preserved. On write failure live is unchanged —
    // concurrent persists keep their advances; nothing got wiped.
    const destinationFileExisted = fs.existsSync(newWatermarkFilePath);
    const destinationWm = new Map<string, number>();
    const destinationBc = new Map<string, number>();
    const destinationMarkers = new Map<string, Map<string, number>>();
    const mergedWm = new Map(this.cachedWatermarks);
    const mergedBc = new Map(this.w4bSessionCounts);
    const mergedMarkers = this.cloneExternalTurnMarkers(this.externalTurnMarkers);
    let destinationFileLoaded = !destinationFileExisted ? false : true;
    try {
      if (destinationFileExisted) {
        this.mergeWatermarkFileInto(
          newWatermarkFilePath,
          mergedWm,
          mergedBc,
          mergedMarkers,
          destinationWm,
          destinationBc,
          destinationMarkers,
        );
      }
    } catch (err) {
      destinationFileLoaded = false;
      this.logger.warn?.("[ChatTurnWriter.setStateDir] Failed to merge destination file; proceeding with current state", { err });
    }
    const legacyMergeSources = this.mergeLegacyWatermarkFilesInto(
      this.legacyWatermarkFilePathsForLayout(
        newStateDir,
        newStateLayout,
        options.legacyStateDirs ?? [],
      ),
      newWatermarkFilePath,
      mergedWm,
      mergedBc,
      mergedMarkers,
      { ignoreMigrationMarkers: !destinationFileLoaded },
    );
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
      // T45 — Pass the merged temp maps explicitly so live state
      // stays untouched if the write fails.
      wrote = this.writeWatermarkFile(newWatermarkFilePath, {
        wm: mergedWm,
        bc: mergedBc,
        markers: mergedMarkers,
      });
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
    if (wrote) {
      // T45 — Commit by union-merging back into live. If a concurrent
      // persist advanced live's watermark during the write window,
      // its increment is preserved (max takes the higher of merged-
      // from-destination and post-flush-live). External markers are
      // exact daemon-success facts, so identical marker keys merge
      // idempotently instead of adding counts.
      for (const [key, val] of mergedWm) {
        this.cachedWatermarks.set(key, Math.max(this.cachedWatermarks.get(key) ?? -1, val));
      }
      for (const [key, val] of mergedBc) {
        this.w4bSessionCounts.set(key, Math.max(this.w4bSessionCounts.get(key) ?? 0, val));
      }
      for (const [key, markers] of mergedMarkers) {
        const live = this.externalTurnMarkers.get(key) ?? new Map<string, number>();
        for (const [marker, count] of markers) {
          if (count > 0) live.set(marker, Math.max(live.get(marker) ?? 0, count));
        }
        if (live.size > 0) this.externalTurnMarkers.set(key, live);
      }
      const finalDiskWm = this.snapshotWatermarksForWrite();
      wrote = this.writeWatermarkFile(newWatermarkFilePath, {
        wm: finalDiskWm,
        bc: this.w4bSessionCounts,
        markers: this.externalTurnMarkers,
      });
      if (!wrote) {
        this.logger.warn?.(
          "[ChatTurnWriter.setStateDir] Final post-commit rewrite at new path failed; preserving old path for retry.",
          { newWatermarkFilePath },
        );
        if (!this.writeWatermarkFile()) {
          this.logger.warn?.(
            "[ChatTurnWriter.setStateDir] Failed to preserve post-commit state at old path after migration rewrite failure.",
            { oldWatermarkFilePath: this.watermarkFilePath, newWatermarkFilePath },
          );
        }
        this.restoreFailedMigrationDestination(
          newWatermarkFilePath,
          destinationFileExisted,
          destinationWm,
          destinationBc,
          destinationMarkers,
        );
      }
    }
    if (wrote) {
      this.recordLegacyMigrationSources(newWatermarkFilePath, legacyMergeSources);
    }
    // T45 - If the initial new-path write failed, live state is still
    // untouched. If only the final post-union rewrite failed, live may
    // hold merged state but the old path is preserved so a retry or
    // normal flush can serialize it without switching to a stale file.
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
      this.stateLayout = newStateLayout;
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

  private initFromFile(): boolean {
    try {
      const dir = path.dirname(this.watermarkFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.existsSync(this.watermarkFilePath)) return false;
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
              const obj = val as { w?: unknown; b?: unknown; m?: unknown };
              if (typeof obj.w === "number") {
                this.cachedWatermarks.set(key, obj.w);
              }
              if (typeof obj.b === "number") {
                this.w4bSessionCounts.set(key, obj.b);
              }
              if (obj.m && typeof obj.m === "object" && !Array.isArray(obj.m)) {
                const markers = new Map<string, number>();
                for (const [hash, count] of Object.entries(obj.m as Record<string, unknown>)) {
                  if (typeof count === "number" && count > 0) {
                    markers.set(hash, count);
                  }
                }
                if (markers.size > 0) {
                  this.externalTurnMarkers.set(key, markers);
                }
              }
            }
          }
        }
      }
      return true;
    } catch (err) {
      this.logger.warn?.("[ChatTurnWriter] Failed to load watermarks, starting fresh", { err });
      return false;
    }
  }

  private migrateLegacyWatermarkFiles(
    legacyWatermarkFilePaths: string[],
    options: { ignoreMigrationMarkers?: boolean } = {},
  ): void {
    const mergedSources = this.mergeLegacyWatermarkFilesInto(
      legacyWatermarkFilePaths,
      this.watermarkFilePath,
      this.cachedWatermarks,
      this.w4bSessionCounts,
      this.externalTurnMarkers,
      options,
    );
    if (mergedSources.length === 0) return;
    if (this.writeWatermarkFile()) {
      this.recordLegacyMigrationSources(this.watermarkFilePath, mergedSources);
      this.logger.info?.(
        "[ChatTurnWriter] Migrated legacy chat-turn watermark state into the active state dir.",
        { watermarkFilePath: this.watermarkFilePath },
      );
    } else {
      this.logger.warn?.(
        "[ChatTurnWriter] Failed to write migrated legacy watermark state; preserving legacy source files for retry.",
        { watermarkFilePath: this.watermarkFilePath },
      );
    }
  }

  private legacyWatermarkFilePathsForLayout(
    stateDir: string,
    stateLayout: ChatTurnWriterStateLayout,
    legacyStateDirs: string[],
  ): string[] {
    const sameDirOppositeLayoutWatermarkPath = stateLayout === "direct"
      ? legacyWatermarkPathForStateDir(stateDir)
      : watermarkPathForStateDir(stateDir, "direct");
    return [
      sameDirOppositeLayoutWatermarkPath,
      ...legacyStateDirs.map((legacyStateDir) => legacyWatermarkPathForStateDir(legacyStateDir)),
    ];
  }

  private mergeLegacyWatermarkFilesInto(
    legacyWatermarkFilePaths: string[],
    targetWatermarkFilePath: string,
    targetWm: Map<string, number>,
    targetBc: Map<string, number>,
    targetMarkers: Map<string, Map<string, number>>,
    options: { ignoreMigrationMarkers?: boolean } = {},
  ): LegacyMergeSource[] {
    const targetCanonical = canonicalPathForCompare(targetWatermarkFilePath);
    const migratedLegacySources = options.ignoreMigrationMarkers
      ? new Map<string, string>()
      : this.readLegacyMigrationSourceHashes(targetWatermarkFilePath);
    const seen = new Set<string>();
    const mergedSources: LegacyMergeSource[] = [];
    for (const legacyWatermarkFilePath of legacyWatermarkFilePaths) {
      const legacyCanonical = canonicalPathForCompare(legacyWatermarkFilePath);
      if (legacyCanonical === targetCanonical || seen.has(legacyCanonical)) continue;
      seen.add(legacyCanonical);
      if (!fs.existsSync(legacyWatermarkFilePath)) continue;
      try {
        const legacyContentHash = this.hashWatermarkFileForMigration(legacyWatermarkFilePath);
        if (migratedLegacySources.get(legacyCanonical) === legacyContentHash) continue;
        this.mergeWatermarkFileInto(
          legacyWatermarkFilePath,
          targetWm,
          targetBc,
          targetMarkers,
        );
        mergedSources.push({
          markerKey: legacyCanonical,
          contentHash: legacyContentHash,
          watermarkFilePath: legacyWatermarkFilePath,
        });
        this.logger.info?.(
          "[ChatTurnWriter] Merged legacy chat-turn watermark state into active state.",
          { legacyWatermarkFilePath, targetWatermarkFilePath },
        );
      } catch (err) {
        this.logger.warn?.(
          "[ChatTurnWriter] Failed to merge legacy chat-turn watermark state; preserving legacy source for retry.",
          { err, legacyWatermarkFilePath, targetWatermarkFilePath },
        );
      }
    }
    return mergedSources;
  }

  private legacyMigrationMarkerPath(targetWatermarkFilePath: string): string {
    return `${targetWatermarkFilePath}.legacy-migrated.json`;
  }

  private readLegacyMigrationSourceHashes(targetWatermarkFilePath: string): Map<string, string> {
    const markerPath = this.legacyMigrationMarkerPath(targetWatermarkFilePath);
    if (!fs.existsSync(markerPath)) return new Map();
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as { migratedLegacyWatermarkFiles?: unknown };
      const values = marker?.migratedLegacyWatermarkFiles;
      if (!values || typeof values !== "object" || Array.isArray(values)) return new Map();
      return new Map(
        Object.entries(values)
          .filter((entry): entry is [string, string] =>
            typeof entry[0] === "string" &&
            typeof entry[1] === "string"
          ),
      );
    } catch (err) {
      this.logger.warn?.(
        "[ChatTurnWriter] Failed to read legacy watermark migration marker; legacy sources may be retried.",
        { err, markerPath },
      );
      return new Map();
    }
  }

  private hashWatermarkFileForMigration(watermarkFilePath: string): string {
    return createHash("sha256")
      .update(fs.readFileSync(watermarkFilePath))
      .digest("hex");
  }

  private recordLegacyMigrationSources(
    targetWatermarkFilePath: string,
    mergedSources: LegacyMergeSource[],
  ): void {
    if (mergedSources.length === 0) return;
    const markerPath = this.legacyMigrationMarkerPath(targetWatermarkFilePath);
    try {
      const migratedLegacyWatermarkFiles = this.readLegacyMigrationSourceHashes(targetWatermarkFilePath);
      for (const source of mergedSources) {
        migratedLegacyWatermarkFiles.set(source.markerKey, source.contentHash);
      }
      const dir = path.dirname(markerPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          migratedLegacyWatermarkFiles: Object.fromEntries(
            [...migratedLegacyWatermarkFiles.entries()].sort(([left], [right]) =>
              left.localeCompare(right)
            ),
          ),
        }, null, 2)}\n`,
        "utf-8",
      );
    } catch (err) {
      this.logger.warn?.(
        "[ChatTurnWriter] Failed to write legacy watermark migration marker; legacy sources may be retried.",
        { err, markerPath, legacyWatermarkFilePaths: mergedSources.map((source) => source.watermarkFilePath) },
      );
    }
  }

  private mergeWatermarkFileInto(
    sourceWatermarkFilePath: string,
    targetWm: Map<string, number>,
    targetBc: Map<string, number>,
    targetMarkers: Map<string, Map<string, number>>,
    mirrorWm?: Map<string, number>,
    mirrorBc?: Map<string, number>,
    mirrorMarkers?: Map<string, Map<string, number>>,
  ): void {
    const content = fs.readFileSync(sourceWatermarkFilePath, "utf-8");
    const data = JSON.parse(content);
    if (!data || typeof data !== "object") return;
    for (const [key, val] of Object.entries(data)) {
      if (typeof val === "number") {
        targetWm.set(key, Math.max(targetWm.get(key) ?? -1, val));
        mirrorWm?.set(key, val);
      } else if (val && typeof val === "object") {
        const obj = val as { w?: unknown; b?: unknown; m?: unknown };
        if (typeof obj.w === "number") {
          targetWm.set(key, Math.max(targetWm.get(key) ?? -1, obj.w));
          mirrorWm?.set(key, obj.w);
        }
        if (typeof obj.b === "number") {
          targetBc.set(key, Math.max(targetBc.get(key) ?? 0, obj.b));
          mirrorBc?.set(key, obj.b);
        }
        if (obj.m && typeof obj.m === "object" && !Array.isArray(obj.m)) {
          this.mergeExternalTurnMarkers(targetMarkers, key, obj.m as Record<string, unknown>);
          if (mirrorMarkers) {
            this.mergeExternalTurnMarkers(mirrorMarkers, key, obj.m as Record<string, unknown>);
          }
        }
      }
    }
  }

  async onAgentEnd(event: AgentEndContext, ctx?: any): Promise<void> {
    // B5 — skip dkg-ui channel; DkgChannelPlugin.queueTurnPersistence
    // owns UI-channel persistence with richer metadata (correlation IDs,
    // attachment refs). Avoids double-persist under different sessionIds.
    if (ctx?.channelId === "dkg-ui") return;
    const sessionId = this.deriveSessionId(ctx);
    if (!sessionId) return;
    const identity = this.identityFieldsFromPayload(ctx);
    const externalCursorKey = this.externalCursorKeyFromSessionKey(identity.sessionKey);
    const typedW4bCursorKeys = this.typedW4bMarkerCursorKeys(identity);
    const w4bInflightSessionIds = this.w4bInflightGuardSessionIds(identity, sessionId);
    const w4aCrossPathSessionIds = this.w4aCrossPathSessionIds(identity, sessionId);
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
    const resetAtSchedule = this.pendingResets.get(sessionId);
    const previous = this.w4aSessionChains.get(sessionId) ?? Promise.resolve();
    const work = previous
      // Never block the next fire on the previous fire's failure.
      .catch(() => undefined)
      .then(async () => {
        if (resetAtSchedule) await resetAtSchedule;
        await this.runAgentEndPersist(
          event,
          sessionId,
          externalCursorKey,
          typedW4bCursorKeys,
          w4bInflightSessionIds,
          w4aCrossPathSessionIds,
        );
      });
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

  private async runAgentEndPersist(
    event: AgentEndContext,
    sessionId: string,
    externalCursorKey?: string,
    typedW4bCursorKeys: string[] = [],
    w4bInflightSessionIds: string[] = [sessionId],
    w4aCrossPathSessionIds: string[] = [sessionId],
  ): Promise<void> {
    try {
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
      // T362 — Cold-start clamp. When no prior watermark exists for this
      // session (savedUpTo === -1) AND `messages[]` carries more than one
      // valid pair, the older pairs come from a conversation the adapter
      // never observed: OpenClaw retains the channel transcript across
      // sessions while DKG state can be wiped independently. Walking those
      // historical pairs replays them; the daemon does not idempotently
      // dedupe (each storeChatExchange mints fresh userMsg/assistantMsg
      // UUIDs even when turnId matches), so each replayed pair bloats the
      // chat-turns assertion by ~20 triples. Persist only the latest pair;
      // bumpWatermark advances to its index and MAX semantics implicitly
      // claim earlier indices as done. Historical pairs remain in the
      // OpenClaw transcript for context-window recall — they just do not
      // retroactively flood DKG. See #359 / PR #362 live-smoke evidence.
      if (savedUpTo < 0 && pairs.length > 1) {
        const dropped = pairs.length - 1;
        this.logger.info?.(
          `[ChatTurnWriter.onAgentEnd] cold-start clamp: ` +
          `discarded ${dropped} historical pair(s), ` +
          `persisting only the latest (sessionId=${sessionId})`
        );
        pairs.splice(0, dropped);
      }
      // Persist sequentially so a transient failure on pair N leaves the
      // watermark at N-1 and the next agent_end call retries from the same
      // point. Without sequencing, a failed middle pair could be skipped
      // when the tail succeeds.
      const lastIdx = pairs.length - 1;
      const job = this.trackPersistJob(sessionId, async () => {
        for (let i = 0; i < pairs.length; i++) {
          const { user, assistant, pairIndex, externalTurnIds, messageIds, assistantMessageIds } = pairs[i];
          if (!user && !assistant) continue;
          const externalMarkerAction = externalCursorKey
            ? this.consumeExternalTurnMarkersForPair(
              externalCursorKey,
              externalTurnIds,
              user,
              assistant,
            )
            : { skip: false, markers: [], rollbackMarkers: [] };
          if (externalCursorKey && externalMarkerAction.markers.length > 0) {
            const watermarkSnapshot = this.snapshotWatermarkState(sessionId);
            if (externalMarkerAction.skip) this.bumpWatermark(sessionId, pairIndex);
            if (!this.commitWatermarkStateSync(sessionId)) {
              for (const marker of externalMarkerAction.rollbackMarkers) {
                this.restoreExternalTurnMarker(externalCursorKey, marker);
              }
              this.restoreWatermarkState(sessionId, watermarkSnapshot);
              throw new Error("Failed to write external chat-turn marker consumption");
            }
            if (externalMarkerAction.skip) continue;
          }
          const typedW4bMarkerHit = this.findTypedW4bExternalMarker(
            typedW4bCursorKeys,
            user,
            assistant,
            messageIds,
            assistantMessageIds,
          );
          if (typedW4bMarkerHit) {
            const watermarkSnapshot = this.snapshotWatermarkState(sessionId);
            // Typed W4b markers are durable daemon-success facts, not
            // one-shot tickets. Keep them so later reset/compaction replays
            // can skip the same provider-message occurrence again.
            this.bumpWatermark(sessionId, pairIndex);
            if (!this.commitWatermarkStateSync(sessionId)) {
              this.restoreWatermarkState(sessionId, watermarkSnapshot);
              throw new Error("Failed to write typed W4b chat-turn marker watermark");
            }
            continue;
          }
          const typedW4bInflightOrigins = this.typedW4bInflightOrigins(
            typedW4bCursorKeys,
            user,
            assistant,
            messageIds,
            assistantMessageIds,
          );
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
            if (this.hasAnyInFlightPersistOrigin(typedW4bInflightOrigins)) {
              continue;
            }
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
            if (this.hasW4bInflightOrigin(w4bInflightSessionIds, w4bOrigin)) {
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
          if (w4aInflightKey) {
            for (const crossPathSessionId of w4aCrossPathSessionIds) {
              this.markCrossPathInflight(crossPathSessionId, w4aInflightKey);
            }
          }
          try {
            await this.persistOne(sessionId, user, assistant, turnId, { pairIndex });
            // T55 — Only stamp W4a-origin for the LAST (live) pair.
            // Historical backfill pairs cannot race W4b — by the time
            // backfill runs, W4b has long since seen and processed
            // those messages. Pre-fix the stamp ran for every pair,
            // and a live pair[N] sharing content with a backfilled
            // pair[0] would leave a stale stamp from pair[0]'s
            // persist; W4b's content-only check would then see the
            // stamp during the live `message:sent` arrival and drop
            // its user queue while pair[N]'s persist was still in
            // flight. If pair[N] then failed, the live turn was lost
            // (no W4a backfill source either — `agent_end` already
            // ran). Mirrors the `i === lastIdx` gate on the in-flight
            // reservation above for the same reason. Uses the
            // short-TTL cross-path map (T5) so a repeated same-
            // content turn outside the cross-path window doesn't
            // false-dedup.
            if (i === lastIdx) {
              const w4aOrigin = this.w4aOriginKey(user, assistant);
              for (const crossPathSessionId of w4aCrossPathSessionIds) {
                this.markCrossPathStamp(crossPathSessionId, w4aOrigin);
              }
            }
          } catch (err) {
            // Release the turnId reservation so a retry can re-attempt.
            // No w4b-origin release needed — W4a's last-pair check is
            // now a non-mutating peek (R13.1), so W4a never reserved it.
            this.releaseTurnIdReservation(sessionId, turnId);
            this.logger.error?.("[ChatTurnWriter.onAgentEnd] Persist failed", { err });
            if (w4aInflightKey) {
              for (const crossPathSessionId of w4aCrossPathSessionIds) {
                this.unmarkCrossPathInflight(crossPathSessionId, w4aInflightKey);
              }
            }
            return; // leave watermark at last successful pair
          }
          if (w4aInflightKey) {
            for (const crossPathSessionId of w4aCrossPathSessionIds) {
              this.unmarkCrossPathInflight(crossPathSessionId, w4aInflightKey);
            }
          }
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
      this.deleteTrackedPersistJob(sessionId, job);
    }).catch(() => {});
    return job;
  }

  private markPersistJobOrigin(job: Promise<void>, originKey: string): void {
    const origins = this.persistJobOriginKeys.get(job) ?? new Set<string>();
    origins.add(originKey);
    this.persistJobOriginKeys.set(job, origins);
  }

  private hasInFlightPersistOrigin(sessionId: string, originKey: string): boolean {
    const bucket = this.inFlightPersists.get(sessionId);
    if (!bucket) return false;
    for (const job of bucket) {
      if (this.persistJobOriginKeys.get(job)?.has(originKey)) return true;
    }
    return false;
  }

  private hasAnyInFlightPersistOrigin(originKeys: string[]): boolean {
    const wanted = new Set(originKeys.filter((key) => key.length > 0));
    if (wanted.size === 0) return false;
    for (const bucket of this.inFlightPersists.values()) {
      for (const job of bucket) {
        const origins = this.persistJobOriginKeys.get(job);
        if (!origins) continue;
        for (const origin of wanted) {
          if (origins.has(origin)) return true;
        }
      }
    }
    return false;
  }

  private hasW4bInflightOrigin(sessionIds: string[], originKey: string): boolean {
    for (const sessionId of Array.from(new Set(sessionIds))) {
      if (this.peekCrossPathInflight(sessionId, originKey) || this.hasInFlightPersistOrigin(sessionId, originKey)) {
        return true;
      }
    }
    return false;
  }

  private deleteTrackedPersistJob(sessionId: string, job: Promise<void>): void {
    let removed = false;
    const bucket = this.inFlightPersists.get(sessionId);
    if (bucket) {
      removed = bucket.delete(job);
      if (bucket.size === 0) this.inFlightPersists.delete(sessionId);
    }
    this.persistJobOriginKeys.delete(job);
    if (removed) return;
    for (const [key, bucket] of Array.from(this.inFlightPersists.entries())) {
      if (!bucket.delete(job)) continue;
      if (bucket.size === 0) this.inFlightPersists.delete(key);
      break;
    }
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
      await this.runReset(this.resetIdentityFromHookPayload(event, ctx));
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onBeforeCompaction] Error", { err });
    }
  }

  async onBeforeReset(event: any, ctx?: any): Promise<void> {
    try {
      this.flushSync();
      await this.runReset(this.resetIdentityFromHookPayload(event, ctx));
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onBeforeReset] Error", { err });
    }
  }

  async markExternalTurnPersistedDurable(opts: {
    sessionKey?: string;
    turnId?: string;
    user: string;
    assistant: string;
  }): Promise<void> {
    const externalCursorKey = this.externalCursorKeyFromSessionKey(opts.sessionKey);
    const markers = [
      this.externalTurnMarkerId(opts.turnId, opts.user, opts.assistant),
    ].filter(Boolean);
    if (!externalCursorKey || markers.length === 0) return;
    const previousMarkerCounts = markers.map((marker) => ({
      marker,
      count: this.externalTurnMarkers.get(externalCursorKey)?.get(marker) ?? 0,
    }));
    for (const marker of markers) {
      this.restoreExternalTurnMarker(externalCursorKey, marker);
    }
    if (!this.commitWatermarkStateSync(externalCursorKey)) {
      for (const previous of previousMarkerCounts) {
        this.restoreExternalTurnMarkerCount(externalCursorKey, previous.marker, previous.count);
      }
      throw new Error("Failed to write external chat-turn marker");
    }
  }

  private restoreFailedMigrationDestination(
    newWatermarkFilePath: string,
    destinationFileExisted: boolean,
    destinationWm: Map<string, number>,
    destinationBc: Map<string, number>,
    destinationMarkers: Map<string, Map<string, number>>,
  ): void {
    try {
      if (destinationFileExisted) {
        if (!this.writeWatermarkFile(newWatermarkFilePath, {
          wm: destinationWm,
          bc: destinationBc,
          markers: destinationMarkers,
        })) {
          this.logger.warn?.(
            "[ChatTurnWriter.setStateDir] Failed to restore destination file after migration rewrite failure.",
            { newWatermarkFilePath },
          );
        }
      } else if (fs.existsSync(newWatermarkFilePath)) {
        fs.unlinkSync(newWatermarkFilePath);
      }
    } catch (err) {
      this.logger.warn?.(
        "[ChatTurnWriter.setStateDir] Failed to clean up destination file after migration rewrite failure.",
        { err, newWatermarkFilePath },
      );
    }
  }

  /**
   * Track the reset promise on `pendingResets` so `onAgentEnd` /
   * `onMessageSent` can `await` it before processing a turn that arrived
   * mid-reset. Without this gate, a fast post-compaction `agent_end`
   * could read the stale watermark before the reset finishes draining.
   */
  private async runReset(identity: {
    sessionId: string;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
    externalCursorKey?: string;
  }): Promise<void> {
    const sessionIds = this.collectResetSessionIds(identity);
    if (sessionIds.length === 0) return;
    const preResetChains = new Map<string, Promise<void>>();
    for (const sessionId of sessionIds) {
      const chain = this.w4aSessionChains.get(sessionId);
      if (chain) preResetChains.set(sessionId, chain);
    }
    let startReset!: () => void;
    const reset = new Promise<void>((resolve, reject) => {
      startReset = () => {
        void (async () => {
          // T4/T81 — Set the pending reset gate before draining older
          // W4a chain work. onAgentEnd captures the reset promise at
          // scheduling time, so chain entries queued before this reset do
          // not wait on themselves, while new W4a/W4b/internal-hook work
          // that arrives after the gate is installed waits or replays.
          // T101 - Await the pre-gate snapshot only; post-gate W4a work
          // waits on this reset and must not become something reset awaits.
          for (const sessionId of sessionIds) {
            const chain = preResetChains.get(sessionId);
            if (chain) {
              await chain.catch(() => undefined);
            }
          }
          await this.resetSessionState(sessionIds);
        })().then(resolve, reject);
      };
    });
    for (const sessionId of sessionIds) {
      this.pendingResets.set(sessionId, reset);
    }
    startReset();
    try {
      await reset;
    } finally {
      // Only delete if no newer reset replaced ours.
      for (const sessionId of sessionIds) {
        if (this.pendingResets.get(sessionId) === reset) {
          this.pendingResets.delete(sessionId);
        }
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
  private async resetSessionState(sessionIds: string[] | string): Promise<void> {
    const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds].filter(Boolean);
    if (ids.length === 0) return;
    for (const sessionId of ids) {
      const inFlight = this.inFlightPersists.get(sessionId);
      if (inFlight && inFlight.size > 0) {
        // Snapshot the set — settle every job (success or failure) before
        // wiping watermark state so a late completion can't reintroduce it.
        const pending = Array.from(inFlight);
        await Promise.allSettled(pending);
      }
    }
    for (const sessionId of ids) {
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
      this.pendingUserMessageMeta.delete(sessionId);
      this.clearSessionTurnIds(sessionId);
      // R18.2 — Reset the W4b session count too. After compaction the
      // `messages[]` array is rewritten, so the W4b count's "I persisted
      // N turns" no longer maps to the new pair indices. Leaving stale
      // count would skip new pairs in `computeDelta`.
      this.w4bSessionCounts.delete(sessionId);
    }
    this.clearMessageHookDedupForSessions(ids);
    // External markers record daemon-success facts from direct-channel
    // persists. Preserve them across reset/compaction so the reset W4a replay
    // can still consume the marker instead of duplicating the stored UI turn.
    this.writeWatermarkFile();
  }

  onTypedMessageReceived(event: any, ctx?: any): void {
    const ev = this.normalizeTypedMessageEvent("inbound", event, ctx);
    if (!ev) return;
    this.onMessageReceived(ev);
  }

  async onTypedMessageSent(event: any, ctx?: any): Promise<void> {
    const ev = this.normalizeTypedMessageEvent("outbound", event, ctx);
    if (!ev) return;
    await this.onMessageSent(ev);
  }

  private normalizeTypedMessageEvent(
    direction: "inbound" | "outbound",
    eventPayload?: any,
    hookCtx?: any,
  ): InternalMessageEvent | null {
    const event = eventPayload && typeof eventPayload === "object" ? eventPayload : {};
    const ctx = hookCtx && typeof hookCtx === "object" ? hookCtx : {};
    const eventContext = event.context && typeof event.context === "object" ? event.context : {};
    const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
    const content = this.extractTypedMessageContent(event, eventContext, metadata, ctx);
    const successValue = eventContext.success ?? event.success;
    const isOutboundFailure = direction === "outbound" && successValue === false;
    if (!content && !isOutboundFailure) return null;

    const channelId = firstString(
      ctx.channelId,
      event.channelId,
      eventContext.channelId,
      metadata.channelId,
      metadata.originatingChannel,
      metadata.provider,
    );
    if (channelId === "dkg-ui") return null;
    const accountId = firstString(ctx.accountId, event.accountId, eventContext.accountId, metadata.accountId, metadata.botId);
    const conversationId = this.typedHookConversationId(event, eventContext, metadata, ctx);
    const explicitSessionKey = firstString(
      ctx.sessionKey,
      event.sessionKey,
      eventContext.sessionKey,
      metadata.sessionKey,
    );
    const typedSessionIdFallback = firstString(
      ctx.sessionId,
      event.sessionId,
      eventContext.sessionId,
      metadata.sessionId,
    );
    const strongSessionKey = explicitSessionKey ?? typedSessionIdFallback;
    const sessionKey = strongSessionKey ?? this.weakSessionKey(channelId, accountId, conversationId);
    if (!channelId || !sessionKey) {
      this.logger.debug?.("[ChatTurnWriter] Dropping typed message hook without channel/session identity");
      return null;
    }

    const messageId = this.typedHookMessageId(event, eventContext, metadata, ctx);
    const context: NonNullable<InternalMessageEvent["context"]> = {
      channelId,
      content,
    };
    if (accountId) context.accountId = accountId;
    if (conversationId) context.conversationId = conversationId;
    if (messageId) context.messageId = messageId;
    if (typeof successValue === "boolean") context.success = successValue;
    if (direction === "outbound" && typeof context.success !== "boolean") context.success = true;
    if (!explicitSessionKey && typedSessionIdFallback) (context as any).typedSessionIdFallback = true;

    return {
      sessionKey,
      direction,
      text: content,
      context,
    };
  }

  private extractTypedMessageContent(
    event: Record<string, unknown>,
    eventContext: Record<string, unknown>,
    metadata: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): string {
    for (const value of [
      event.content,
      event.text,
      event.body,
      eventContext.content,
      metadata.content,
      ctx.content,
    ]) {
      const text = this.extractText(value as ChatTurnMessage["content"]).trim();
      if (text) return text;
    }
    return "";
  }

  private typedHookMessageId(
    event: Record<string, unknown>,
    eventContext: Record<string, unknown>,
    metadata: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): string | undefined {
    return firstString(
      ctx.messageId,
      ctx.MessageId,
      ctx.message_id,
      event.messageId,
      event.MessageId,
      event.message_id,
      eventContext.messageId,
      eventContext.MessageId,
      eventContext.message_id,
      metadata.messageId,
      metadata.MessageId,
      metadata.message_id,
    );
  }

  private typedHookConversationId(
    event: Record<string, unknown>,
    eventContext: Record<string, unknown>,
    metadata: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): string | undefined {
    const explicit = firstString(
      ctx.conversationId,
      event.conversationId,
      eventContext.conversationId,
      metadata.conversationId,
      ctx.conversation_id,
      event.conversation_id,
      eventContext.conversation_id,
      metadata.conversation_id,
    );
    if (explicit) return explicit;
    const chatId = firstString(
      ctx.chatId,
      event.chatId,
      eventContext.chatId,
      metadata.chatId,
      ctx.chat_id,
      event.chat_id,
      eventContext.chat_id,
      metadata.chat_id,
    );
    const threadId = firstString(
      ctx.threadId,
      event.threadId,
      eventContext.threadId,
      metadata.threadId,
      ctx.thread_id,
      event.thread_id,
      eventContext.thread_id,
      metadata.thread_id,
      ctx.message_thread_id,
      event.message_thread_id,
      eventContext.message_thread_id,
      metadata.message_thread_id,
    );
    if (chatId && threadId) return `${chatId}:${threadId}`;
    return threadId ?? chatId;
  }

  onMessageReceived(ev: InternalMessageEvent): void {
    try {
      // B5 — skip dkg-ui channel; DkgChannelPlugin owns UI persistence.
      const channelId = (ev as any)?.context?.channelId ?? (ev as any)?.channelId;
      if (channelId === "dkg-ui") return;
      const conversationKey = this.conversationKeyFromInternalEvent(ev);
      if (!conversationKey) return;
      const pendingReset = this.pendingResets.get(conversationKey);
      if (pendingReset) {
        void pendingReset.then(() => this.onMessageReceived(ev)).catch(() => undefined);
        return;
      }
      const text = readEventText(ev);
      // R15.2 — Skip attachment-only / non-text inbound events. `readEventText`
      // returns "" when the envelope carries no text payload (e.g. an image
      // upload from Telegram). Enqueueing an empty string here would let the
      // next `message:sent` pair its assistant reply with a blank user side,
      // persisting an assistant-only turn for a conversation that had no
      // textual inbound. Drop until we add a recoverable representation for
      // attachment-only turns.
      if (!text) return;
      const inboundDedupKey = this.messageHookDedupKey("inbound", ev, text);
      if (inboundDedupKey) {
        const existingConversationKey = this.messageHookInboundQueueKeys.get(inboundDedupKey);
        if (existingConversationKey && existingConversationKey !== conversationKey) {
          if (this.shouldMoveInboundQueue(existingConversationKey, conversationKey)) {
            this.movePendingInboundQueue(existingConversationKey, conversationKey);
            this.messageHookInboundQueueKeys.set(inboundDedupKey, conversationKey);
            this.messageHookDedupSessionKeys.set(inboundDedupKey, conversationKey);
          }
          return;
        }
        if (this.markMessageHookDuplicate(inboundDedupKey, conversationKey)) return;
      }
      const queue = this.pendingUserMessages.get(conversationKey) ?? [];
      queue.push(text);
      this.pendingUserMessages.set(conversationKey, queue);
      const metaQueue = this.pendingUserMessageMeta.get(conversationKey) ?? [];
      metaQueue.push({
        messageId: this.messageEventId(ev),
        arrivalId: this.nextPendingUserArrivalId(),
        typedSessionIdFallback: (ev as any)?.context?.typedSessionIdFallback === true,
      });
      this.pendingUserMessageMeta.set(conversationKey, metaQueue);
      if (inboundDedupKey) this.messageHookInboundQueueKeys.set(inboundDedupKey, conversationKey);
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
      this.promotePendingInboundQueueForOutbound(conversationKey);
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
        const droppedInboundDedupKeys = this.messageHookInboundDedupKeysForQueue(conversationKey);
        this.pendingUserMessages.delete(conversationKey);
        this.pendingUserMessageMeta.delete(conversationKey);
        this.deleteMessageHookInboundDedupKeys(droppedInboundDedupKeys);
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
      const queuedMeta = [...(this.pendingUserMessageMeta.get(conversationKey) ?? [])];
      const consumedInboundDedupKeys = this.messageHookInboundDedupKeysForQueue(conversationKey);
      const userText = queuedItems.join("\n");
      const outboundDedupKey = this.messageHookDedupKey("outbound", ev, assistantText, queuedMeta, userText);
      if (this.markMessageHookDuplicate(outboundDedupKey, sessionId)) {
        this.pendingUserMessages.delete(conversationKey);
        this.pendingUserMessageMeta.delete(conversationKey);
        this.clearMessageHookInboundDedupKeys(consumedInboundDedupKeys);
        return;
      }
      this.pendingUserMessages.delete(conversationKey);
      this.pendingUserMessageMeta.delete(conversationKey);
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
          this.clearMessageHookInboundDedupKeys(consumedInboundDedupKeys);
          return; // W4a already wrote
        }
        // T10 — Cross-path in-flight check. If W4a is mid-persist for
        // this pair, skip; W4a will own the persist. We've already
        // consumed the pending user above (line 508), which is correct
        // because W4a IS persisting it.
        if (this.peekCrossPathInflight(sessionId, w4aOrigin)) {
          this.clearMessageHookInboundDedupKeys(consumedInboundDedupKeys);
          return;
        }
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
        const w4bInflight = this.w4bInflightKey(ev, userText, assistantText, queuedMeta);
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
        const w4bDiscriminator = this.w4bDaemonTurnIdDiscriminator(ev, queuedMeta);
        const w4bMarkerOccurrences = this.typedW4bMarkerOccurrences(w4bDiscriminator, queuedMeta);
        const w4bInflightMarkerOrigins = this.typedW4bInflightOriginsFromOccurrences(
          sessionId,
          userText,
          assistantText,
          w4bMarkerOccurrences,
        );
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
        let w4bJob: Promise<void> | undefined;
        w4bJob = this.trackPersistJob(sessionId, async () => {
          let daemonPersisted = false;
          try {
            await this.persistOne(sessionId, userText, assistantText, turnId);
            daemonPersisted = true;
            // Post-success: stamp the content-only `w4bOrigin` key on
            // the SHORT-TTL cross-path map (T5) so a later W4a
            // `agent_end` last-pair peek can see that W4b already
            // persisted THIS turn and skip + bumpWatermark, but a
            // repeated same-content turn arriving outside the 5s
            // cross-path window doesn't false-dedup against this stamp.
            this.markCrossPathStamp(sessionId, this.w4bOriginKey(userText, assistantText));
            // R18.2 — Track the W4b session count under the durable session
            // we can prove. Conversationless typed turns keep their isolated
            // conversationless count and add per-message markers; promotion
            // must not copy that count into the first later concrete chat.
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
              const markerChanged = this.markTypedW4bTurnPersisted(
                sessionId,
                userText,
                assistantText,
                w4bMarkerOccurrences,
              );
              const countChanged = true;
              this.w4bSessionCounts.set(
                sessionId,
                (this.w4bSessionCounts.get(sessionId) ?? 0) + 1,
              );
              // T17 — Persist the new count/marker to disk via the
              // debounced flush so a process restart preserves the
              // "skip these pairs in computeDelta" fact.
              // Without this, setup-runtime → restart → upgrade
              // to full would replay every W4b-persisted turn as
              // backfill (count resets to 0, watermark file is
              // still -1, savedUpTo computes to -1, computeDelta
              // emits everything).
              if ((markerChanged || countChanged) && !this.commitWatermarkStateSync(sessionId)) {
                this.scheduleWatermarkFlush(sessionId, { retryOnFailure: true, attempts: 3 });
                throw new Error("Failed to write W4b chat-turn watermark");
              }
              this.clearMessageHookInboundDedupKeys(consumedInboundDedupKeys);
            }
          } catch (err) {
            if (daemonPersisted) {
              this.logger.error?.(
                "[ChatTurnWriter.onMessageSent] Persist succeeded but durable W4b state write failed",
                { err },
              );
              return;
            }
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
              const restoredMeta = this.pendingUserMessageMeta.get(conversationKey) ?? [];
              restoredMeta.unshift(...queuedMeta);
              this.pendingUserMessageMeta.set(conversationKey, restoredMeta);
            }
            // Release the in-flight reservation so a retry can proceed.
            // No `w4bOrigin` release needed — we don't stamp it pre-persist
            // anymore; only stamping happens post-success above.
            if (outboundDedupKey) this.deleteMessageHookDedupKey(outboundDedupKey);
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
        });
        this.markPersistJobOrigin(w4bJob, w4bOriginKey);
        for (const origin of w4bInflightMarkerOrigins) {
          this.markPersistJobOrigin(w4bJob, origin);
        }
        w4bJob.catch(() => {});
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

  private messageEventId(ev: InternalMessageEvent): string | undefined {
    const ctx = (ev as any)?.context ?? {};
    return firstString(ctx.messageId, (ev as any)?.messageId);
  }

  private nextPendingUserArrivalId(): string {
    this.pendingUserMessageSeq = (this.pendingUserMessageSeq + 1) >>> 0;
    return `arrival::${this.pendingUserMessageSeq}`;
  }

  private pendingUserArrivalOrder(meta?: PendingUserMessageMeta): number {
    const match = typeof meta?.arrivalId === "string" ? /^arrival::(\d+)$/.exec(meta.arrivalId) : null;
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  private messageHookDedupKey(
    direction: "inbound" | "outbound",
    ev: InternalMessageEvent,
    text: string,
    pendingMeta: PendingUserMessageMeta[] = [],
    userText = "",
  ): string {
    const ctx = (ev as any)?.context ?? {};
    const channelId = firstString(ctx.channelId, (ev as any)?.channelId) ?? "unknown";
    if (channelId === "dkg-ui") return "";
    const accountId = firstString(ctx.accountId) ?? "";
    const conversationId = firstString(ctx.conversationId) ?? "";
    const sessionKey = firstString(ev.sessionKey, ctx.sessionKey) ?? "";
    const scopeParts = conversationId
      ? [channelId, accountId, conversationId]
      : [channelId, accountId, conversationId, sessionKey];
    const messageId = this.messageEventId(ev);
    if (messageId) {
      return [
        "message-hook",
        direction,
        "msg",
        this.identityHash([...scopeParts, messageId]),
      ].join("::");
    }
    if (direction === "inbound") {
      // Without a provider messageId, only dedupe duplicate hook surfaces
      // delivered in the same dispatch batch. A longer text cache would drop
      // legitimate repeated user messages before one assistant reply.
      return [
        ChatTurnWriter.MESSAGE_HOOK_NO_ID_INBOUND_PREFIX,
        this.identityHash([...scopeParts, text]),
      ].join("");
    }
    if (direction === "outbound") {
      const inboundIds = pendingMeta
        .map((meta) => meta.messageId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (inboundIds.length > 0) {
        return [
          "message-hook",
          direction,
          "inbound-msg",
          this.identityHash([...scopeParts, ...inboundIds, text]),
        ].join("::");
      }
      const arrivalIds = pendingMeta
        .map((meta) => meta.arrivalId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (arrivalIds.length > 0) {
        return [
          "message-hook",
          direction,
          "arrival",
          this.identityHash([...scopeParts, ...arrivalIds, text]),
        ].join("::");
      }
      return [
        "message-hook",
        direction,
        "turn-text",
        this.identityHash([...scopeParts, userText, text]),
      ].join("::");
    }
    return "";
  }

  private markMessageHookDuplicate(key: string, sessionId?: string): boolean {
    if (!key) return false;
    if (this.isNoIdInboundBatchKey(key)) {
      return this.markNoIdInboundBatchDuplicate(key, sessionId);
    }
    const now = Date.now();
    const ttl = ChatTurnWriter.MESSAGE_HOOK_DEDUP_TTL_MS;
    const existingTs = this.messageHookDedup.get(key);
    if (existingTs !== undefined) {
      if (now - existingTs <= ttl) return true;
      this.deleteMessageHookDedupKey(key);
    }
    if (
      now - this.messageHookLastSweepAt >= ChatTurnWriter.MESSAGE_HOOK_DEDUP_SWEEP_INTERVAL_MS ||
      this.messageHookDedup.size >= ChatTurnWriter.MESSAGE_HOOK_DEDUP_MAX_ENTRIES
    ) {
      for (const [existingKey, ts] of this.messageHookDedup) {
        if (now - ts > ttl) {
          this.deleteMessageHookDedupKey(existingKey);
        }
      }
      this.messageHookLastSweepAt = now;
    }
    while (this.messageHookDedup.size >= ChatTurnWriter.MESSAGE_HOOK_DEDUP_MAX_ENTRIES) {
      const oldestKey = this.messageHookDedup.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.deleteMessageHookDedupKey(oldestKey);
    }
    this.messageHookDedup.set(key, now);
    if (sessionId) this.messageHookDedupSessionKeys.set(key, sessionId);
    else this.messageHookDedupSessionKeys.delete(key);
    return false;
  }

  private isNoIdInboundBatchKey(key: string): boolean {
    return key.startsWith(ChatTurnWriter.MESSAGE_HOOK_NO_ID_INBOUND_PREFIX);
  }

  private markNoIdInboundBatchDuplicate(key: string, sessionId?: string): boolean {
    if (this.messageHookNoIdInboundBatch.has(key)) return true;
    this.messageHookNoIdInboundBatch.add(key);
    if (sessionId) this.messageHookDedupSessionKeys.set(key, sessionId);
    else this.messageHookDedupSessionKeys.delete(key);
    if (!this.messageHookNoIdInboundBatchClearScheduled) {
      this.messageHookNoIdInboundBatchClearScheduled = true;
      queueMicrotask(() => {
        this.messageHookNoIdInboundBatchClearScheduled = false;
        const keys = Array.from(this.messageHookNoIdInboundBatch);
        this.messageHookNoIdInboundBatch.clear();
        for (const batchKey of keys) {
          this.deleteMessageHookDedupKey(batchKey);
        }
      });
    }
    return false;
  }

  private deleteMessageHookDedupKey(key: string): void {
    this.messageHookDedup.delete(key);
    this.messageHookNoIdInboundBatch.delete(key);
    this.messageHookInboundQueueKeys.delete(key);
    this.messageHookDedupSessionKeys.delete(key);
  }

  private clearMessageHookDedupForSessions(sessionIds: Iterable<string>): void {
    const ids = new Set(Array.from(sessionIds).filter((id) => typeof id === "string" && id.length > 0));
    if (ids.size === 0) return;
    for (const [key, sessionId] of Array.from(this.messageHookDedupSessionKeys.entries())) {
      if (ids.has(sessionId)) this.deleteMessageHookDedupKey(key);
    }
    for (const [key, queueKey] of Array.from(this.messageHookInboundQueueKeys.entries())) {
      if (ids.has(queueKey)) this.deleteMessageHookDedupKey(key);
    }
  }

  private messageHookInboundDedupKeysForQueue(queueKey: string): string[] {
    return Array.from(this.messageHookInboundQueueKeys.entries())
      .filter(([, currentQueueKey]) => currentQueueKey === queueKey)
      .map(([key]) => key);
  }

  private clearMessageHookInboundDedupKeys(keys: string[]): void {
    for (const key of keys) {
      // Provider messageId keys stay in the TTL cache after the queue is
      // consumed, so a late retry of the same inbound cannot seed stale text
      // for the next outbound. Only batch-scoped no-ID keys are disposable.
      if (this.isNoIdInboundBatchKey(key)) {
        this.deleteMessageHookDedupKey(key);
      }
    }
  }

  private deleteMessageHookInboundDedupKeys(keys: string[]): void {
    for (const key of keys) {
      this.deleteMessageHookDedupKey(key);
    }
  }

  private shouldMoveInboundQueue(existingKey: string, candidateKey: string): boolean {
    const existing = this.parseComposedSessionId(existingKey);
    const candidate = this.parseComposedSessionId(candidateKey);
    if (!existing || !candidate) return false;
    const existingStrong = existing.sessionKey.length > 0 && !this.isWeakSessionKey(existing.sessionKey);
    const candidateStrong = candidate.sessionKey.length > 0 && !this.isWeakSessionKey(candidate.sessionKey);
    if (existingStrong && candidateStrong) {
      return (
        existing.channelId === candidate.channelId &&
        existing.accountId === candidate.accountId &&
        existing.conversationId === candidate.conversationId &&
        existing.sessionKey !== candidate.sessionKey
      );
    }
    return candidateStrong && !existingStrong;
  }

  private pendingQueueUsesTypedSessionFallback(queueKey: string): boolean {
    const messages = this.pendingUserMessages.get(queueKey) ?? [];
    const meta = this.pendingUserMessageMeta.get(queueKey) ?? [];
    return messages.length > 0 && messages.every((_, index) => meta[index]?.typedSessionIdFallback === true);
  }

  private shouldMoveInboundQueueForOutbound(
    existingKey: string,
    targetKey: string,
  ): boolean {
    const existing = this.parseComposedSessionId(existingKey);
    const target = this.parseComposedSessionId(targetKey);
    if (!existing || !target) return false;
    if (!target.conversationId) return false;
    if (existing.channelId !== target.channelId) return false;
    if (existing.accountId !== target.accountId) return false;
    if (existing.conversationId !== target.conversationId) return false;
    const existingWeak = this.isWeakSessionKey(existing.sessionKey);
    const targetWeak = this.isWeakSessionKey(target.sessionKey);
    if (existingWeak !== targetWeak) return true;
    if (this.pendingQueueUsesTypedSessionFallback(existingKey) && !targetWeak) return true;
    return false;
  }

  private promotePendingInboundQueueForOutbound(targetKey: string): void {
    const candidates: string[] = [];
    for (const [candidateKey, messages] of Array.from(this.pendingUserMessages.entries())) {
      if (candidateKey === targetKey || !messages || messages.length === 0) continue;
      if (this.shouldMoveInboundQueueForOutbound(candidateKey, targetKey)) {
        candidates.push(candidateKey);
      }
    }
    for (const candidateKey of candidates) this.movePendingInboundQueue(candidateKey, targetKey);
  }

  private movePendingInboundQueue(fromKey: string, toKey: string): void {
    if (fromKey === toKey) return;
    const messages = this.pendingUserMessages.get(fromKey);
    const meta = this.pendingUserMessageMeta.get(fromKey);
    if (messages && messages.length > 0) {
      const targetMessages = this.pendingUserMessages.get(toKey) ?? [];
      const targetMeta = this.pendingUserMessageMeta.get(toKey) ?? [];
      const merged = [
        ...targetMessages.map((text, index) => ({ text, meta: targetMeta[index] })),
        ...messages.map((text, index) => ({ text, meta: meta?.[index] })),
      ].sort((a, b) => this.pendingUserArrivalOrder(a.meta) - this.pendingUserArrivalOrder(b.meta));
      this.pendingUserMessages.set(toKey, merged.map((item) => item.text));
      this.pendingUserMessageMeta.set(toKey, merged.map((item) => item.meta ?? {}));
      this.pendingUserMessages.delete(fromKey);
    }
    this.pendingUserMessageMeta.delete(fromKey);
    this.rebindMessageHookInboundQueueKeys(fromKey, toKey);
  }

  private rebindMessageHookInboundQueueKeys(fromKey: string, toKey: string): void {
    for (const [key, queueKey] of Array.from(this.messageHookInboundQueueKeys.entries())) {
      if (queueKey !== fromKey) continue;
      this.messageHookInboundQueueKeys.set(key, toKey);
      this.messageHookDedupSessionKeys.set(key, toKey);
    }
  }

  private w4bInflightGuardSessionIds(identity: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
  }, sessionId: string): string[] {
    const ids = new Set<string>([sessionId]);
    if (identity.channelId && identity.conversationId) {
      const weakSession = this.weakSessionKey(identity.channelId, identity.accountId, identity.conversationId);
      if (weakSession) {
        ids.add(this.composeSessionId({ ...identity, sessionKey: weakSession }));
      }
    }
    return Array.from(ids);
  }

  private w4aCrossPathSessionIds(identity: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
  }, sessionId: string): string[] {
    const ids = new Set<string>([sessionId]);
    if (!identity.channelId || !identity.conversationId) return Array.from(ids);
    const weakSession = this.weakSessionKey(identity.channelId, identity.accountId, identity.conversationId);
    if (weakSession) {
      ids.add(this.composeSessionId({ ...identity, sessionKey: weakSession }));
    }
    return Array.from(ids);
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
    const applied = this.applyPendingWatermarks();
    if (applied) {
      this.writeWatermarkFile();
    }
  }

  private applyPendingWatermarks(sessionId?: string): boolean {
    let applied = false;
    for (const [key, entry] of Array.from(this.debounceTimers.entries())) {
      if (sessionId && key !== sessionId) continue;
      clearTimeout(entry.timer);
      this.cachedWatermarks.set(key, entry.pendingIndex);
      this.debounceTimers.delete(key);
      applied = true;
    }
    return applied;
  }

  private commitWatermarkStateSync(sessionId?: string): boolean {
    this.applyPendingWatermarks(sessionId);
    return this.writeWatermarkFile();
  }

  private snapshotWatermarksForWrite(): Map<string, number> {
    const wm = new Map(this.cachedWatermarks);
    for (const [key, entry] of this.debounceTimers.entries()) {
      wm.set(key, entry.pendingIndex);
    }
    return wm;
  }

  private snapshotWatermarkState(sessionId: string): WatermarkStateSnapshot {
    return {
      cachedHad: this.cachedWatermarks.has(sessionId),
      cachedIndex: this.cachedWatermarks.get(sessionId),
      pendingIndex: this.debounceTimers.get(sessionId)?.pendingIndex,
    };
  }

  private restoreWatermarkState(sessionId: string, snapshot: WatermarkStateSnapshot): void {
    const existing = this.debounceTimers.get(sessionId);
    if (existing) clearTimeout(existing.timer);
    this.debounceTimers.delete(sessionId);
    if (snapshot.cachedHad) {
      this.cachedWatermarks.set(sessionId, snapshot.cachedIndex ?? -1);
    } else {
      this.cachedWatermarks.delete(sessionId);
    }
    if (snapshot.pendingIndex !== undefined) {
      this.saveWatermark(sessionId, snapshot.pendingIndex);
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
  ): ComputedChatTurnPair[] {
    const pairs: ComputedChatTurnPair[] = [];
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
    // Both shapes are handled by accumulating consecutive real user
    // messages, keeping the latest textual non-tool assistant candidate,
    // and flushing only when the next real user arrives (or the transcript
    // ends). Any assistant carrying tool calls is treated as intermediate
    // regardless of whether it also has text content.
    const pendingUsers: Array<{
      text: string;
      externalTurnIds: string[];
      externalDirect: boolean;
      messageIds: string[];
    }> = [];
    let pendingAssistant: {
      text: string;
      assistantMessageIds: string[];
    } | null = null;
    let pairIndex = 0;
    const flushPair = () => {
      if (!pendingAssistant || pendingUsers.length === 0) return;
      const userText = pendingUsers.map((pending) => pending.text).join("\n");
      const externalDirect = pendingUsers.length === 1 && pendingUsers[0].externalDirect;
      const externalTurnIds = externalDirect
        ? Array.from(new Set(pendingUsers.flatMap((pending) => pending.externalTurnIds)))
        : [];
      const messageIds = Array.from(new Set(pendingUsers.flatMap((pending) => pending.messageIds)));
      pendingUsers.length = 0;
      if (pairIndex > savedUpTo) {
        pairs.push({
          user: userText,
          assistant: this.stripRecalledMemory(pendingAssistant.text),
          pairIndex,
          externalTurnIds,
          externalDirect,
          messageIds,
          assistantMessageIds: pendingAssistant.assistantMessageIds,
        });
      }
      pendingAssistant = null;
      pairIndex++;
    };
    for (const msg of messages) {
      if (this.isTranscriptScaffoldingMessage(msg)) continue;
      if (msg.role === "user") {
        flushPair();
        // T28 — Skip image/attachment-only user messages whose
        // `extractText()` returns "" (the multi-modal content array
        // contained no `type === "text"` parts). W4b's
        // `onMessageReceived` already drops empty inbound text via
        // R15.2 to avoid persisting blank-user turns; W4a must mirror
        // that semantic in `computeDelta` or it produces an
        // assistant-only pair (`{ user: "", assistant: reply }`)
        // for any image-only user message followed by a reply.
        const userText = this.extractText(msg.content);
        if (userText) {
          pendingUsers.push({
            text: userText,
            externalTurnIds: this.extractExternalTurnIds(msg),
            externalDirect: this.hasExternalDirectChannelMetadata(msg),
            messageIds: this.extractMessageIds(msg),
          });
        }
      } else if (msg.role === "assistant") {
        const text = this.extractText(msg.content);
        const hasToolCalls = this.hasToolCalls(msg);
        if (hasToolCalls) {
          // Intermediate tool-call step — do NOT count as a pair, do NOT
          // advance pairIndex (the watermark counts user-visible turns),
          // and do NOT consume `pendingUsers`. The next non-tool-call
          // assistant is the real final reply that belongs to the
          // accumulated user side.
          pendingAssistant = null;
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
        pendingAssistant = {
          text,
          assistantMessageIds: this.extractMessageIds(msg),
        };
      }
      // Skip `tool` and `system` messages — they don't form turns.
    }
    flushPair();
    return pairs;
  }

  private hasToolCalls(msg: ChatTurnMessage): boolean {
    const context = msg.context && typeof msg.context === "object" ? msg.context : {};
    const metadata = msg.metadata && typeof msg.metadata === "object" ? msg.metadata : {};
    return [
      (msg as any).toolCalls,
      (msg as any).tool_calls,
      (context as any).toolCalls,
      (context as any).tool_calls,
      (metadata as any).toolCalls,
      (metadata as any).tool_calls,
    ].some((value) => Array.isArray(value) && value.length > 0);
  }

  private isTranscriptScaffoldingMessage(msg: ChatTurnMessage): boolean {
    const role = (msg as any)?.role;
    if (role === "system" || role === "tool" || role === "function") return true;
    const context = msg.context && typeof msg.context === "object" ? msg.context : {};
    const metadata = msg.metadata && typeof msg.metadata === "object" ? msg.metadata : {};
    const values = [msg as any, context as any, metadata as any];
    return values.some((value) =>
      value.toolCallId !== undefined ||
      value.tool_call_id !== undefined ||
      value.toolResult === true ||
      value.tool_result === true,
    );
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

  private extractExternalTurnIds(msg: ChatTurnMessage): string[] {
    const ids = new Set<string>();
    const add = (value: unknown): void => {
      if (typeof value === "string" && value.trim()) ids.add(value.trim());
    };

    add((msg as any).dkgTurnId);
    add((msg as any).DkgTurnId);
    add((msg as any).turnId);
    add((msg as any).correlationId);

    const context = msg.context;
    if (context && typeof context === "object") {
      add((context as any).dkgTurnId);
      add((context as any).DkgTurnId);
      add((context as any).turnId);
      add((context as any).correlationId);
      add((context as any).CorrelationId);
    }

    const metadata = msg.metadata;
    if (metadata && typeof metadata === "object") {
      add((metadata as any).dkgTurnId);
      add((metadata as any).DkgTurnId);
      add((metadata as any).turnId);
      add((metadata as any).correlationId);
      add((metadata as any).CorrelationId);
    }

    return Array.from(ids);
  }

  private extractMessageIds(msg: ChatTurnMessage): string[] {
    const context = msg.context && typeof msg.context === "object" ? msg.context : {};
    const metadata = msg.metadata && typeof msg.metadata === "object" ? msg.metadata : {};
    const messageId = firstString(
      (msg as any).messageId,
      (context as any).messageId,
      (metadata as any).messageId,
      (msg as any).MessageId,
      (context as any).MessageId,
      (metadata as any).MessageId,
      (msg as any).message_id,
      (context as any).message_id,
      (metadata as any).message_id,
    );
    return messageId ? [messageId] : [];
  }

  private hasExternalDirectChannelMetadata(msg: ChatTurnMessage): boolean {
    const values: unknown[] = [
      (msg as any).channelId,
      (msg as any).provider,
      (msg as any).Provider,
      (msg as any).surface,
      (msg as any).Surface,
    ];
    const context = msg.context;
    if (context && typeof context === "object") {
      values.push(
        (context as any).channelId,
        (context as any).provider,
        (context as any).Provider,
        (context as any).surface,
        (context as any).Surface,
      );
    }
    const metadata = msg.metadata;
    if (metadata && typeof metadata === "object") {
      values.push(
        (metadata as any).channelId,
        (metadata as any).provider,
        (metadata as any).Provider,
        (metadata as any).surface,
        (metadata as any).Surface,
      );
    }
    return values.some((value) => typeof value === "string" && value === "dkg-ui");
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

  private identityHash(parts: string[]): string {
    return createHash("sha256")
      .update(JSON.stringify(parts))
      .digest("hex")
      .slice(0, 16);
  }

  private weakSessionKey(
    channelId?: string,
    accountId?: string,
    conversationId?: string,
  ): string {
    const weakIdentity = firstString(conversationId);
    if (!channelId || !weakIdentity) return "";
    return `${ChatTurnWriter.WEAK_SESSION_PREFIX}${this.identityHash([
      channelId,
      accountId ?? "",
      weakIdentity,
    ])}`;
  }

  private isWeakSessionKey(sessionKey?: unknown): boolean {
    return typeof sessionKey === "string" && sessionKey.startsWith(ChatTurnWriter.WEAK_SESSION_PREFIX);
  }

  private externalTurnMarkerId(turnId?: unknown, user?: string, assistant?: string): string {
    if (typeof turnId !== "string" || turnId.trim().length === 0) return "";
    const idHash = createHash("sha256").update(turnId.trim()).digest("hex").slice(0, 16);
    if (typeof user !== "string" || typeof assistant !== "string") {
      return `external-id::${idHash}`;
    }
    return `external-id::${idHash}::${this.contentHash(user, this.stripRecalledMemory(assistant))}`;
  }

  private typedW4bExternalMarkerId(user: string, assistant: string, occurrence: string): string {
    if (!occurrence) return "";
    return `weak-w4b::${this.identityHash([occurrence])}::${this.contentHash(user, this.stripRecalledMemory(assistant))}`;
  }

  private typedW4bExternalMarkerIds(
    user: string,
    assistant: string,
    messageIds: string[],
    assistantMessageIds: string[] = [],
  ): string[] {
    const markers = new Set<string>();
    const inboundOccurrence = this.w4bInboundMessageDiscriminator(messageIds);
    const inboundMarker = this.typedW4bExternalMarkerId(user, assistant, inboundOccurrence);
    if (inboundMarker) markers.add(inboundMarker);
    for (const outboundOccurrence of this.w4bOutboundMessageDiscriminators(assistantMessageIds)) {
      const outboundMarker = this.typedW4bExternalMarkerId(user, assistant, outboundOccurrence);
      if (outboundMarker) markers.add(outboundMarker);
    }
    return Array.from(markers);
  }

  private typedW4bInflightOrigin(cursorKey: string, marker: string): string {
    return `typed-w4b-marker::${this.identityHash([cursorKey, marker])}`;
  }

  private typedW4bInflightOrigins(
    cursorKeys: string[],
    user: string,
    assistant: string,
    messageIds: string[],
    assistantMessageIds: string[] = [],
  ): string[] {
    return this.typedW4bInflightOriginsForMarkers(
      cursorKeys,
      this.typedW4bExternalMarkerIds(user, assistant, messageIds, assistantMessageIds),
    );
  }

  private typedW4bInflightOriginsFromOccurrences(
    sessionId: string,
    user: string,
    assistant: string,
    occurrences: string[],
  ): string[] {
    const markers = occurrences
      .map((occurrence) => this.typedW4bExternalMarkerId(user, assistant, occurrence))
      .filter((marker) => marker.length > 0);
    return this.typedW4bInflightOriginsForMarkers(
      this.typedW4bMarkerCursorKeysFromSessionId(sessionId),
      markers,
    );
  }

  private typedW4bInflightOriginsForMarkers(cursorKeys: string[], markers: string[]): string[] {
    const origins = new Set<string>();
    for (const cursorKey of cursorKeys) {
      for (const marker of markers) {
        origins.add(this.typedW4bInflightOrigin(cursorKey, marker));
      }
    }
    return Array.from(origins);
  }

  private findTypedW4bExternalMarker(
    cursorKeys: string[],
    user: string,
    assistant: string,
    messageIds: string[],
    assistantMessageIds: string[] = [],
  ): { cursorKey: string; marker: string } | null {
    const markers = this.typedW4bExternalMarkerIds(user, assistant, messageIds, assistantMessageIds);
    for (const cursorKey of cursorKeys) {
      for (const marker of markers) {
        if (this.hasExternalTurnMarker(cursorKey, marker)) return { cursorKey, marker };
      }
    }
    return null;
  }

  private markTypedW4bTurnPersisted(
    sessionId: string,
    user: string,
    assistant: string,
    occurrences: string[],
  ): boolean {
    const cursors = this.typedW4bMarkerCursorKeysFromSessionId(sessionId);
    if (cursors.length === 0) return false;
    let changed = false;
    for (const cursor of cursors) {
      const bucket = this.externalTurnMarkers.get(cursor) ?? new Map<string, number>();
      for (const occurrence of occurrences) {
        const marker = this.typedW4bExternalMarkerId(user, assistant, occurrence);
        if (!marker) continue;
        bucket.set(marker, (bucket.get(marker) ?? 0) + 1);
        changed = true;
      }
      if (bucket.size > 0) this.externalTurnMarkers.set(cursor, bucket);
    }
    return changed;
  }

  private consumeExternalTurnMarkersForPair(
    sessionKeyCursor: string,
    turnIds: string[],
    user: string,
    assistant: string,
  ): ExternalMarkerAction {
    for (const turnId of turnIds) {
      const marker = this.externalTurnMarkerId(turnId, user, assistant);
      if (marker && this.hasExternalTurnMarker(sessionKeyCursor, marker)) {
        // Content-bound exact markers are durable daemon-success facts,
        // not one-shot tickets. Keep them for later reset/compaction
        // replays until a future transcript-retention cursor can prove
        // safe GC.
        return { skip: true, markers: [marker], rollbackMarkers: [] };
      }
    }
    return { skip: false, markers: [], rollbackMarkers: [] };
  }

  private hasExternalTurnMarker(sessionKeyCursor: string, marker: string): boolean {
    const bucket = this.externalTurnMarkers.get(sessionKeyCursor);
    return (bucket?.get(marker) ?? 0) > 0;
  }

  private consumeExternalTurnMarker(sessionKeyCursor: string, marker: string): boolean {
    const bucket = this.externalTurnMarkers.get(sessionKeyCursor);
    if (!bucket) return false;
    const count = bucket.get(marker) ?? 0;
    if (count <= 0) return false;
    if (count === 1) {
      bucket.delete(marker);
    } else {
      bucket.set(marker, count - 1);
    }
    if (bucket.size === 0) {
      this.externalTurnMarkers.delete(sessionKeyCursor);
    }
    return true;
  }

  private restoreExternalTurnMarker(sessionKeyCursor: string, marker: string): void {
    if (!marker) return;
    const bucket = this.externalTurnMarkers.get(sessionKeyCursor) ?? new Map<string, number>();
    bucket.set(marker, Math.max(bucket.get(marker) ?? 0, 1));
    this.externalTurnMarkers.set(sessionKeyCursor, bucket);
  }

  private restoreExternalTurnMarkerCount(sessionKeyCursor: string, marker: string, count: number): void {
    if (!marker) return;
    const bucket = this.externalTurnMarkers.get(sessionKeyCursor);
    if (count > 0) {
      const target = bucket ?? new Map<string, number>();
      target.set(marker, count);
      this.externalTurnMarkers.set(sessionKeyCursor, target);
      return;
    }
    if (!bucket) return;
    bucket.delete(marker);
    if (bucket.size === 0) {
      this.externalTurnMarkers.delete(sessionKeyCursor);
    }
  }

  private cloneExternalTurnMarkers(
    source: Map<string, Map<string, number>>,
  ): Map<string, Map<string, number>> {
    const clone = new Map<string, Map<string, number>>();
    for (const [key, markers] of source) {
      clone.set(key, new Map(markers));
    }
    return clone;
  }

  private mergeExternalTurnMarkers(
    target: Map<string, Map<string, number>>,
    key: string,
    markers: Record<string, unknown>,
  ): void {
    const bucket = target.get(key) ?? new Map<string, number>();
    for (const [marker, count] of Object.entries(markers)) {
      if (typeof count === "number" && count > 0) {
        bucket.set(marker, Math.max(bucket.get(marker) ?? 0, count));
      }
    }
    if (bucket.size > 0) target.set(key, bucket);
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
  private w4bInflightKey(
    ev: InternalMessageEvent,
    user: string,
    assistant: string,
    pendingMeta: PendingUserMessageMeta[] = [],
  ): string {
    const messageId = this.w4bMessageDiscriminator(ev, pendingMeta);
    if (messageId) {
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
  private w4bDaemonTurnIdDiscriminator(
    ev: InternalMessageEvent,
    pendingMeta: PendingUserMessageMeta[] = [],
  ): string {
    const messageId = this.w4bMessageDiscriminator(ev, pendingMeta);
    if (messageId) {
      return `msg::${messageId}`;
    }
    // Reuse the same monotonic counter — fallback is rare and best-effort.
    this.w4bInflightSeq = (this.w4bInflightSeq + 1) >>> 0;
    return `seq::${this.w4bInflightSeq}`;
  }

  private w4bMessageDiscriminator(
    ev: InternalMessageEvent,
    pendingMeta: PendingUserMessageMeta[],
  ): string {
    const outboundMessageId = this.messageEventId(ev);
    if (outboundMessageId) return `out::${outboundMessageId}`;
    const inboundIds = pendingMeta
      .map((meta) => meta.messageId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return this.w4bInboundMessageDiscriminator(inboundIds);
  }

  private w4bInboundMessageDiscriminator(messageIds: string[]): string {
    const ids = messageIds
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (ids.length === 0) return "";
    return `in::${this.identityHash(ids)}`;
  }

  private w4bOutboundMessageDiscriminators(messageIds: string[]): string[] {
    return Array.from(new Set(messageIds
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
      .map((id) => `out::${id}`)));
  }

  private typedW4bMarkerOccurrences(
    discriminator: string,
    pendingMeta: PendingUserMessageMeta[],
  ): string[] {
    const occurrences = new Set<string>();
    const normalizedDiscriminator = discriminator.startsWith("msg::")
      ? discriminator.slice("msg::".length)
      : discriminator;
    if (normalizedDiscriminator.startsWith("in::") || normalizedDiscriminator.startsWith("out::")) {
      occurrences.add(normalizedDiscriminator);
    }
    const inboundIds = pendingMeta
      .map((meta) => meta.messageId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const inboundDiscriminator = this.w4bInboundMessageDiscriminator(inboundIds);
    if (inboundDiscriminator) occurrences.add(inboundDiscriminator);
    return Array.from(occurrences);
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
    const identity = this.identityFieldsFromPayload(ctx);
    if (!identity.channelId || !identity.sessionKey) return "";
    return this.composeSessionId(identity);
  }

  private identityFieldsFromPayload(payload?: any): {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
  } {
    if (!payload || typeof payload !== "object") return {};
    const nested = typeof payload.context === "object" && payload.context ? payload.context : {};
    const pick = (key: "channelId" | "accountId" | "conversationId" | "sessionKey"): string | undefined => {
      const direct = payload[key];
      if (typeof direct === "string") return direct;
      const nestedValue = (nested as any)[key];
      return typeof nestedValue === "string" ? nestedValue : undefined;
    };
    return {
      channelId: pick("channelId"),
      accountId: pick("accountId"),
      conversationId: pick("conversationId"),
      sessionKey: pick("sessionKey"),
    };
  }

  private resetIdentityFromHookPayload(event?: any, ctx?: any): {
    sessionId: string;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
    externalCursorKey?: string;
  } {
    const ctxFields = this.identityFieldsFromPayload(ctx);
    const eventFields = this.identityFieldsFromPayload(event);
    const identity = {
      channelId: ctxFields.channelId ?? eventFields.channelId,
      accountId: ctxFields.accountId ?? eventFields.accountId,
      conversationId: ctxFields.conversationId ?? eventFields.conversationId,
      sessionKey: ctxFields.sessionKey ?? eventFields.sessionKey,
    };
    const sessionId = identity.channelId && identity.sessionKey
      ? this.composeSessionId(identity)
      : "";
    return {
      ...identity,
      sessionId,
      externalCursorKey: this.externalCursorKeyFromSessionKey(identity.sessionKey),
    };
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
    const identity = {
      channelId: ctx.channelId ?? (ev as any)?.channelId,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      sessionKey: ev.sessionKey,
    };
    return this.composeSessionId(identity);
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

  private externalCursorKeyFromSessionKey(sessionKey?: unknown): string {
    if (typeof sessionKey !== "string" || sessionKey.trim().length === 0) return "";
    return `openclaw:transcript:${this.encodeIdField(this.sanitize(sessionKey))}`;
  }

  private weakConversationCursorKey(parts: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
  }): string {
    if (!parts.channelId || !parts.conversationId) return "";
    return `openclaw:weak:${this.identityHash([
      this.encodeIdField(this.sanitize(parts.channelId)),
      this.encodeIdField(this.sanitize(parts.accountId ?? "")),
      this.encodeIdField(this.sanitize(parts.conversationId)),
    ])}`;
  }

  private weakConversationCursorKeyFromSessionId(sessionId: string): string {
    const parsed = this.parseComposedSessionId(sessionId);
    if (!parsed || !parsed.conversationId) return "";
    return `openclaw:weak:${this.identityHash([parsed.channelId, parsed.accountId, parsed.conversationId])}`;
  }

  private concreteSessionCursorKey(parts: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
  }): string {
    if (!parts.channelId || !parts.conversationId || !parts.sessionKey || this.isWeakSessionKey(parts.sessionKey)) {
      return "";
    }
    return `openclaw:typed:${this.identityHash([
      this.encodeIdField(this.sanitize(parts.channelId)),
      this.encodeIdField(this.sanitize(parts.accountId ?? "")),
      this.encodeIdField(this.sanitize(parts.conversationId)),
      this.encodeIdField(this.sanitize(parts.sessionKey)),
    ])}`;
  }

  private concreteSessionCursorKeyFromSessionId(sessionId: string): string {
    const parsed = this.parseComposedSessionId(sessionId);
    if (!parsed || !parsed.conversationId || !parsed.sessionKey || this.isWeakSessionKey(parsed.sessionKey)) return "";
    return `openclaw:typed:${this.identityHash([
      parsed.channelId,
      parsed.accountId,
      parsed.conversationId,
      parsed.sessionKey,
    ])}`;
  }

  private conversationlessSessionCursorKey(parts: {
    channelId?: string;
    accountId?: string;
    sessionKey?: string;
  }): string {
    if (!parts.channelId || !parts.sessionKey || this.isWeakSessionKey(parts.sessionKey)) return "";
    return `openclaw:session:${this.identityHash([
      this.encodeIdField(this.sanitize(parts.channelId)),
      this.encodeIdField(this.sanitize(parts.accountId ?? "")),
      this.encodeIdField(this.sanitize(parts.sessionKey)),
    ])}`;
  }

  private conversationlessSessionCursorKeyFromSessionId(sessionId: string): string {
    const parsed = this.parseComposedSessionId(sessionId);
    if (!parsed || parsed.conversationId || this.isWeakSessionKey(parsed.sessionKey)) return "";
    return `openclaw:session:${this.identityHash([parsed.channelId, parsed.accountId, parsed.sessionKey])}`;
  }

  private typedW4bMarkerCursorKeys(parts: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
  }): string[] {
    const cursors = [
      this.concreteSessionCursorKey(parts),
      this.weakConversationCursorKey(parts),
    ];
    if (!parts.conversationId) {
      cursors.push(this.conversationlessSessionCursorKey(parts));
    }
    return Array.from(new Set(cursors.filter((key) => key.length > 0)));
  }

  private typedW4bMarkerCursorKeysFromSessionId(sessionId: string): string[] {
    return Array.from(new Set([
      this.concreteSessionCursorKeyFromSessionId(sessionId),
      this.weakConversationCursorKeyFromSessionId(sessionId),
      this.conversationlessSessionCursorKeyFromSessionId(sessionId),
    ].filter((key) => key.length > 0)));
  }

  private collectResetSessionIds(identity: {
    sessionId: string;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
  }): string[] {
    const ids = new Set<string>();
    if (identity.sessionId) ids.add(identity.sessionId);
    if (identity.channelId && identity.conversationId) {
      const weakSession = this.weakSessionKey(identity.channelId, identity.accountId, identity.conversationId);
      if (weakSession) {
        ids.add(this.composeSessionId({ ...identity, sessionKey: weakSession }));
      }
    }
    if (!identity.channelId || !identity.sessionKey) return Array.from(ids);
    if (typeof identity.accountId !== "string" || typeof identity.conversationId !== "string") {
      return Array.from(ids);
    }
    const expected = {
      channelId: this.encodeIdField(this.sanitize(identity.channelId)),
      accountId: this.encodeIdField(this.sanitize(identity.accountId)),
      conversationId: this.encodeIdField(this.sanitize(identity.conversationId)),
      sessionKey: this.encodeIdField(this.sanitize(identity.sessionKey)),
    };
    for (const candidate of this.collectKnownSessionIds()) {
      const parsed = this.parseComposedSessionId(candidate);
      if (!parsed) continue;
      if (parsed.channelId !== expected.channelId) continue;
      if (parsed.sessionKey !== expected.sessionKey) continue;
      if (parsed.accountId !== expected.accountId) continue;
      if (parsed.conversationId !== expected.conversationId) continue;
      ids.add(candidate);
    }
    return Array.from(ids);
  }

  private collectKnownSessionIds(): Set<string> {
    const ids = new Set<string>();
    const add = (key: string): void => {
      if (this.parseComposedSessionId(key)) ids.add(key);
    };
    for (const key of this.cachedWatermarks.keys()) add(key);
    for (const key of this.w4bSessionCounts.keys()) add(key);
    for (const key of this.debounceTimers.keys()) add(key);
    for (const key of this.pendingUserMessages.keys()) add(key);
    for (const key of this.pendingUserMessageMeta.keys()) add(key);
    for (const key of this.messageHookInboundQueueKeys.values()) add(key);
    for (const key of this.messageHookDedupSessionKeys.values()) add(key);
    for (const key of this.inFlightPersists.keys()) add(key);
    for (const key of this.w4aSessionChains.keys()) add(key);
    for (const key of this.recentTurnIds.keys()) {
      add(this.sessionIdFromCompositeDedupKey(key));
    }
    for (const key of this.crossPathStamps.keys()) {
      add(this.sessionIdFromCompositeDedupKey(key));
    }
    for (const key of this.crossPathInflight.keys()) {
      add(this.sessionIdFromCompositeDedupKey(key));
    }
    return ids;
  }

  private sessionIdFromCompositeDedupKey(key: string): string {
    if (!key.startsWith("openclaw:")) return "";
    const parts = key.split(":");
    if (parts.length < 5) return "";
    const sessionId = parts.slice(0, 5).join(":");
    return this.parseComposedSessionId(sessionId) ? sessionId : "";
  }

  private parseComposedSessionId(sessionId: string): {
    channelId: string;
    accountId: string;
    conversationId: string;
    sessionKey: string;
  } | null {
    const parts = sessionId.split(":");
    if (parts.length !== 5 || parts[0] !== "openclaw") return null;
    return {
      channelId: parts[1],
      accountId: parts[2],
      conversationId: parts[3],
      sessionKey: parts[4],
    };
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
    const identity = {
      channelId: ctx.channelId ?? (ev as any)?.channelId,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      sessionKey: ev.sessionKey,
    };
    return this.composeSessionId(identity);
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
    // Prefer the pending debounce value if a saveWatermark is in flight.
    // saveWatermark schedules a 50ms debounce before committing to
    // `cachedWatermarks`; without this, two rapid `agent_end` fires
    // within that window both see -1 from `cachedWatermarks` and would
    // re-clamp under the cold-start guard (T362). bumpWatermark already
    // uses this pattern at its own call site; centralizing here keeps
    // the runAgentEndPersist `savedUpTo` derivation consistent.
    const pending = this.debounceTimers.get(sessionId);
    if (pending) return pending.pendingIndex;
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
   * that watermark updates use. Retry flushes may take over an existing
   * non-retry debounce timer while preserving that timer's pending
   * watermark index.
   */
  private scheduleWatermarkFlush(
    sessionId: string,
    opts: { retryOnFailure?: boolean; attempts?: number; pendingIndex?: number } = {},
  ): void {
    const existing = this.debounceTimers.get(sessionId);
    if (existing) {
      if (!opts.retryOnFailure) return;
      clearTimeout(existing.timer);
      this.debounceTimers.delete(sessionId);
      opts = { ...opts, pendingIndex: existing.pendingIndex };
    }
    const currentWatermark = opts.pendingIndex ?? this.cachedWatermarks.get(sessionId) ?? -1;
    const timer = setTimeout(() => {
      this.debounceTimers.delete(sessionId);
      this.cachedWatermarks.set(sessionId, currentWatermark);
      const wrote = this.writeWatermarkFile();
      if (!wrote && opts.retryOnFailure && (opts.attempts ?? 1) > 1) {
        this.scheduleWatermarkFlush(sessionId, {
          retryOnFailure: true,
          attempts: (opts.attempts ?? 1) - 1,
        });
      }
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
        // T71 — Info-level persist log so Telegram / W4b chat turns are as
        // visible in the gateway log as Node-UI / W4a turns (which log via
        // DkgChannelPlugin's `[dkg-channel] Turn persisted to DKG graph: …`
        // info line). Inline the sessionId/turnId into the message string;
        // the gateway logger drops the second context-object arg at info
        // level (only renders the first string arg), so a two-arg shape
        // would log "Persisted turn" with no detail.
        this.logger.info?.(`[ChatTurnWriter] Persisted turn (sessionId=${sessionId}, turnId=${turnId})`);
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

  private writeWatermarkFile(
    targetPath: string = this.watermarkFilePath,
    overrideMaps?: {
      wm: Map<string, number>;
      bc: Map<string, number>;
      markers?: Map<string, Map<string, number>>;
    },
  ): boolean {
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
      // T45 — `overrideMaps` lets `setStateDir` write a merged-but-
      // not-yet-committed watermark snapshot WITHOUT mutating the
      // live `cachedWatermarks` / `w4bSessionCounts`. That way a
      // concurrent persist arriving during the merge+write window
      // doesn't get wiped on write failure, and the merged values
      // only become "the source of truth" once the write succeeded.
      // T100 - Normal writes serialize every pending debounce watermark
      // into the durable snapshot without clearing unrelated timers. A
      // scoped sync commit for one session must not write a stale cached
      // watermark for another session that is still waiting on debounce.
      const wm = overrideMaps?.wm ?? this.snapshotWatermarksForWrite();
      const bc = overrideMaps?.bc ?? this.w4bSessionCounts;
      const markersByKey = overrideMaps?.markers ?? this.externalTurnMarkers;
      const allKeys = new Set<string>([
        ...wm.keys(),
        ...bc.keys(),
        ...markersByKey.keys(),
      ]);
      const data: Record<string, { w: number; b: number; m?: Record<string, number> }> = {};
      for (const key of allKeys) {
        const markers = markersByKey.get(key);
        data[key] = {
          w: wm.get(key) ?? -1,
          b: bc.get(key) ?? 0,
        };
        if (markers && markers.size > 0) {
          data[key].m = Object.fromEntries(markers.entries());
        }
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
