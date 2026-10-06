/**
 * The cold-load owner of the SWM host-mode store (host-mode-store.ts): the
 * in-memory cache of each CG's `.meta` state and the ONE initialization per CG
 * that fills it.
 *
 * `HostStoreMetaLoader.load` is what every access to a CG's metadata goes
 * through. A cache hit is answered at once. A miss starts the CG's cold
 * initialization (read `.meta`, scan the log tail for its highest seqno, take
 * the max, best-effort persist the reconciled cursor, install the result in the
 * cache), and every concurrent caller awaits that same promise. The store owns
 * the writes that follow (it sets and drops cache entries through `cache`).
 *
 * Only a MISSING file is absent: no `.meta` loads the defaults, no `.log` means
 * no frames. Any other read error on either file rejects the load and nothing
 * is cached or persisted; see `initialize` and `recoverLastSeqnoFromLog`.
 */
import { promises as fs } from 'node:fs';
import type { DurableFiles } from './host-store-durable-fs.js';
import { scanLogFrames, type HostStoreLayout } from './host-store-format.js';
import type { CgMetaState } from './host-store-types.js';

export class HostStoreMetaLoader {
  /** The metadata installed so far, by `cgKey`. The store sets and drops entries as it persists. */
  readonly cache = new Map<string, CgMetaState>();
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
    if (cached) return Promise.resolve(cached);
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
    const logSeqno = await this.recoverLastSeqnoFromLog(contextGraphId);
    const state: CgMetaState = {
      seqno: Math.max(parsed?.seqno ?? 0, logSeqno),
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
    this.cache.set(cgKey, state);
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
  private async recoverLastSeqnoFromLog(contextGraphId: string): Promise<number> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.layout.logPath(contextGraphId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return 0;
    }
    return scanLogFrames(buf).lastSeqno;
  }
}
