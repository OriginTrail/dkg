/**
 * The cold-load owner of the SWM host-mode store (host-mode-store.ts): the
 * in-memory cache of each CG's `.meta` state and the ONE initialization per CG
 * that fills it.
 *
 * `HostStoreMetaLoader.load` is what every access to a CG's metadata goes
 * through. A cache hit is answered at once. A miss starts the CG's cold
 * initialization (read `.meta`, scan the log tail for its highest seqno, take
 * the max, best-effort persist the reconciled cursor, install the result in the
 * cache), and every concurrent caller awaits that same promise. Authoritative
 * persistence and failure eviction remain inside this same owner.
 *
 * Only a MISSING file is absent: no `.meta` loads the defaults, no `.log` means
 * no frames. Any other read error on either file rejects the load and nothing
 * is cached or persisted; see `initialize` and `scanLog`.
 */
import { promises as fs } from 'node:fs';
import type { DurableFiles } from './host-store-durable-fs.js';
import { scanLogFrames, type HostStoreLayout } from './host-store-format.js';
import type { CgMetaState } from './host-store-types.js';

export class HostStoreMetaLoader {
  /** Installed metadata is private to the loading/persistence owner. */
  private readonly cache = new Map<string, { meta: CgMetaState; tail?: { validLength: number; byteLength: number } | null }>();
  /**
   * Cold initialization in flight per CG (see `load`). It is deliberately
   * NOT behind the store's per-CG write lock: mutators hold that lock while
   * they await the initialization, so taking it here would deadlock.
   */
  private readonly initializations = new Map<string, Promise<CgMetaState>>();

  constructor(
    private readonly layout: HostStoreLayout,
    private readonly files: DurableFiles,
  ) {}

  /** Under the CG write lock, finish the same recovery whose cursor readers await. */
  async prepareAppend(contextGraphId: string): Promise<CgMetaState> {
    const meta = await this.load(contextGraphId);
    const entry = this.cache.get(this.layout.cgKey(contextGraphId))!;
    if (entry.tail === undefined) {
      const log = await this.scanLog(contextGraphId);
      meta.seqno = Math.max(meta.seqno, log.lastSeqno); // retain burned reservations
      entry.tail = log;
    }
    if (entry.tail && entry.tail.validLength < entry.tail.byteLength)
      await this.files.truncateFileDurable(this.layout.logPath(contextGraphId), entry.tail.validLength);
    entry.tail = null; // known complete; successful appends preserve this invariant
    return meta;
  }

  /** Failed appends or log replacement retain the cursor but require a fresh tail scan. */
  invalidateTail(contextGraphId: string): void {
    const entry = this.cache.get(this.layout.cgKey(contextGraphId));
    if (entry) entry.tail = undefined;
  }

  /** Mutators hold the host store's per-graph write lock around this transition. */
  async persist(contextGraphId: string, meta: CgMetaState): Promise<void> {
    const cgKey = this.layout.cgKey(contextGraphId);
    const cache = this.cache;
    const current = cache.get(cgKey);
    cache.set(cgKey, { meta, tail: current?.tail });
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
      if (cache.get(cgKey)?.meta === meta) cache.delete(cgKey);
      throw err;
    }
  }

  /**
   * Load (and cache) the per-CG metadata. A cold load reconciles the seqno
   * cursor against the actual log file: a crash between the frame append
   * and `persistMeta` (both fsynced, in that order) would otherwise let the
   * next append reuse the same seqno, which would break host-catchup paging
   * that uses strict-greater-than seqno.
   *
   * The log is the source of truth for what was actually persisted; the meta
   * file is a cache of the highest-known seqno plus the `registered` flag.
   * After process start we always trust the log tail's max seqno over the
   * meta file's cursor if the two disagree: taking
   * `max(metaSeqno, lastLogSeqno)` guarantees we never recycle a seqno even if
   * the meta write lost a race to the crash.
   *
   * There is exactly one owner of a cold load per CG: the first caller starts
   * the initialization and every concurrent caller (the unlocked
   * `isRegistered` / `getLastSeqno` / `stats` and the locked mutators, which
   * call this while holding the per-CG write lock) awaits that same promise.
   * The initialization never takes the write lock, so a mutator waiting on it
   * cannot deadlock, and a mutator cannot start its own work until the
   * initialization, including its reconcile write, has finished. That is what
   * keeps a delayed reconcile rename from overwriting a newer `.meta`.
   * A rejected initialization is not cached: the entry is dropped when it
   * settles and the next caller starts a fresh one.
   *
   * This stays `async`, but the body has no `await`: an async function runs
   * synchronously up to its first `await`, so the cache check, the in-flight
   * lookup and the registration of a new initialization are one step that
   * nothing can interleave with (an `await` between the lookup and the
   * registration would let two callers each start an initialization). Being
   * `async` also keeps a synchronous throw (`cgKey` on a non-string id) a
   * rejection, which the unlocked readers' `.catch(() => null)` absorbs.
   */
  async load(contextGraphId: string): Promise<CgMetaState> {
    const cgKey = this.layout.cgKey(contextGraphId);
    const cached = this.cache.get(cgKey);
    if (cached) return Promise.resolve(cached.meta);
    const pending = this.initializations.get(cgKey);
    if (pending) return pending;
    const initialization = this.initialize(contextGraphId, cgKey).finally(() => {
      this.initializations.delete(cgKey);
    });
    this.initializations.set(cgKey, initialization);
    return initialization;
  }

  /**
   * The single cold-load pass behind `load`: read `.meta`, scan the log
   * tail, reconcile, best-effort persist the reconciled cursor, install into
   * the cache. The cache is written only on success (and, by construction,
   * before the promise resolves, so a waiter never observes a cache miss).
   *
   * Only a missing `.meta` (ENOENT) is "no metadata yet" and yields the
   * defaults. Any other read error rejects the load: the file may well be
   * intact, and defaults cached in its place would be written back over it by
   * the next mutation, which restarts the cursor (at 1 once retention has
   * emptied the log) and drops the persisted flags. A `.meta` that reads but
   * does not parse stays what it was before, unusable: defaults here, and
   * `init()` reaps it together with its log.
   */
  private async initialize(contextGraphId: string, cgKey: string): Promise<CgMetaState> {
    const metaPath = this.layout.metaPath(contextGraphId);
    let txt: string | undefined;
    try {
      txt = await fs.readFile(metaPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    let parsed: CgMetaState | undefined;
    if (txt !== undefined) {
      try {
        parsed = JSON.parse(txt) as CgMetaState;
      } catch {
        parsed = undefined;
      }
    }
    const log = await this.scanLog(contextGraphId);
    const state: CgMetaState = {
      seqno: Math.max(parsed?.seqno ?? 0, log.lastSeqno),
      registered: parsed?.registered ?? false,
      contextGraphId,
      ...(parsed?.hostModeSubscribed === true ? { hostModeSubscribed: true } : {}),
    };
    // If the log says more than the meta does, persist the reconciled cursor
    // so subsequent cold loads don't have to re-scan the log tail. Best-effort:
    // the cursor is re-derived from the log on the next cold load anyway.
    if (parsed && state.seqno !== parsed.seqno) {
      await this.files.writeFileDurable(metaPath, JSON.stringify(state)).catch(() => { /* best-effort */ });
    }
    this.cache.set(cgKey, { meta: state, tail: log });
    return state;
  }

  /**
   * Scan the per-CG log tail and return the highest seqno actually
   * persisted on disk. Reads the whole file (the per-CG cap keeps
   * this bounded — default 1 MiB unregistered, 64 MiB registered)
   * and walks frame-by-frame. Returns 0 if no log file exists or
   * the file is empty/corrupt at the head.
   *
   * "No log file" is ENOENT on the read and nothing else. Any other
   * read error rejects (and the load with it): answering 0 would let
   * a cursor that lags the log stand, and the next append would write
   * a seqno that is already in the log.
   */
  private async scanLog(contextGraphId: string): Promise<{ lastSeqno: number; validLength: number; byteLength: number }> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.layout.logPath(contextGraphId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return { lastSeqno: 0, validLength: 0, byteLength: 0 };
    }
    return { ...scanLogFrames(buf), byteLength: buf.length };
  }
}
