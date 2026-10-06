/**
 * OT-RFC-38 LU-6 — opaque ciphertext storage for core hosting of curated SWM.
 *
 * Core nodes that subscribe to a curated CG's SWM topic in HOST MODE
 * store the raw gossip envelope bytes here. They cannot decrypt the
 * payload (they're not members of the CG and don't have the chain key),
 * so they hold the bytes opaquely. Late members fetch the bytes back
 * via `/dkg/10.0.1/swm-host-catchup` and decrypt locally using their
 * own member-side state.
 *
 * Wire format on disk is a simple length-prefixed append-only log:
 *   [8-byte BE timestampMs] [8-byte BE seqno] [4-byte BE len] [len bytes]
 *
 * One file per CG, named with the URL-safe base64 of sha256(cgId)
 * so an arbitrary user-supplied CG id maps to a safe filesystem name.
 *
 * Pre-registration staging (per RFC §1.2): unregistered CGs get a
 * short TTL (default 6h) and a small per-CG byte cap (default 1 MiB).
 * Registered CGs get the operator-configured limits — typically much
 * larger TTL and cap so the host can serve catchup for days/weeks of
 * gossip after registration.
 *
 * Module map. This file keeps the public API, the per-CG write lock, sequence
 * allocation, the CG metadata flags and the retention policy; the rest is split
 * by concern:
 *   - host-store-types.ts: the public types, the default limits, `CgMetaState`;
 *   - host-store-format.ts: file naming and the frame codec (pure);
 *   - host-store-durable-fs.ts: `DurableFiles`, the crash-safe file operations
 *     and the pending directory fsyncs;
 *   - host-store-meta-loader.ts: the metadata cache and its cold-load owner;
 *   - host-store-startup-reconcile.ts: the sweep `init()` runs over the data
 *     directory.
 *
 * Durability: `append` writes the frame and fsyncs it BEFORE `persistMeta`
 * publishes its seqno, so an acknowledged append is on disk in the log and the
 * per-CG `.meta` cursor and a durable cursor never points past a frame that was
 * lost; every whole-file rewrite (`.meta` updates, the prune rewrite of a
 * `.log`) and the prune unlink of a fully expired log go through `DurableFiles`,
 * which owns the file mechanics and their guarantees: temp + fsync + rename +
 * directory fsync, the pending directory fsyncs that a retry completes before it
 * acknowledges, and the sweep of leftover `<file>.tmp-*` siblings that `init()`
 * runs. This module decides what is written, and in which order; it adds, per
 * store instance, the retry rule that an idempotent no-op (a `mark*` whose flag
 * already matches, a prune that finds nothing left to drop) first completes such
 * a pending directory fsync (`completePendingDirSync`).
 *
 * Not guaranteed here: the unlinks of `init()`'s sweep of orphan logs and corrupt
 * metas (nothing acknowledges them: a resurrected orphan is reaped again by the
 * next init), and anything across two store instances on one directory (they
 * share no lock, no cold-load initialization and no pending marks).
 *
 * Cold load: the first access to a CG's metadata after process start runs ONE
 * initialization per CG (read `.meta`, recover the log tail's highest seqno,
 * take the max, best-effort persist the reconciled cursor, install the result
 * in the cache). Every caller, locked mutators and unlocked readers alike,
 * awaits that same initialization, so no mutation can interleave with it and
 * no stale snapshot can be renamed over a newer `.meta`. The guarantee is per
 * store instance and per process: use one instance per `dataDir` (the agent
 * does). A second instance on the same directory has its own lock and its own
 * initialization, so two instances running concurrently are NOT ordered
 * against each other; opening a fresh instance after the previous one is idle
 * (a restart) is safe, it re-derives everything from the files.
 *
 * A load takes only a MISSING file as absent (no `.meta`: defaults; no `.log`:
 * no frames). Any other read error on either file (EIO, EACCES, EMFILE, ...)
 * rejects the load, and with it the mutation that needed it: nothing is
 * cached, nothing is persisted, and the next access reads the files again.
 * This holds for the cold load and for the re-load after a failed `.meta`
 * write dropped the cache. Defaults built from a file the store could not
 * read would be written back over that file, restarting the cursor (recycling
 * acknowledged seqnos once retention has emptied the log) and clearing the
 * persisted flags. The unlocked readers (`getLastSeqno`, `isRegistered`,
 * `stats`, `listHostModeSubscribedCgs`) swallow the rejection and answer that
 * one call as if the CG were unknown (cursor 0, not registered, not
 * subscribed). A `.meta` that reads but does not parse is unusable rather than
 * unreadable: it loads as defaults, and `init()` reaps it together with its
 * log.
 *
 * The store is intentionally simple: append-only writes, sequential
 * reads, periodic prune. No indexes, no compaction, no checkpoints.
 * The expected steady-state size is small (a few MB per active CG
 * in Phase A); when this becomes a hot path, swap for a sqlite-backed
 * implementation behind the same interface.
 */
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { DurableFiles } from './host-store-durable-fs.js';
import {
  HostStoreLayout,
  concatFrames,
  countFrames,
  encodeFrame,
  planRetention,
  readEntriesSince,
  scanLogFrames,
} from './host-store-format.js';
import { HostStoreMetaLoader } from './host-store-meta-loader.js';
import { reconcileOrphanLogs } from './host-store-startup-reconcile.js';
import {
  DEFAULT_REGISTERED_LIMITS,
  DEFAULT_UNREGISTERED_LIMITS,
  type CgMetaState,
  type SwmHostModeEntry,
  type SwmHostModeStartupReconcileReport,
  type SwmHostModeStats,
  type SwmHostModeStoreLimits,
  type SwmHostModeStoreOptions,
} from './host-store-types.js';

export type {
  SwmHostModeEntry,
  SwmHostModeStartupReconcileReport,
  SwmHostModeStats,
  SwmHostModeStoreLimits,
  SwmHostModeStoreOptions,
} from './host-store-types.js';

const META_FILE = '_meta.json';

/**
 * File-backed opaque store for curated SWM ciphertext envelopes that
 * a core node holds on behalf of CG members. See module docs for the
 * on-disk format.
 *
 * The implementation is intentionally minimal: a single append per
 * write, a streaming read on iterate, and an in-memory metadata cache
 * (`seqno` counter and per-CG `registered` flag) refreshed lazily.
 */
export class SwmHostModeStore {
  private readonly dataDir: string;
  private readonly layout: HostStoreLayout;
  private readonly unregisteredLimits: SwmHostModeStoreLimits;
  private readonly registeredLimits: SwmHostModeStoreLimits;
  private readonly now: () => number;
  private readonly onStartupReconcile?: (report: SwmHostModeStartupReconcileReport) => void;
  /**
   * The filesystem half of the store: durable replace, append, truncate and
   * unlink, the pending directory fsyncs and the temp-file lifecycle. Same-target
   * writers never overlap within an instance (the per-CG write lock, plus the
   * cold-load initialization that every mutator awaits), which is what
   * `DurableFiles` relies on to record a target's generations in change order.
   */
  private readonly files = new DurableFiles();
  /** The metadata cache and the one cold-load initialization per CG (see `loadMeta`). */
  private readonly metaLoader: HostStoreMetaLoader;
  private readonly inflightWrites = new Map<string, Promise<void>>();
  /** CGs whose log tail has been checked (and repaired) since this process started. */
  private readonly verifiedLogTails = new Set<string>();
  private initialized = false;
  private lastStartupReconcileReport: SwmHostModeStartupReconcileReport | undefined;

  constructor(options: SwmHostModeStoreOptions) {
    this.dataDir = options.dataDir;
    this.layout = new HostStoreLayout(options.dataDir);
    this.metaLoader = new HostStoreMetaLoader(this.layout, this.files);
    this.unregisteredLimits = options.unregisteredLimits ?? DEFAULT_UNREGISTERED_LIMITS;
    this.registeredLimits = options.registeredLimits ?? DEFAULT_REGISTERED_LIMITS;
    this.now = options.now ?? (() => Date.now());
    this.onStartupReconcile = options.onStartupReconcile;
  }

  static defaultLimits(): { unregistered: SwmHostModeStoreLimits; registered: SwmHostModeStoreLimits } {
    return { unregistered: DEFAULT_UNREGISTERED_LIMITS, registered: DEFAULT_REGISTERED_LIMITS };
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    const report = await reconcileOrphanLogs(this.dataDir, this.files);
    this.lastStartupReconcileReport = report;
    this.initialized = true;
    if (this.onStartupReconcile && (report.orphanLogsRemoved > 0 || report.orphanBytesRemoved > 0 || (report.corruptMetasRemoved ?? 0) > 0)) {
      try {
        this.onStartupReconcile(report);
      } catch {
        // observability callback must never break init
      }
    }
  }

  /**
   * Test-only / operator helper: get the orphan-log reconcile report
   * the store actually applied. Codex PR #619 R2: on a first call
   * before `init()` has captured anything, we lazily run init() and
   * return the report it produced — NOT a second sweep, which would
   * always come back empty after init's first pass already cleaned
   * up.
   */
  async reconcileOrphanLogsNow(): Promise<SwmHostModeStartupReconcileReport> {
    const wasInitialized = this.initialized;
    await this.init();
    if (!wasInitialized && this.lastStartupReconcileReport) {
      return this.lastStartupReconcileReport;
    }
    const report = await reconcileOrphanLogs(this.dataDir, this.files);
    this.lastStartupReconcileReport = report;
    return report;
  }

  /**
   * Append one opaque envelope for `contextGraphId`. Returns the
   * assigned sequence number (monotonic per CG, never reused even
   * across restarts because seqno persists in the meta file).
   *
   * Concurrent appends for the same CG are serialized via
   * `inflightWrites` so the file-level seqno stays monotonic.
   */
  async append(contextGraphId: string, envelopeBytes: Uint8Array): Promise<number> {
    return this.withCgWriteLock(contextGraphId, () => this.appendUnlocked(contextGraphId, envelopeBytes));
  }

  /**
   * Codex PR #620 follow-up: per-CG serialization for ALL meta mutations.
   * `markHostModeSubscribed/Unsubscribed`, `markRegistered/Unregistered`
   * used to call `loadMeta` → `persistMeta` outside the inflight-writes
   * lock that `append()` and `pruneCg()` already use, so a
   * `wireSwmHostModeHandler() → markHostModeSubscribed()` followed
   * immediately by `maybeMarkRegisteredForHostMode() → markRegistered()`
   * could see their `persistMeta` writes interleave and drop the
   * `hostModeSubscribed` flag. Routing every mutator through this helper
   * keeps the `.meta` file consistent.
   */
  private async withCgWriteLock<T>(
    contextGraphId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.init();
    const cgKey = this.layout.cgKey(contextGraphId);
    const previous = this.inflightWrites.get(cgKey);
    let resolveOuter: () => void = () => {};
    const next = new Promise<void>((resolve) => { resolveOuter = resolve; });
    this.inflightWrites.set(cgKey, previous ? previous.then(() => next) : next);
    try {
      if (previous) await previous;
      return await fn();
    } finally {
      resolveOuter();
      if (this.inflightWrites.get(cgKey) === next) this.inflightWrites.delete(cgKey);
    }
  }

  private async appendUnlocked(contextGraphId: string, envelopeBytes: Uint8Array): Promise<number> {
    if (envelopeBytes.length === 0) {
      throw new Error('SwmHostModeStore.append: refusing zero-length envelope');
    }
    await this.repairLogTailOnce(contextGraphId);
    const meta = await this.loadMeta(contextGraphId);
    const seqno = meta.seqno + 1;
    const timestampMs = this.now();
    const payload = encodeFrame(timestampMs, seqno, envelopeBytes);
    // Reserve the seqno before touching the disk: if the write or its fsync
    // fails after the frame's bytes landed, a retry must not append a second
    // frame with the same seqno (strict-greater-than catch-up paging would
    // skip one of the two). A failed append burns its seqno instead.
    meta.seqno = seqno;
    // Frame first, cursor second: the frame is fsynced BEFORE `persistMeta`
    // publishes its seqno, so an acknowledged append is on disk in both
    // files and a durable cursor never points past a frame that was lost.
    try {
      await this.files.appendFileDurable(this.layout.logPath(contextGraphId), payload);
    } catch (err) {
      // A failed write (ENOSPC, EIO, ...) may have left a partial frame at
      // the tail; the next append must re-check it rather than write after it.
      this.verifiedLogTails.delete(this.layout.cgKey(contextGraphId));
      throw err;
    }
    await this.persistMeta(contextGraphId, meta);
    await this.enforceLimitsAfterAppend(contextGraphId, meta);
    return seqno;
  }

  /**
   * Iterate stored entries for `contextGraphId` with seqno strictly
   * greater than `sinceSeqno`. Caller can pass `limit` to bound the
   * response size. Returns entries in seqno-ascending order.
   */
  async iterate(
    contextGraphId: string,
    sinceSeqno: number,
    limit?: number,
  ): Promise<SwmHostModeEntry[]> {
    await this.init();
    const filePath = this.layout.logPath(contextGraphId);
    const exists = await fileExists(filePath);
    if (!exists) return [];
    const buf = await fs.readFile(filePath);
    return readEntriesSince(buf, sinceSeqno, limit);
  }

  /**
   * OT-RFC-38 LU-6 B3 — record that the agent has engaged host-mode
   * for this CG (subscribed to its SWM gossip topic in opaque-store
   * mode). Persisted so a restart can re-engage the gossip handler
   * before the chain-event poller catches up. Idempotent.
   */
  async markHostModeSubscribed(contextGraphId: string): Promise<void> {
    await this.mutateMeta(contextGraphId, (meta) => {
      if (meta.hostModeSubscribed === true) return false;
      meta.hostModeSubscribed = true;
      return true;
    });
  }

  /**
   * Inverse of {@link markHostModeSubscribed}. Called when the agent
   * unwires the host-mode handler (promoted to member, curator
   * revoked, operator explicitly disabled host-mode for this CG).
   * Persisted so a restart does NOT re-engage.
   */
  async markHostModeUnsubscribed(contextGraphId: string): Promise<void> {
    await this.mutateMeta(contextGraphId, (meta) => {
      if (meta.hostModeSubscribed !== true) return false;
      meta.hostModeSubscribed = false;
      return true;
    });
  }

  /**
   * Returns the cleartext / wire ids of every CG marked
   * `hostModeSubscribed: true` in its `.meta`. Used by the agent at
   * startup to re-engage gossip handlers without waiting for the
   * chain-event poller to re-derive them.
   */
  async listHostModeSubscribedCgs(): Promise<string[]> {
    await this.init();
    const out: string[] = [];
    for (const { contextGraphId } of await this.listKnownCgs()) {
      const meta = await this.loadMeta(contextGraphId).catch(() => null);
      if (meta?.hostModeSubscribed === true) out.push(contextGraphId);
    }
    return out;
  }

  /** Mark a CG as on-chain registered. Switches it to the larger limits. */
  async markRegistered(contextGraphId: string): Promise<void> {
    await this.mutateMeta(contextGraphId, (meta) => {
      if (meta.registered) return false;
      meta.registered = true;
      return true;
    });
  }

  /** Mark a CG as no-longer-registered. Useful for revoke flows. */
  async markUnregistered(contextGraphId: string): Promise<void> {
    await this.mutateMeta(contextGraphId, (meta) => {
      if (!meta.registered) return false;
      meta.registered = false;
      return true;
    });
  }

  /**
   * The one path every `.meta` flag mutator goes through (under the per-CG
   * write lock). `apply` mutates the loaded state and returns whether it
   * changed anything. When it did not (the flag already has the requested
   * value) nothing is rewritten, but the caller is still only told "done" once
   * the visible file is durable: if an earlier attempt renamed this file into
   * place and then failed its directory fsync, that fsync is completed here
   * first (and a failure of it rejects, keeping the pending mark).
   */
  private async mutateMeta(
    contextGraphId: string,
    apply: (meta: CgMetaState) => boolean,
  ): Promise<void> {
    await this.withCgWriteLock(contextGraphId, async () => {
      const meta = await this.loadMeta(contextGraphId);
      if (!apply(meta)) {
        await this.files.completePendingDirSync(this.layout.metaPath(contextGraphId));
        return;
      }
      await this.persistMeta(contextGraphId, meta);
    });
  }

  /** Returns `true` if at least one stored entry exists for the CG. */
  async hasEntries(contextGraphId: string): Promise<boolean> {
    await this.init();
    return fileExists(this.layout.logPath(contextGraphId));
  }

  /**
   * Sweep all known CGs for TTL-expired entries. Returns the total
   * bytes pruned across all CGs. Safe to call concurrently with
   * `append` — each per-CG prune takes the same inflight-write lock.
   *
   * A CG whose prune rejects (its files cannot be read, or its rewrite
   * fails) is left for the next sweep and does not stop this one: the
   * CGs after it are still pruned, and the first failure is rethrown
   * once the sweep is done. Stopping at it would leave every later CG
   * unpruned for as long as that one stays unreadable.
   */
  async prune(): Promise<{ bytesPruned: number; cgsPruned: number }> {
    await this.init();
    const cgs = await this.listKnownCgs();
    let bytesPruned = 0;
    let cgsPruned = 0;
    let firstFailure: { error: unknown } | undefined;
    for (const cgInfo of cgs) {
      let pruned: number;
      try {
        pruned = await this.pruneCg(cgInfo.contextGraphId);
      } catch (error) {
        firstFailure ??= { error };
        continue;
      }
      bytesPruned += pruned;
      if (pruned > 0) cgsPruned += 1;
    }
    if (firstFailure) throw firstFailure.error;
    return { bytesPruned, cgsPruned };
  }

  async stats(): Promise<SwmHostModeStats> {
    await this.init();
    const cgs = await this.listKnownCgs();
    let totalBytes = 0;
    let totalEntries = 0;
    const perCg: Record<string, { entries: number; bytes: number; registered: boolean }> = {};
    // Codex PR #610 R4: derive `cgCount` from CGs that still
    // have ciphertext (log file present + at least 1 entry),
    // NOT from the count of meta files. `markRegistered()`
    // creates a meta file even for CGs that never receive an
    // envelope, and a prune-to-empty can leave the .meta
    // behind too — both would otherwise inflate the visible
    // hosted-CG count.
    let cgsWithEntries = 0;
    for (const cgInfo of cgs) {
      const filePath = this.layout.logPath(cgInfo.contextGraphId);
      if (!(await fileExists(filePath))) continue;
      const stat = await fs.stat(filePath);
      const bytes = stat.size;
      const buf = await fs.readFile(filePath);
      const entries = countFrames(buf);
      if (entries === 0) continue;
      totalBytes += bytes;
      totalEntries += entries;
      cgsWithEntries += 1;
      const meta = await this.loadMeta(cgInfo.contextGraphId).catch(() => null);
      perCg[cgInfo.contextGraphId] = { entries, bytes, registered: meta?.registered ?? false };
    }
    return { cgCount: cgsWithEntries, totalBytes, totalEntries, perCg };
  }

  /** Test-only: returns the persisted seqno cursor for a CG, or 0 if unknown. */
  async getLastSeqno(contextGraphId: string): Promise<number> {
    await this.init();
    const meta = await this.loadMeta(contextGraphId).catch(() => null);
    return meta ? meta.seqno : 0;
  }

  /** Test-only: returns whether the CG is marked as registered. */
  async isRegistered(contextGraphId: string): Promise<boolean> {
    await this.init();
    const meta = await this.loadMeta(contextGraphId).catch(() => null);
    return meta ? meta.registered : false;
  }

  private async pruneCg(contextGraphId: string): Promise<number> {
    const cgKey = this.layout.cgKey(contextGraphId);
    const previous = this.inflightWrites.get(cgKey);
    let resolveOuter: () => void = () => {};
    const next = new Promise<void>((resolve) => { resolveOuter = resolve; });
    this.inflightWrites.set(cgKey, previous ? previous.then(() => next) : next);
    try {
      if (previous) await previous;
      const limits = await this.activeLimits(contextGraphId);
      return await this.pruneCgUnlocked(contextGraphId, limits);
    } finally {
      resolveOuter();
      if (this.inflightWrites.get(cgKey) === next) this.inflightWrites.delete(cgKey);
    }
  }

  private async pruneCgUnlocked(
    contextGraphId: string,
    limits: SwmHostModeStoreLimits,
  ): Promise<number> {
    const filePath = this.layout.logPath(contextGraphId);
    if (!(await fileExists(filePath))) {
      // No log. If an earlier prune unlinked it and then failed its directory
      // fsync, this "already gone" view is not durable yet: finish that fsync
      // before reporting done. (Free when nothing is pending.)
      await this.files.completePendingDirSync(filePath);
      return 0;
    }
    const buf = await fs.readFile(filePath);
    const ttlCutoff = this.now() - limits.ttlMs;
    const { kept, bytesPruned } = planRetention(buf, ttlCutoff, limits.perCgByteCap);
    if (bytesPruned === 0) {
      // Nothing (left) to drop. If a previous attempt already renamed the pruned
      // log into place but its directory fsync failed, this "already pruned"
      // view is not durable yet: finish that fsync before reporting done.
      await this.files.completePendingDirSync(filePath);
      return 0;
    }
    if (kept.length === 0) {
      // An unlink is a directory-entry change exactly like a rename: `unlinkDurable`
      // directory-syncs it, or a power loss could bring the expired ciphertext back.
      await this.files.unlinkDurable(filePath);
      return bytesPruned;
    }
    // Atomic replace: a crash leaves the whole old log or the whole pruned
    // log, never a truncated one, and concurrent readers never see a
    // half-written file.
    await this.files.writeFileDurable(filePath, concatFrames(buf, kept));
    return bytesPruned;
  }

  private async enforceLimitsAfterAppend(contextGraphId: string, _meta: CgMetaState): Promise<void> {
    const limits = await this.activeLimits(contextGraphId);
    const filePath = this.layout.logPath(contextGraphId);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return;
    if (stat.size > limits.perCgByteCap) {
      await this.pruneCgUnlocked(contextGraphId, limits);
    }
  }

  private async activeLimits(contextGraphId: string): Promise<SwmHostModeStoreLimits> {
    const meta = await this.loadMeta(contextGraphId);
    return meta.registered ? this.registeredLimits : this.unregisteredLimits;
  }

  /**
   * Load (and cache) the per-CG metadata through the one cold-load owner of
   * this instance (`HostStoreMetaLoader.load`: its doc has the cold-load
   * rules). Deliberately not `async`: the loader's promise is returned as is.
   */
  private loadMeta(contextGraphId: string): Promise<CgMetaState> {
    return this.metaLoader.load(contextGraphId);
  }

  private async persistMeta(contextGraphId: string, meta: CgMetaState): Promise<void> {
    const cgKey = this.layout.cgKey(contextGraphId);
    const cache = this.metaLoader.cache;
    cache.set(cgKey, meta);
    // Authoritative write: a failure rejects so the caller sees it.
    try {
      await this.files.writeFileDurable(this.layout.metaPath(contextGraphId), JSON.stringify(meta));
    } catch (err) {
      // The caller mutated the cached object before calling us, so on failure
      // the cache may be ahead of the disk. Drop it: the next access re-reads
      // what is on disk (the cursor is re-derived from the log tail) and a retry
      // of the same mutation actually retries the write instead of no-op'ing
      // against a flag the disk never saw. If the failure was the directory
      // fsync after the rename, the new file IS what the next access reads;
      // `DurableFiles` has then recorded it as pending, and the retry's
      // idempotent early return completes that fsync (see `mutateMeta`).
      // The re-read rejects when it cannot read the files; only a missing file
      // loads as absent (see `HostStoreMetaLoader`).
      if (cache.get(cgKey) === meta) cache.delete(cgKey);
      throw err;
    }
  }

  /**
   * Once per CG per process (and again after a failed append), make sure the
   * log ends on a frame boundary before anything is appended. A crash or
   * power loss mid-append (or an `ENOSPC`) can leave a partial frame at the
   * tail; appending after it would bury every later frame behind a header
   * whose length swallows them, hiding acknowledged entries from `iterate`
   * and recycling their seqnos. Truncating to the last complete frame is
   * safe: readers already stop at that boundary, so those bytes were never
   * servable. Runs under the per-CG write lock (callers: `appendUnlocked`).
   */
  private async repairLogTailOnce(contextGraphId: string): Promise<void> {
    const cgKey = this.layout.cgKey(contextGraphId);
    if (this.verifiedLogTails.has(cgKey)) return;
    const filePath = this.layout.logPath(contextGraphId);
    let buf: Buffer | undefined;
    try {
      buf = await fs.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (buf) {
      const { validLength } = scanLogFrames(buf);
      if (validLength < buf.length) {
        await this.files.truncateFileDurable(filePath, validLength);
      }
    }
    this.verifiedLogTails.add(cgKey);
  }

  private async listKnownCgs(): Promise<{ contextGraphId: string }[]> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.dataDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const cgs: { contextGraphId: string }[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.meta')) continue;
      try {
        const txt = await fs.readFile(path.join(this.dataDir, e.name), 'utf-8');
        const parsed = JSON.parse(txt) as CgMetaState;
        if (parsed.contextGraphId) cgs.push({ contextGraphId: parsed.contextGraphId });
      } catch { /* skip corrupt meta */ }
    }
    return cgs;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export { META_FILE };
