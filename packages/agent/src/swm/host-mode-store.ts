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
 * Durability: every acknowledged `append` is fsynced (the frame, then the
 * per-CG `.meta` cursor, then the directory entry), and every whole-file
 * rewrite (`.meta` updates, the prune rewrite of a `.log`) goes through a
 * sibling temp file + fsync + rename + directory fsync, so a crash or power
 * loss leaves either the old file or the new file, never a torn one. Leftover
 * `<file>.tmp-*` siblings from a crash are inert and swept by `init()`.
 *
 * The store is intentionally simple: append-only writes, sequential
 * reads, periodic prune. No indexes, no compaction, no checkpoints.
 * The expected steady-state size is small (a few MB per active CG
 * in Phase A); when this becomes a hot path, swap for a sqlite-backed
 * implementation behind the same interface.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fsyncRfc64DirectoryV1 } from '../rfc64/secure-filesystem-policy-v1.js';

export interface SwmHostModeEntry {
  /** Monotonic per-store sequence number assigned at append time. */
  seqno: number;
  /** UNIX epoch milliseconds when the entry was written. */
  timestampMs: number;
  /** Raw gossip envelope bytes as received from libp2p. Opaque to the core. */
  envelopeBytes: Uint8Array;
}

export interface SwmHostModeStoreLimits {
  /** Max bytes retained per CG. Older entries are evicted FIFO. */
  perCgByteCap: number;
  /** Time-to-live in milliseconds. Entries older than this are pruned. */
  ttlMs: number;
}

export interface SwmHostModeStoreOptions {
  /** Filesystem directory under which per-CG logs are written. */
  dataDir: string;
  /** Limits applied to unregistered (pre-registration) CGs. */
  unregisteredLimits: SwmHostModeStoreLimits;
  /** Limits applied to on-chain registered CGs. */
  registeredLimits: SwmHostModeStoreLimits;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Optional callback fired by `init()` after the orphan-log
   * reconciliation pass. Receives the per-startup totals so the
   * agent can surface them through its own logging facade. Pure
   * observability — the store itself does not log.
   */
  onStartupReconcile?: (report: SwmHostModeStartupReconcileReport) => void;
}

/**
 * Summary of the orphan-log sweep performed by `init()`. A `.log`
 * file without a matching `.meta` cannot be served via catchup (no
 * cleartext `contextGraphId` to dispatch on), pruned (the prune
 * path keys off meta files), or reported in stats — those bytes are
 * dead storage that accumulate after a crash between `appendFile`
 * (durable) and `persistMeta` (durable) for a brand-new CG's first
 * envelope. We delete orphans at init to recover the disk.
 */
export interface SwmHostModeStartupReconcileReport {
  orphanLogsRemoved: number;
  orphanBytesRemoved: number;
  /**
   * Codex PR #619 follow-up: split out so operators can tell the
   * difference between "log without meta" reaping (data already lost
   * before reconcile ran) and "meta failed to parse" reaping
   * (meta itself was the casualty; paired log was already reaped via
   * the orphan-logs pass). Optional for backwards compat with the
   * pre-fix report shape.
   */
  corruptMetasRemoved?: number;
  /**
   * Number of leftover `<log|meta>.tmp-*` files (a crash between creating
   * the temp file and renaming it over its target) swept by this pass.
   * Reported only when non-zero; never folded into the orphan-log totals
   * above and never fires `onStartupReconcile` on its own.
   */
  staleTempFilesRemoved?: number;
}

export interface SwmHostModeStats {
  /** Number of distinct CGs that have at least one stored entry. */
  cgCount: number;
  /** Total stored bytes (sum across CGs) on disk. */
  totalBytes: number;
  /** Total stored entries (sum across CGs). */
  totalEntries: number;
  /**
   * Per-CG breakdown. Keys are the raw contextGraphIds (not the
   * hashed on-disk filenames). Tests and operators that need to
   * assert "ciphertext was stored for CG X" must consume this
   * field rather than the global totals — those can be polluted
   * by ciphertext from other CGs the same core happens to host
   * (Codex PR #610 R3 caught the false-positive risk in the
   * SCENARIO D devnet assertion).
   */
  perCg: Record<string, { entries: number; bytes: number; registered: boolean }>;
}

const DEFAULT_UNREGISTERED_LIMITS: SwmHostModeStoreLimits = {
  perCgByteCap: 1 * 1024 * 1024,
  ttlMs: 6 * 60 * 60 * 1000,
};

const DEFAULT_REGISTERED_LIMITS: SwmHostModeStoreLimits = {
  perCgByteCap: 64 * 1024 * 1024,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
};

const ENTRY_HEADER_BYTES = 8 + 8 + 4;
const META_FILE = '_meta.json';
/**
 * Infix of the sibling temp file used for crash-safe whole-file writes:
 * `<key>.<log|meta>.tmp-<pid>-<uuid>`. It never ends in `.log` / `.meta`,
 * so the directory scans that key off those suffixes ignore it.
 */
const TEMP_FILE_INFIX = '.tmp-';
const TEMP_FILE_NAME = /^[A-Za-z0-9_-]+\.(?:log|meta)\.tmp-/;

interface CgMetaState {
  seqno: number;
  registered: boolean;
  contextGraphId: string;
  /**
   * OT-RFC-38 LU-6 B3 — true when the agent has actively engaged
   * host-mode for this CG (subscribed to its SWM gossip topic in
   * opaque-ciphertext mode). Persisted so a restart can re-engage
   * the gossip handler before the chain-event poller catches up
   * (chain events outside the lookback window would otherwise be
   * silently lost, stranding hosted CGs without an apply path).
   *
   * Distinct from `registered` (which tracks on-chain registration
   * for limits + rate-limit purposes). A CG can be host-mode
   * subscribed but unregistered (pre-registration auto-host via
   * beacon) and vice-versa (registered but the curator revoked
   * this core via off-protocol means — the next reconcile loop
   * will clear `hostModeSubscribed`).
   */
  hostModeSubscribed?: boolean;
}

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
  private readonly unregisteredLimits: SwmHostModeStoreLimits;
  private readonly registeredLimits: SwmHostModeStoreLimits;
  private readonly now: () => number;
  private readonly onStartupReconcile?: (report: SwmHostModeStartupReconcileReport) => void;
  private readonly metaCache = new Map<string, CgMetaState>();
  private readonly inflightWrites = new Map<string, Promise<void>>();
  /** Temp files currently being written by this instance; the init sweep must not reap them. */
  private readonly liveTempPaths = new Set<string>();
  /** CGs whose log tail has been checked (and repaired) since this process started. */
  private readonly verifiedLogTails = new Set<string>();
  private initialized = false;
  private lastStartupReconcileReport: SwmHostModeStartupReconcileReport | undefined;

  constructor(options: SwmHostModeStoreOptions) {
    this.dataDir = options.dataDir;
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
    const report = await this.reconcileOrphanLogs();
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
    const report = await this.reconcileOrphanLogs();
    this.lastStartupReconcileReport = report;
    return report;
  }

  /**
   * Scan `dataDir` for `.log` files without a matching `.meta` and
   * delete them. Orphans typically result from a crash between
   * `appendFile` (durable) and `persistMeta` (durable) during the
   * first envelope for a brand-new CG. Without meta we cannot:
   *   - serve catchup (no cleartext contextGraphId to dispatch on)
   *   - prune (the prune path keys off meta files)
   *   - report in stats
   * so the bytes are dead storage. Delete-at-init recovers the disk.
   *
   * `.meta` files without a matching `.log` are deliberately NOT
   * removed: `markRegistered` writes a meta even for CGs that have
   * never received an envelope, and a prune-to-empty leaves the meta
   * behind. Both are harmless (zero-byte footprint) and the meta
   * carries the cleartext `contextGraphId` we need for future
   * append-time meta reconstruction.
   */
  private async reconcileOrphanLogs(): Promise<SwmHostModeStartupReconcileReport> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.dataDir, { withFileTypes: true });
    } catch {
      return { orphanLogsRemoved: 0, orphanBytesRemoved: 0 };
    }
    // Codex PR #619 R2: only count a .meta as "healthy pairing
    // candidate" if it parses as valid JSON with a contextGraphId.
    // A truncated .meta (written by a build that predates the atomic
    // temp+rename `persistMeta`, or damaged out-of-band); `loadMeta()` /
    // `listKnownCgs()` already treat that as unusable, so the paired .log
    // is still unservable + unprunable and must be reaped here too.
    const validMetaKeys = new Set<string>();
    const corruptMetaNames: string[] = [];
    // Codex PR #619 follow-up: transient fs errors (EACCES, EMFILE,
    // EBUSY, etc.) on the meta read MUST NOT be reaped as corruption;
    // doing so deletes a healthy `.meta` + `.log` pair and loses
    // hosted ciphertext on startup. Track keys whose meta we could not
    // read so the paired `.log` is also retained for a later retry.
    const ioSkippedMetaKeys = new Set<string>();
    const logFiles: { key: string; name: string }[] = [];
    const tempFileNames: string[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (TEMP_FILE_NAME.test(e.name)) {
        // A crash between creating a `writeFileDurable` temp and renaming it
        // over its target. The target is intact; the temp is dead weight.
        tempFileNames.push(e.name);
      } else if (e.name.endsWith('.meta')) {
        const metaPath = path.join(this.dataDir, e.name);
        const metaKey = e.name.slice(0, -'.meta'.length);
        let raw: string;
        try {
          raw = await fs.readFile(metaPath, 'utf-8');
        } catch {
          ioSkippedMetaKeys.add(metaKey);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          corruptMetaNames.push(e.name);
          continue;
        }
        if (
          parsed && typeof parsed === 'object'
          && typeof (parsed as { contextGraphId?: unknown }).contextGraphId === 'string'
          && (parsed as { contextGraphId: string }).contextGraphId.length > 0
        ) {
          validMetaKeys.add(metaKey);
        } else {
          corruptMetaNames.push(e.name);
        }
      } else if (e.name.endsWith('.log')) {
        logFiles.push({ key: e.name.slice(0, -'.log'.length), name: e.name });
      }
    }
    let orphanLogsRemoved = 0;
    let orphanBytesRemoved = 0;
    let corruptMetasRemoved = 0;
    let corruptMetaBytesRemoved = 0;
    for (const { key, name } of logFiles) {
      if (validMetaKeys.has(key)) continue;
      if (ioSkippedMetaKeys.has(key)) continue;
      const fullPath = path.join(this.dataDir, name);
      try {
        const stat = await fs.stat(fullPath);
        orphanBytesRemoved += stat.size;
        await fs.rm(fullPath, { force: true });
        orphanLogsRemoved += 1;
      } catch {
        // best-effort; another process may have removed the file
      }
    }
    for (const name of corruptMetaNames) {
      const fullPath = path.join(this.dataDir, name);
      try {
        const stat = await fs.stat(fullPath);
        corruptMetaBytesRemoved += stat.size;
        await fs.rm(fullPath, { force: true });
        corruptMetasRemoved += 1;
      } catch {
        // best-effort
      }
    }
    let staleTempFilesRemoved = 0;
    for (const name of tempFileNames) {
      const fullPath = path.join(this.dataDir, name);
      // A write of this very instance may be mid-flight (only reachable via
      // `reconcileOrphanLogsNow()` after init): leave its temp alone.
      if (this.liveTempPaths.has(fullPath)) continue;
      try {
        await fs.rm(fullPath, { force: true });
        staleTempFilesRemoved += 1;
      } catch {
        // best-effort
      }
    }
    const report: SwmHostModeStartupReconcileReport = {
      // Backwards-compatible aggregate: older callers treat these as
      // "files/bytes reaped by startup reconcile", including corrupt
      // .meta files. Keep that contract and expose the split counter
      // only as an optional drill-down.
      orphanLogsRemoved: orphanLogsRemoved + corruptMetasRemoved,
      orphanBytesRemoved: orphanBytesRemoved + corruptMetaBytesRemoved,
    };
    if (corruptMetasRemoved > 0) report.corruptMetasRemoved = corruptMetasRemoved;
    if (staleTempFilesRemoved > 0) report.staleTempFilesRemoved = staleTempFilesRemoved;
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
    const cgKey = this.cgKey(contextGraphId);
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
    const header = Buffer.alloc(ENTRY_HEADER_BYTES);
    header.writeBigUInt64BE(BigInt(timestampMs), 0);
    header.writeBigUInt64BE(BigInt(seqno), 8);
    header.writeUInt32BE(envelopeBytes.length, 16);
    const payload = Buffer.concat([header, Buffer.from(envelopeBytes)]);
    // Reserve the seqno before touching the disk: if the write or its fsync
    // fails after the frame's bytes landed, a retry must not append a second
    // frame with the same seqno (strict-greater-than catch-up paging would
    // skip one of the two). A failed append burns its seqno instead.
    meta.seqno = seqno;
    // Frame first, cursor second: the frame is fsynced BEFORE `persistMeta`
    // publishes its seqno, so an acknowledged append is on disk in both
    // files and a durable cursor never points past a frame that was lost.
    try {
      await this.appendFileDurable(this.logPath(contextGraphId), payload);
    } catch (err) {
      // A failed write (ENOSPC, EIO, ...) may have left a partial frame at
      // the tail; the next append must re-check it rather than write after it.
      this.verifiedLogTails.delete(this.cgKey(contextGraphId));
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
    const filePath = this.logPath(contextGraphId);
    const exists = await fileExists(filePath);
    if (!exists) return [];
    const buf = await fs.readFile(filePath);
    const out: SwmHostModeEntry[] = [];
    let offset = 0;
    while (offset + ENTRY_HEADER_BYTES <= buf.length) {
      const timestampMs = Number(buf.readBigUInt64BE(offset));
      const seqno = Number(buf.readBigUInt64BE(offset + 8));
      const len = buf.readUInt32BE(offset + 16);
      const payloadStart = offset + ENTRY_HEADER_BYTES;
      const payloadEnd = payloadStart + len;
      if (payloadEnd > buf.length) {
        break;
      }
      if (seqno > sinceSeqno) {
        out.push({
          seqno,
          timestampMs,
          envelopeBytes: new Uint8Array(buf.subarray(payloadStart, payloadEnd)),
        });
        if (limit !== undefined && out.length >= limit) break;
      }
      offset = payloadEnd;
    }
    return out;
  }

  /**
   * OT-RFC-38 LU-6 B3 — record that the agent has engaged host-mode
   * for this CG (subscribed to its SWM gossip topic in opaque-store
   * mode). Persisted so a restart can re-engage the gossip handler
   * before the chain-event poller catches up. Idempotent.
   */
  async markHostModeSubscribed(contextGraphId: string): Promise<void> {
    await this.withCgWriteLock(contextGraphId, async () => {
      const meta = await this.loadMeta(contextGraphId);
      if (meta.hostModeSubscribed === true) return;
      meta.hostModeSubscribed = true;
      await this.persistMeta(contextGraphId, meta);
    });
  }

  /**
   * Inverse of {@link markHostModeSubscribed}. Called when the agent
   * unwires the host-mode handler (promoted to member, curator
   * revoked, operator explicitly disabled host-mode for this CG).
   * Persisted so a restart does NOT re-engage.
   */
  async markHostModeUnsubscribed(contextGraphId: string): Promise<void> {
    await this.withCgWriteLock(contextGraphId, async () => {
      const meta = await this.loadMeta(contextGraphId);
      if (meta.hostModeSubscribed !== true) return;
      meta.hostModeSubscribed = false;
      await this.persistMeta(contextGraphId, meta);
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
    await this.withCgWriteLock(contextGraphId, async () => {
      const meta = await this.loadMeta(contextGraphId);
      if (meta.registered) return;
      meta.registered = true;
      await this.persistMeta(contextGraphId, meta);
    });
  }

  /** Mark a CG as no-longer-registered. Useful for revoke flows. */
  async markUnregistered(contextGraphId: string): Promise<void> {
    await this.withCgWriteLock(contextGraphId, async () => {
      const meta = await this.loadMeta(contextGraphId);
      if (!meta.registered) return;
      meta.registered = false;
      await this.persistMeta(contextGraphId, meta);
    });
  }

  /** Returns `true` if at least one stored entry exists for the CG. */
  async hasEntries(contextGraphId: string): Promise<boolean> {
    await this.init();
    return fileExists(this.logPath(contextGraphId));
  }

  /**
   * Sweep all known CGs for TTL-expired entries. Returns the total
   * bytes pruned across all CGs. Safe to call concurrently with
   * `append` — each per-CG prune takes the same inflight-write lock.
   */
  async prune(): Promise<{ bytesPruned: number; cgsPruned: number }> {
    await this.init();
    const cgs = await this.listKnownCgs();
    let bytesPruned = 0;
    let cgsPruned = 0;
    for (const cgInfo of cgs) {
      const pruned = await this.pruneCg(cgInfo.contextGraphId);
      bytesPruned += pruned;
      if (pruned > 0) cgsPruned += 1;
    }
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
      const filePath = this.logPath(cgInfo.contextGraphId);
      if (!(await fileExists(filePath))) continue;
      const stat = await fs.stat(filePath);
      const bytes = stat.size;
      const buf = await fs.readFile(filePath);
      let offset = 0;
      let entries = 0;
      while (offset + ENTRY_HEADER_BYTES <= buf.length) {
        const len = buf.readUInt32BE(offset + 16);
        const end = offset + ENTRY_HEADER_BYTES + len;
        if (end > buf.length) break;
        entries += 1;
        offset = end;
      }
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
    const cgKey = this.cgKey(contextGraphId);
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
    const filePath = this.logPath(contextGraphId);
    if (!(await fileExists(filePath))) return 0;
    const buf = await fs.readFile(filePath);
    const ttlCutoff = this.now() - limits.ttlMs;
    // First pass: locate TTL cut point + total post-TTL size.
    const survivors: { start: number; end: number }[] = [];
    let offset = 0;
    while (offset + ENTRY_HEADER_BYTES <= buf.length) {
      const timestampMs = Number(buf.readBigUInt64BE(offset));
      const len = buf.readUInt32BE(offset + 16);
      const end = offset + ENTRY_HEADER_BYTES + len;
      if (end > buf.length) break;
      if (timestampMs >= ttlCutoff) {
        survivors.push({ start: offset, end });
      }
      offset = end;
    }
    let survivorBytes = survivors.reduce((sum, s) => sum + (s.end - s.start), 0);
    let dropIndex = 0;
    while (survivorBytes > limits.perCgByteCap && dropIndex < survivors.length) {
      survivorBytes -= survivors[dropIndex].end - survivors[dropIndex].start;
      dropIndex += 1;
    }
    const kept = survivors.slice(dropIndex);
    const bytesPruned = buf.length - survivorBytes;
    if (bytesPruned === 0) return 0;
    if (kept.length === 0) {
      await fs.rm(filePath, { force: true });
      return bytesPruned;
    }
    const parts: Buffer[] = [];
    for (const s of kept) parts.push(Buffer.from(buf.subarray(s.start, s.end)));
    // Atomic replace: a crash leaves the whole old log or the whole pruned
    // log, never a truncated one, and concurrent readers never see a
    // half-written file.
    await this.writeFileDurable(filePath, Buffer.concat(parts));
    return bytesPruned;
  }

  private async enforceLimitsAfterAppend(contextGraphId: string, _meta: CgMetaState): Promise<void> {
    const limits = await this.activeLimits(contextGraphId);
    const filePath = this.logPath(contextGraphId);
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
   * Load (and cache) the per-CG metadata. On a cold load the seqno
   * cursor is reconciled against the actual log file: a crash
   * between `appendFileDurable` and `persistMeta` (both fsynced, in
   * that order) would otherwise let the next append reuse the same
   * seqno, which would break host-catchup paging that uses
   * strict-greater-than seqno.
   *
   * The log is the source of truth for what was actually persisted;
   * the meta file is a cache of the highest-known seqno plus the
   * `registered` flag. After process start we always trust the log
   * tail's max seqno over the meta file's cursor if the two disagree
   * — taking `max(metaSeqno, lastLogSeqno)` guarantees we never
   * recycle a seqno even if the meta write lost a race to the crash.
   */
  private async loadMeta(contextGraphId: string): Promise<CgMetaState> {
    const cgKey = this.cgKey(contextGraphId);
    const cached = this.metaCache.get(cgKey);
    if (cached) return cached;
    const metaPath = this.metaPath(contextGraphId);
    let parsed: CgMetaState | undefined;
    try {
      const txt = await fs.readFile(metaPath, 'utf-8');
      parsed = JSON.parse(txt) as CgMetaState;
    } catch {
      parsed = undefined;
    }
    const logSeqno = await this.recoverLastSeqnoFromLog(contextGraphId);
    const state: CgMetaState = {
      seqno: Math.max(parsed?.seqno ?? 0, logSeqno),
      registered: parsed?.registered ?? false,
      contextGraphId,
      ...(parsed?.hostModeSubscribed === true ? { hostModeSubscribed: true } : {}),
    };
    // If the log says more than the meta does, persist the
    // reconciled cursor so subsequent cold loads don't have to
    // re-scan the log tail.
    if (parsed && state.seqno !== parsed.seqno) {
      await this.writeFileDurable(metaPath, JSON.stringify(state)).catch(() => { /* best-effort */ });
    }
    // Unlocked callers (`isRegistered`, `getLastSeqno`, `stats`) can cold-load
    // concurrently with a locked append. Whoever installed a state first owns
    // the cache: overwriting it with this (older) snapshot would roll the
    // in-memory cursor back and let the next append reuse a seqno. The
    // durable reconcile write above widens this window, so close it.
    const installed = this.metaCache.get(cgKey);
    if (installed) return installed;
    this.metaCache.set(cgKey, state);
    return state;
  }

  /**
   * Scan the per-CG log tail and return the highest seqno actually
   * persisted on disk. Reads the whole file (the per-CG cap keeps
   * this bounded — default 1 MiB unregistered, 64 MiB registered)
   * and walks frame-by-frame. Returns 0 if no log file exists or
   * the file is empty/corrupt at the head.
   */
  private async recoverLastSeqnoFromLog(contextGraphId: string): Promise<number> {
    const filePath = this.logPath(contextGraphId);
    if (!(await fileExists(filePath))) return 0;
    let buf: Buffer;
    try {
      buf = await fs.readFile(filePath);
    } catch {
      return 0;
    }
    return scanLogFrames(buf).lastSeqno;
  }

  private async persistMeta(contextGraphId: string, meta: CgMetaState): Promise<void> {
    const cgKey = this.cgKey(contextGraphId);
    this.metaCache.set(cgKey, meta);
    // Authoritative write: a failure rejects so the caller sees it.
    try {
      await this.writeFileDurable(this.metaPath(contextGraphId), JSON.stringify(meta));
    } catch (err) {
      // The caller mutated the cached object before calling us, so on failure
      // the cache is ahead of the disk. Drop it: the next access re-reads the
      // durable state (the cursor is re-derived from the log tail) and a retry
      // of the same mutation actually retries the write instead of no-op'ing
      // against a flag the disk never saw.
      if (this.metaCache.get(cgKey) === meta) this.metaCache.delete(cgKey);
      throw err;
    }
  }

  /**
   * Crash-safe whole-file replace: write a sibling temp file, fsync it,
   * `rename` it over `targetPath`, then fsync the directory so the rename
   * itself survives a power loss. A crash at any point leaves `targetPath`
   * holding either its previous contents or the new ones; the worst leftover
   * is an inert `<target>.tmp-*` sibling that `init()` sweeps. On failure the
   * temp file is removed (best-effort) and the error is rethrown.
   *
   * The temp handle is opened for writing and synced in place, so no
   * separate re-open is needed (which also keeps `FlushFileBuffers` happy on
   * Windows). The directory fsync is `fsyncRfc64DirectoryV1`, which is
   * already a no-op on Windows. Not adopting the RFC-64 owner-only file
   * policy: the temp keeps the default mode the previous `writeFile` used.
   */
  private async writeFileDurable(targetPath: string, bytes: Uint8Array | string): Promise<void> {
    const tempPath = `${targetPath}${TEMP_FILE_INFIX}${process.pid}-${randomUUID()}`;
    this.liveTempPaths.add(tempPath);
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(tempPath, 'wx');
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tempPath, targetPath);
      await fsyncRfc64DirectoryV1(path.dirname(targetPath));
    } catch (err) {
      if (handle) await handle.close().catch(() => { /* already failing */ });
      await fs.rm(tempPath, { force: true }).catch(() => { /* best-effort */ });
      throw err;
    } finally {
      this.liveTempPaths.delete(tempPath);
    }
  }

  /**
   * Append `bytes` to `filePath` and fsync it before returning. Creating a
   * brand-new log leaves its directory entry to the directory fsync that the
   * paired `persistMeta` performs right after (same directory); a crash in
   * between yields, at worst, an orphan `.log` that `init()` reaps.
   */
  private async appendFileDurable(filePath: string, bytes: Uint8Array): Promise<void> {
    const handle = await fs.open(filePath, 'a');
    try {
      await handle.appendFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
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
    const cgKey = this.cgKey(contextGraphId);
    if (this.verifiedLogTails.has(cgKey)) return;
    const filePath = this.logPath(contextGraphId);
    let buf: Buffer | undefined;
    try {
      buf = await fs.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (buf) {
      const { validLength } = scanLogFrames(buf);
      if (validLength < buf.length) {
        const handle = await fs.open(filePath, 'r+');
        try {
          await handle.truncate(validLength);
          await handle.sync();
        } finally {
          await handle.close();
        }
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

  private cgKey(contextGraphId: string): string {
    return createHash('sha256').update(contextGraphId).digest('base64url');
  }

  private logPath(contextGraphId: string): string {
    return path.join(this.dataDir, `${this.cgKey(contextGraphId)}.log`);
  }

  private metaPath(contextGraphId: string): string {
    return path.join(this.dataDir, `${this.cgKey(contextGraphId)}.meta`);
  }
}

/**
 * Walk the length-prefixed frames of a log buffer the same way `iterate`
 * does. `validLength` is the offset just past the last complete frame; any
 * bytes after it are an unparseable tail (a partial header, or a header whose
 * length overruns the file).
 */
function scanLogFrames(buf: Buffer): { lastSeqno: number; validLength: number } {
  let lastSeqno = 0;
  let offset = 0;
  while (offset + ENTRY_HEADER_BYTES <= buf.length) {
    const seqno = Number(buf.readBigUInt64BE(offset + 8));
    const len = buf.readUInt32BE(offset + 16);
    const end = offset + ENTRY_HEADER_BYTES + len;
    if (end > buf.length) break;
    if (seqno > lastSeqno) lastSeqno = seqno;
    offset = end;
  }
  return { lastSeqno, validLength: offset };
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
