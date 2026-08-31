import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TripleStore, Quad, TripleStoreQueryOptions, QueryResult, UpdateOptions } from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';
import { GraphWriteGenTracker, type GraphWriteScope } from '../graph-write-gen.js';
import { raceStoreWorkAgainstAbort } from '../abortable-store-work-lifecycle.js';
import { executeRfc64SemanticReadCapabilityV1 } from '../rfc64-semantic-read-capability.js';
import type { Rfc64SemanticReadOperationV1 } from '@origintrail-official/dkg-core';
import {
  normalizeRfc64AuthorCommitCasV1,
  type Rfc64AuthorCommitCasInputV1,
  type Rfc64AuthorCommitCasResultV1,
} from '../rfc64-author-commit-cas.js';

/**
 * Default per-operation timeout for the embedded worker store. The worker is
 * a SINGLE thread that processes store ops FIFO, so one slow / wedged op (a
 * huge import, an expensive query, or a genuinely hung worker) blocks every
 * other store-backed request queued behind it. Without a bound, the caller —
 * an API route, the publisher, gossip ingest — waits FOREVER. That is the
 * exact signature behind issues #997 / #999 / #1002 / #1005 / #1008:
 * `/api/status` (no store) stays green while `/api/query`,
 * `/api/context-graph/list`, `/api/assertion/create` never return.
 *
 * A bounded wait turns an indefinite hang into a surfaced error the operator
 * can act on (the message points at the real fix: use an external SPARQL
 * server for heavy workloads). 120s is generous enough not to trip normal
 * operations yet finite. Set `operationTimeoutMs: 0` to restore the old
 * unbounded behaviour.
 *
 * IMPORTANT — the timeout is applied to READ-ONLY ops only (see
 * READ_ONLY_METHODS). A read is side-effect-free, so bounding the caller's wait
 * and rejecting is always a clean, determinate failure. A mutation is NOT
 * bounded: the timeout only drops the caller's promise while the single worker
 * thread keeps running the op, so a "timed-out" insert/delete could STILL
 * commit afterwards — and the rest of the codebase treats a rejected
 * insert/delete as a clean failure, which would leave partial state visible and
 * retries ambiguous. The user-visible hang in the issues above is on the read
 * paths (`/api/query`, `/api/context-graph/list`); bounding reads surfaces a
 * wedged worker there without inventing an indeterminate mutation outcome.
 */
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;

/**
 * Backoff (ms) before each consecutive respawn attempt after an UNEXPECTED
 * worker exit: the first attempt is immediate (a one-off OOM/crash should
 * recover with zero visible downtime), then 1s / 5s / 30s, capped at the last
 * tier. The cap keeps a persistently-crashing worker (corrupt state, chronic
 * OOM on load) from melting the node in a hot spawn/crash loop while still
 * retrying often enough that a transient cause self-heals.
 */
const RESPAWN_BACKOFF_MS = [0, 1_000, 5_000, 30_000];

/**
 * Give-up bound: after this many CONSECUTIVE respawned workers die without
 * serving a single successful op, stop respawning and latch the store closed
 * (the pre-recovery behaviour) with fatal operator guidance. The counter
 * resets on the first successful reply from a worker (see the message handler
 * in spawnWorker), so occasional crashes days apart never accumulate here —
 * only a genuine crash loop trips it.
 */
const MAX_CONSECUTIVE_RESPAWNS = 5;

/** Unref'd sleep — a respawn backoff timer must not keep the process alive on its own. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

export interface OxigraphWorkerStoreOptions {
  /**
   * Per-operation timeout in milliseconds for READ-ONLY ops. Default 120_000.
   * 0 disables it. Mutations are intentionally never bounded (see
   * DEFAULT_OPERATION_TIMEOUT_MS) so a timed-out write can't be reported as a
   * clean failure while it is still in flight.
   */
  operationTimeoutMs?: number;
}

/**
 * Accept only a finite, non-negative override; otherwise fall back. The result
 * is floored to an INTEGER — the timeout is a millisecond count, so a fractional
 * value is meaningless noise.
 */
function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function asAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

/**
 * Side-effect-free read methods. ONLY these are bounded by the per-op timeout:
 * rejecting a read after the bound is a clean, determinate failure (nothing was
 * written), so it safely surfaces a wedged worker on the exact paths that hang
 * in production. Every other method mutates persisted state and is left
 * unbounded — see DEFAULT_OPERATION_TIMEOUT_MS for why timing out a mutation
 * would be unsafe with the current call sites.
 */
const READ_ONLY_METHODS = new Set<string>([
  'query', 'hasGraph', 'listGraphs', 'countQuads',
]);

/** Rejection raised when a read op exceeds its per-op timeout. */
export interface OxigraphWorkerTimeoutError extends Error {
  code: 'OXIGRAPH_WORKER_OP_TIMEOUT';
  /** Which store method timed out. */
  method: string;
  /** The bound that was exceeded. */
  timeoutMs: number;
}

/**
 * Explicit worker POLICY state, replacing the old cluster of interdependent
 * booleans/promises that all had to agree. `respawnGaveUp` folds into the
 * 'gave_up' state and the new terminal 'in_memory_lost' state; `workerExited`
 * stays as a separate lower-level FACT (it is orthogonal — see the field
 * comment), and `closePromise`/`respawnPromise`/`consecutiveRespawnFailures`
 * still carry their own orthogonal data. A single discriminated field makes the
 * invalid states that used to be representable — e.g. "gave up" AND "live", or
 * an in-memory store silently marked healthy after a crash — impossible to
 * construct, and it gives every read a single, obvious source of truth. The
 * state graph is:
 *
 *   live ──unexpected exit, persisted──▶ respawning ──spawned──▶ live
 *   live ──unexpected exit, in-memory──▶ in_memory_lost   (terminal — finding 1)
 *   respawning ──crash-loop bound hit──▶ gave_up          (terminal)
 *   live | respawning ──close()────────▶ closing ──drained──▶ closed (terminal)
 *
 * `respawning` is the only state in which the current worker thread is dead but
 * a replacement is on the way, so parked ops wait it out (see callAfterRespawn).
 * Every other non-`live` state means "no usable worker" and fails ops fast.
 */
type WorkerLifecycle =
  | 'initializing'
  | 'live'
  | 'respawning'
  | 'closing'
  | 'closed'
  | 'gave_up'
  | 'in_memory_lost';

/** Terminal states: the store will never serve another op and never respawns. */
const TERMINAL: ReadonlySet<WorkerLifecycle> = new Set<WorkerLifecycle>([
  'closed', 'gave_up', 'in_memory_lost',
]);

export class OxigraphWorkerStore implements TripleStore {
  readonly queryCancellation = 'interruptible' as const;
  readonly rfc64SemanticReadCertifiedV1 = true as const;

  // Assigned by spawnWorker(), which the constructor always calls — hence the
  // definite-assignment assertion instead of an initializer.
  private worker!: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  // #1609: per-graph write generations, bumped client-side after each
  // successful mutation RPC (the worker owns no caller-visible caches).
  // Feeds the chain-reconcile negative memo via `asGraphWriteGenSource`.
  private readonly writeGen = new GraphWriteGenTracker();
  private readonly operationTimeoutMs: number;
  /** Resolved path of the compiled worker impl; reused verbatim on respawn. */
  private readonly workerPath: string;
  /** Persistence file handed to every spawned worker (undefined = in-memory). */
  private readonly persistPath: string | undefined;
  /**
   * Single source of truth for the store's high-level POLICY state (see
   * WorkerLifecycle). It subsumes the former `respawnGaveUp` boolean (⇔ state
   * === 'gave_up') and adds the terminal 'in_memory_lost' state that finding-1
   * needs, so the give-up/close/data-lost verdicts can never disagree the way
   * an ad-hoc cluster of interdependent booleans could. Set to 'live' the
   * moment spawnWorker() arms a fresh thread; only ever moves along the
   * documented transitions (every write is guarded — `setLifecycle` for the
   * non-spawn hops and `markSpawnedLive` for the spawn → 'live' hop — so a
   * terminal state can never silently reopen).
   *
   * `workerExited` below stays as a separate, lower-level FACT ("the current
   * thread has exited") because it is genuinely orthogonal to policy: during a
   * graceful close() the state is 'closing' while the thread is still alive and
   * mid-flush, then the thread exits — same policy state, different fact. The
   * old soup was the *interdependence* of workerExited + respawnGaveUp +
   * respawnPromise + closePromise all having to agree; folding the policy half
   * into one discriminated field removes that.
   *
   * The initializer is a pre-construction placeholder only: the constructor
   * always calls spawnWorker() (whose `markSpawnedLive` accepts the
   * non-terminal 'initializing' placeholder), so no op ever observes this
   * value. 'initializing' is deliberately NON-terminal so the spawn guard can
   * enforce terminal permanence uniformly — a placeholder of 'closed' (a
   * terminal state) would have made the first legal spawn indistinguishable
   * from illegally reopening a closed store.
   */
  private lifecycle: WorkerLifecycle = 'initializing';
  /** Set once the CURRENT worker thread has exited (graceful close, crash, or kill); cleared by spawnWorker(). */
  private workerExited = false;
  /** Memoized close so repeat/concurrent close() calls share one teardown. */
  private closePromise: Promise<void> | null = null;
  /**
   * In-flight replacement of a crashed worker. While set, NEW ops park on it
   * (see callWithTimeout) instead of failing, so a request that races the
   * respawn sees a slightly slower success rather than a spurious error.
   * Null whenever a live worker is armed. Tracked separately from `lifecycle`
   * because ops need the actual promise to await, not just the 'respawning' tag.
   */
  private respawnPromise: Promise<void> | null = null;
  /**
   * How many respawned workers in a row died without answering a single op
   * successfully. Reset to 0 by the first successful reply; feeds the backoff
   * tier and the MAX_CONSECUTIVE_RESPAWNS give-up bound.
   */
  private consecutiveRespawnFailures = 0;

  constructor(persistPath?: string, opts?: OxigraphWorkerStoreOptions) {
    this.operationTimeoutMs = normalizeNonNegativeInt(opts?.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);

    // Resolve the worker impl with a small search path so this keeps
    // working in all three deployment shapes we actually run in:
    //
    //   1. Production / npm install / built monorepo — this module is
    //      loaded from `dist/adapters/oxigraph-worker.js`, so the
    //      sibling `./oxigraph-worker-impl.js` resolves correctly.
    //   2. vitest against raw source — this module is loaded from
    //      `src/adapters/oxigraph-worker.ts`, so the sibling
    //      `./oxigraph-worker-impl.js` does NOT exist, but its compiled
    //      twin in `dist/adapters/` does as long as the caller ran
    //      `pnpm --filter ...dkg-storage build` first. Redirect to
    //      that path so the adapter is runnable in dev loops.
    //   3. Neither file exists — genuinely unbuilt tree. Throw a loud,
    //      actionable error explaining the fix (`pnpm build`), matching
    //      the expectation in `test/storage.test.ts`.
    const siblingJsUrl = new URL('./oxigraph-worker-impl.js', import.meta.url);
    const siblingJsPath = fileURLToPath(siblingJsUrl);
    let workerPath: string | null = existsSync(siblingJsPath) ? siblingJsPath : null;
    if (!workerPath) {
      const srcAdapters = `${sep}src${sep}adapters${sep}`;
      const distAdapters = `${sep}dist${sep}adapters${sep}`;
      if (siblingJsPath.includes(srcAdapters)) {
        const candidate = siblingJsPath.replace(srcAdapters, distAdapters);
        if (existsSync(candidate)) workerPath = candidate;
      }
    }
    if (!workerPath) {
      throw new Error(
        `oxigraph-worker adapter: compiled worker artefact ` +
          `\`oxigraph-worker-impl.js\` was not found next to ` +
          `${siblingJsPath} or in the sibling \`dist/adapters/\` ` +
          `directory. Run \`pnpm --filter @origintrail-official/dkg-storage build\` ` +
          `before using this adapter.`,
      );
    }
    this.workerPath = workerPath;
    this.persistPath = persistPath;
    this.spawnWorker();
  }

  rfc64SemanticReadV1(
    operation: Rfc64SemanticReadOperationV1,
    options?: Pick<TripleStoreQueryOptions, 'signal'>,
  ) {
    return executeRfc64SemanticReadCapabilityV1(this, operation, options);
  }

  /**
   * The single writer for `this.lifecycle`. A typed setter (rather than raw
   * field assignment scattered across the class) gives us one place to assert
   * the invariant that matters: a TERMINAL state is a dead end. Without this
   * guard a latent bug — a stray respawn resurrecting a `gave_up` store, or a
   * crash handler firing after `close()` — could silently re-open a store the
   * operator was told is gone, which is exactly the class of "healthy-looking
   * but wrong" state finding 1 is about. If we ever try to leave a terminal
   * state we throw loudly instead.
   */
  private setLifecycle(next: WorkerLifecycle): void {
    if (this.lifecycle === next) return;
    if (TERMINAL.has(this.lifecycle)) {
      throw new Error(
        `oxigraph-worker: illegal lifecycle transition ${this.lifecycle} → ${next} ` +
          '(terminal states are permanent) — this is a bug in the respawn supervisor.',
      );
    }
    this.lifecycle = next;
  }

  /**
   * The ONE guarded transition INTO 'live' — used by spawnWorker() for both the
   * constructor's first spawn (from the 'initializing' placeholder) and a
   * respawn (from 'respawning'). `setLifecycle` can't own this hop because
   * entering 'live' is legal only from those two non-terminal states, but the
   * terminal-permanence invariant must still hold: a spawn attempted after
   * 'closed' / 'gave_up' / 'in_memory_lost' (e.g. a future respawn/close code
   * path calling spawnWorker() by mistake) MUST throw rather than silently
   * resurrect a store that promised it would never serve another op.
   */
  private markSpawnedLive(): void {
    if (this.lifecycle === 'live') return;
    if (this.lifecycle !== 'initializing' && this.lifecycle !== 'respawning') {
      throw new Error(
        `oxigraph-worker: illegal spawn transition ${this.lifecycle} → live ` +
          '(a worker may only be spawned from initializing or respawning; ' +
          'terminal states are permanent) — this is a bug in the respawn supervisor.',
      );
    }
    this.lifecycle = 'live';
  }

  /** True once an operator-initiated close() has begun (closing or closed). */
  private get isClosing(): boolean {
    return this.lifecycle === 'closing' || this.lifecycle === 'closed';
  }

  /**
   * Create the worker thread and arm its lifecycle handlers. Shared by the
   * constructor and by respawn() so a replacement worker is wired IDENTICALLY
   * to the original — same impl path, same workerData, same handlers — and the
   * OxigraphWorkerStore object keeps its identity, so every alias held across
   * the daemon (routes, publisher, gossip ingest) transparently talks to the
   * new thread. Each handler captures the worker it was armed for and no-ops
   * if `this.worker` has since moved on, so a stale event from an
   * already-replaced thread can never clobber the live one's state.
   */
  private spawnWorker(): void {
    const worker = new Worker(this.workerPath, {
      workerData: { persistPath: this.persistPath },
    });
    this.worker = worker;
    this.workerExited = false;
    // Arming a fresh thread IS the transition into 'live'. Route it through the
    // guarded `markSpawnedLive` (not `setLifecycle`, which forbids ALL entries
    // to 'live'): it permits the two legal predecessors — the 'initializing'
    // placeholder (constructor's first spawn) and 'respawning' (a respawn) —
    // while still throwing on terminal states, so a stray spawn after close /
    // give-up / in-memory-loss can never silently resurrect the store. close()
    // and the respawn supervisor are the only other writers and never race
    // this: a spawn only happens in the constructor or within respawn(), which
    // bails the moment a close() is seen.
    this.markSpawnedLive();
    worker.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
      if (this.worker !== worker) return;
      // Any successful reply proves this worker is healthy, which ends the
      // crash-loop accounting window (see MAX_CONSECUTIVE_RESPAWNS).
      if (!msg.error) this.consecutiveRespawnFailures = 0;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      // Loud by design. 'error' means the worker thread threw an uncaught
      // exception (an 'exit' event follows). This used to be silent, which is
      // how a testnet node served HTTP for DAYS with a dead store — green
      // /api/status, 503 on every write — and nothing in the logs said why.
      console.error('[oxigraph-worker] worker thread error (thread is going down):', err);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
    // Once the worker exits, no pending op can ever get a reply. Settle them all
    // (reject) instead of leaving callers hung forever — this is what makes the
    // unbounded `close()` safe: if a second close (or any op) is still queued
    // when terminate() kills the thread, it rejects here rather than hanging.
    //
    // Three very different exits land here (branch on lifecycle + persistPath):
    //   • intentional — close() ran (state is 'closing'). Stay closed; close()
    //     owns the final transition to 'closed'.
    //   • unexpected, disk-persisted — the thread died on its own.
    //     ERR_WORKER_OUT_OF_MEMORY, for example, kills ONLY the worker thread,
    //     not the process, so the daemon would otherwise keep serving with a
    //     permanently dead store. The committed state is on disk, so a fresh
    //     worker on the same path reopens it — go 'respawning' and recover.
    //   • unexpected, IN-MEMORY — there is no disk to reload from, so a fresh
    //     worker would come up EMPTY and look perfectly healthy while every
    //     row written before the crash is silently gone (confirmed live: data
    //     vanished). That is unrecoverable, so we FAIL CLOSED into the terminal
    //     'in_memory_lost' state instead of respawning an empty store — every
    //     later op then rejects with a clear data-loss error (see postToWorker)
    //     rather than returning wrong-but-plausible results.
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.workerExited = true;
      const intentional = this.isClosing;
      // Distinguish the two unexpected exits up front so the log and the
      // lifecycle transition below agree on what just happened.
      const inMemoryLost = !intentional && this.persistPath === undefined;
      if (intentional) {
        console.info(`[oxigraph-worker] worker exited (code ${code}) — initiated by close()`);
      } else if (inMemoryLost) {
        console.error(
          `[oxigraph-worker] worker exited UNEXPECTEDLY (code ${code}) — nobody called close(). ` +
            'FATAL: this store is IN-MEMORY (no persistPath), so its entire contents were lost with the ' +
            'worker thread and CANNOT be recovered. Failing the store closed instead of silently continuing ' +
            'with an empty store — every store-backed request will now fail fast. Use a disk-persisted store ' +
            '(store.path) if the workload must survive a worker crash.',
        );
      } else {
        console.error(
          `[oxigraph-worker] worker exited UNEXPECTEDLY (code ${code}) — nobody called close(). ` +
            'The store is disk-persisted; respawning a fresh worker on the same path.',
        );
      }
      if (this.pending.size > 0) {
        const err = intentional
          ? new Error('oxigraph-worker: worker exited before the operation completed (store closed)')
          : inMemoryLost
          ? new Error(
              `oxigraph-worker: the IN-MEMORY worker exited unexpectedly (code ${code}) before the operation ` +
                'completed and its data was lost — an in-memory store cannot be recovered from a worker crash.',
            )
          : new Error(
              `oxigraph-worker restarted — retry: the worker exited unexpectedly (code ${code}) before the ` +
                'operation completed, so its outcome is unknown; a replacement worker is being spawned.',
            );
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
      }
      // Route the state transition. close() already moved us to 'closing' and
      // owns the final hop to 'closed', so the intentional case touches nothing.
      if (inMemoryLost) {
        this.setLifecycle('in_memory_lost');
      } else if (!intentional) {
        this.scheduleRespawn();
      }
    });
  }

  /** Arm (at most one) background respawn; the policy lives in respawn(). */
  private scheduleRespawn(): void {
    // Never resurrect a store that has already given up, been closed, or lost
    // its in-memory data, and never stack a second supervisor on an in-flight
    // one. This is only ever reached from the exit handler's disk-persisted
    // unexpected-exit branch, so we're normally transitioning out of 'live'.
    if (this.respawnPromise || TERMINAL.has(this.lifecycle)) return;
    this.setLifecycle('respawning');
    // respawn() never rejects (every failure path is caught and looped or
    // latched), so this promise can't become an unhandled rejection while no
    // op happens to be parked on it.
    this.respawnPromise = this.respawn().finally(() => {
      this.respawnPromise = null;
    });
  }

  /**
   * Replace a crashed worker with a fresh one: immediate first attempt, then
   * capped backoff (RESPAWN_BACKOFF_MS) between consecutive attempts, giving
   * up for good after MAX_CONSECUTIVE_RESPAWNS workers in a row die without
   * serving a single successful op. Giving up latches the store closed —
   * exactly the pre-recovery behaviour — but with a FATAL log telling the
   * operator what happened and where to look, instead of the old silence.
   */
  private async respawn(): Promise<void> {
    while (true) {
      // close() raced the respawn — honour it. An operator-initiated close
      // must never be resurrected by the supervisor. (close() flips lifecycle
      // to 'closing' atomically before awaiting, so isClosing is the signal.)
      if (this.isClosing) return;
      if (this.consecutiveRespawnFailures >= MAX_CONSECUTIVE_RESPAWNS) {
        this.setLifecycle('gave_up');
        console.error(
          `[oxigraph-worker] FATAL: the worker died ${MAX_CONSECUTIVE_RESPAWNS} times in a row without ` +
            'serving a single successful operation — giving up on respawn and latching the store closed. ' +
            'Every store-backed request will now fail fast. Investigate the crash cause (worker OOM → raise ' +
            'memory or move to an external SPARQL backend via store.backend "sparql-http" / "blazegraph"; ' +
            'corrupt persist file → see the quarantine log) and restart the node.',
        );
        return;
      }
      const attempt = this.consecutiveRespawnFailures;
      this.consecutiveRespawnFailures += 1;
      const delayMs = RESPAWN_BACKOFF_MS[Math.min(attempt, RESPAWN_BACKOFF_MS.length - 1)];
      if (delayMs > 0) {
        console.error(
          `[oxigraph-worker] respawn attempt ${attempt + 1}/${MAX_CONSECUTIVE_RESPAWNS} in ${delayMs}ms…`,
        );
        await sleep(delayMs);
        // Re-check: close() may have arrived during the backoff sleep.
        if (this.isClosing) return;
      }
      try {
        this.spawnWorker();
        console.info(`[oxigraph-worker] respawned worker (attempt ${attempt + 1}/${MAX_CONSECUTIVE_RESPAWNS})`);
        return;
      } catch (err) {
        // new Worker() itself can throw (e.g. the impl file vanished at
        // runtime). Treat it exactly like a worker that died instantly and
        // loop into the next backoff tier.
        console.error('[oxigraph-worker] respawn attempt failed to start a worker:', err);
      }
    }
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    // Only read-only ops are bounded; mutations run unbounded (timeoutMs 0) so a
    // timed-out write is never reported as a clean failure while still in flight.
    const timeoutMs = READ_ONLY_METHODS.has(method) ? this.operationTimeoutMs : 0;
    return this.callWithTimeout<T>(timeoutMs, undefined, method, ...args);
  }

  /**
   * Post one op to the (live) worker and await its reply, bounding the caller's
   * wait by `timeoutMs` (0 = wait indefinitely). The bound is per-CALLER: on
   * timeout or caller abort we reject and drop the pending entry, but the
   * single-threaded worker is STILL running the op — the late reply is then
   * ignored (the message handler no-ops on a missing id) rather than
   * double-settling this promise. Only read-only ops are ever given a non-zero
   * timeout (see `call`), so a fired timeout is always a determinate,
   * side-effect-free failure. If a crashed worker is being replaced, the op
   * first parks on the respawn (the timeout starts only once it is actually
   * posted — backoff is capped well below the default read bound anyway).
   */
  private callWithTimeout<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    method: string,
    ...args: unknown[]
  ): Promise<T> {
    // A crashed worker may be mid-replacement right now. Park the op on the
    // respawn instead of failing it: the store is disk-persisted and about to
    // come back, so the caller sees a slightly slower success rather than a
    // spurious "store is closed" for a condition the store is already fixing.
    if (this.respawnPromise) return this.callAfterRespawn<T>(timeoutMs, signal, method, args);
    return this.postToWorker<T>(timeoutMs, signal, method, args);
  }

  /**
   * Wait out the in-flight respawn(s), then post as normal. A loop rather
   * than a single await because the replacement worker can itself die before
   * this op gets posted, arming a new respawnPromise. If the respawn gave up,
   * postToWorker's workerExited guard turns this into the fail-fast closed
   * error (with the crash-loop guidance appended).
   */
  private async callAfterRespawn<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    method: string,
    args: unknown[],
  ): Promise<T> {
    while (this.respawnPromise) {
      await raceStoreWorkAgainstAbort(this.respawnPromise, signal);
    }
    if (signal?.aborted) throw asAbortError(signal.reason);
    return this.postToWorker<T>(timeoutMs, signal, method, args);
  }

  private postToWorker<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    method: string,
    args: unknown[],
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // The worker is gone (closed, crashed with respawn given up, or an
      // in-memory store whose data was lost) — a posted message would never be
      // answered, so fail fast instead of registering a pending entry that can
      // only ever hang. The lifecycle picks the RIGHT diagnostic:
      //   • in_memory_lost — the data is unrecoverable; say so plainly instead
      //     of pretending the store merely "closed" (finding 1: never let an
      //     in-memory crash look like a clean close or an empty-but-healthy store).
      //   • gave_up — closed + the crash-loop guidance.
      //   • otherwise — a plain operator close.
      if (this.workerExited) {
        if (this.lifecycle === 'in_memory_lost') {
          reject(new Error(
            `oxigraph-worker: cannot run "${method}" — the IN-MEMORY store's worker crashed and its data was ` +
              'lost. An in-memory store cannot be recovered from a worker crash; every request now fails ' +
              'fast. Use a disk-persisted store (store.path) or restart the node to start from empty.',
          ));
          return;
        }
        reject(new Error(
          `oxigraph-worker: cannot run "${method}" — the store is closed.` +
            (this.lifecycle === 'gave_up'
              ? ' (The worker crashed repeatedly and automatic respawn gave up — restart the node and ' +
                'investigate the [oxigraph-worker] crash logs.)'
              : ''),
        ));
        return;
      }
      if (signal?.aborted) {
        reject(asAbortError(signal.reason));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            cleanup();
            const err = new Error(
              `oxigraph-worker: "${method}" timed out after ${timeoutMs}ms. ` +
              `The embedded store runs on a single worker thread, so a long-running or ` +
              `stuck operation blocks all reads queued behind it. For heavy workloads ` +
              `point the node at an external SPARQL server (store.backend "sparql-http" ` +
              `/ "blazegraph"), or raise / disable store.options.operationTimeoutMs.`,
            ) as OxigraphWorkerTimeoutError;
            err.code = 'OXIGRAPH_WORKER_OP_TIMEOUT';
            err.method = method;
            err.timeoutMs = timeoutMs;
            reject(err);
          }
        }, timeoutMs);
        // A pending-op timer must not keep the process alive on its own.
        if (typeof timer.unref === 'function') timer.unref();
      }
      this.pending.set(id, {
        resolve: (v) => { cleanup(); resolve(v as T); },
        reject: (e) => { cleanup(); reject(e); },
      });
      if (signal) {
        onAbort = () => {
          if (this.pending.delete(id)) {
            cleanup();
            reject(asAbortError(signal.reason));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      try {
        this.worker.postMessage({ id, method, args });
      } catch (err) {
        if (this.pending.delete(id)) {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  // A single atomic worker message: all quads commit together or the call
  // fails. The contract is "all-or-nothing" and every caller can rely on it
  // (e.g. FinalizationHandler packs both canonical copies into one insert so one
  // can't land without the other). Large idempotent bulk imports that want
  // head-of-line fairness should run on an external SPARQL server, not by
  // silently fragmenting this insert into non-atomic chunks.
  async insert(quads: Quad[]): Promise<void> {
    await this.runTrackedWrite(
      { kind: 'graphs', graphs: [...new Set(quads.map((q) => q.graph || ''))] },
      () => this.call('insert', quads),
    );
  }
  async delete(quads: Quad[]): Promise<void> {
    await this.runTrackedWrite(
      { kind: 'graphs', graphs: [...new Set(quads.map((q) => q.graph || ''))] },
      () => this.call('delete', quads),
    );
  }
  async deleteByPattern(pattern: Partial<Quad>): Promise<number> {
    return this.runTrackedWrite(
      pattern.graph
        ? { kind: 'graphs', graphs: [pattern.graph] }
        : { kind: 'all' },
      () => this.call<number>('deleteByPattern', pattern),
    );
  }
  async deleteByPatternWithoutCount(pattern: Partial<Quad>): Promise<void> {
    await this.deleteByPattern(pattern);
  }
  // Server-side SPARQL UPDATE forwarded to the worker's OxigraphStore (which
  // implements `update`); same atomic single-message contract as `insert`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async update(sparql: string, _options?: UpdateOptions): Promise<void> {
    // A raw UPDATE's write scope is not derivable at the call site
    // (`touchedGraphs` hints only membership changes) — unscoped lifecycle.
    await this.runTrackedWrite({ kind: 'all' }, () => this.call('update', sparql));
  }
  async replaceGraph(graphUri: string, quads: Quad[]): Promise<void> {
    await this.runTrackedWrite(
      { kind: 'graphs', graphs: [graphUri] },
      () => this.call('replaceGraph', graphUri, quads),
    );
  }
  async replaceGraphAndSubject(
    graphUri: string,
    graphQuads: Quad[],
    metaGraphUri: string,
    metadataSubject: string,
    metadataQuads: Quad[],
  ): Promise<void> {
    await this.runTrackedWrite(
      { kind: 'graphs', graphs: [graphUri, metaGraphUri] },
      () => this.call(
        'replaceGraphAndSubject',
        graphUri,
        graphQuads,
        metaGraphUri,
        metadataSubject,
        metadataQuads,
      ),
    );
  }
  async replaceSubject(graphUri: string, subject: string, quads: Quad[]): Promise<void> {
    // The worker dispatch is generic (`store[method](...args)`), so this routes
    // to the worker's embedded OxigraphStore.replaceSubject — one atomic
    // single-message commit, same contract as insert/replaceGraph.
    await this.runTrackedWrite({ kind: 'graphs', graphs: [graphUri] }, () =>
      this.call('replaceSubject', graphUri, subject, quads));
  }
  async rfc64AuthorCommitCasV1(
    input: Rfc64AuthorCommitCasInputV1,
    options?: TripleStoreQueryOptions,
  ): Promise<Rfc64AuthorCommitCasResultV1> {
    if (options?.signal?.aborted) throw asAbortError(options.signal.reason);
    const manifest = normalizeRfc64AuthorCommitCasV1(input);
    return this.runTrackedWrite(
      { kind: 'graphs', graphs: [...manifest.touchedGraphs] },
      () => this.call<Rfc64AuthorCommitCasResultV1>(
        'rfc64AuthorCommitCasNormalizedV1',
        manifest,
      ),
    );
  }
  async query(sparql: string, options?: TripleStoreQueryOptions): Promise<QueryResult> {
    return this.callWithTimeout<QueryResult>(this.operationTimeoutMs, options?.signal, 'query', sparql);
  }
  async hasGraph(graphUri: string, options?: TripleStoreQueryOptions): Promise<boolean> {
    return this.callWithTimeout<boolean>(this.operationTimeoutMs, options?.signal, 'hasGraph', graphUri);
  }
  async createGraph(graphUri: string): Promise<void> { return this.call('createGraph', graphUri); }
  async dropGraph(graphUri: string): Promise<void> {
    await this.runTrackedWrite(
      { kind: 'graphs', graphs: [graphUri] },
      () => this.call('dropGraph', graphUri),
    );
  }
  async listGraphs(options?: TripleStoreQueryOptions): Promise<string[]> {
    return this.callWithTimeout<string[]>(this.operationTimeoutMs, options?.signal, 'listGraphs');
  }
  async deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number> {
    return this.runTrackedWrite({ kind: 'graphs', graphs: [graphUri] }, () =>
      this.call<number>('deleteBySubjectPrefix', graphUri, prefix));
  }

  /** {@link GraphWriteGenSource} capability (#1609) — see graph-write-gen.ts. */
  getWriteGen(graphPrefix: string): number {
    return this.writeGen.getWriteGen(graphPrefix);
  }
  getWriteRevision(graphPrefix: string) {
    return this.writeGen.getWriteRevision(graphPrefix);
  }

  private async runTrackedWrite<T>(
    scope: GraphWriteScope,
    work: () => Promise<T>,
  ): Promise<T> {
    const lifecycle = this.writeGen.beginWrite(scope);
    try {
      return await work();
    } finally {
      // One worker message is transactional; a returned error means it settled
      // without a partial write, while success publishes the committed state.
      lifecycle.settle();
    }
  }
  async countQuads(graphUri?: string): Promise<number> { return this.call('countQuads', graphUri); }
  async flush(): Promise<void> { return this.call('flush'); }

  async close(): Promise<void> {
    // Memoized + serialized: every close() call shares ONE teardown promise, so
    // we issue exactly one close RPC. (A second unbounded close RPC would be
    // orphaned when terminate() kills the worker after the first resolves, and
    // — without the exit handler — would hang forever.)
    //
    // Flip the lifecycle to 'closing' FIRST (before awaiting anything), unless
    // the store already reached a terminal state on its own (gave_up /
    // in_memory_lost, or an even earlier close). Doing it synchronously here is
    // what lets an in-flight respawn see the close and bail (respawn() checks
    // isClosing) and what makes the worker's 'exit' handler treat this exit as
    // intentional. A store that already latched terminal is simply reaped below
    // — its state is permanent, so we must NOT try to move it to 'closing'.
    if (!this.closePromise) {
      if (!TERMINAL.has(this.lifecycle)) this.setLifecycle('closing');
      this.closePromise = this.doClose();
    }
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    // Worker already gone (crash/kill, respawn give-up, or in-memory loss) —
    // there's nothing to flush; just make sure the thread is reaped. Keeps
    // close() idempotent and non-throwing. Only settle into the terminal
    // 'closed' state when we're not already in a *different* terminal state
    // (gave_up / in_memory_lost stay as-is so their diagnostics survive).
    if (this.workerExited) {
      try { await this.worker.terminate(); } catch { /* already terminated */ }
      if (!TERMINAL.has(this.lifecycle)) this.setLifecycle('closed');
      return;
    }
    // `close` runs the worker's FINAL synchronous flush (insert() only schedules
    // a 50ms debounced flush, so close is what guarantees durability). It is
    // therefore EXEMPT from the per-op timeout (timeoutMs 0): bounding it could
    // fire the timeout while the worker is mid-flush, and the `finally` would
    // then terminate() the thread before pending writes hit disk — losing data.
    // terminate() always runs in `finally`; the worker's 'exit' handler then
    // rejects anything still pending, so nothing leaks or hangs.
    try {
      await this.callWithTimeout<void>(0, undefined, 'close');
    } finally {
      await this.worker.terminate();
      // The 'exit' handler above left us in 'closing' (intentional exit). Land
      // the terminal transition here so a post-close op fails fast (workerExited
      // is now set, and the guard reads 'closed' for the plain message).
      if (!TERMINAL.has(this.lifecycle)) this.setLifecycle('closed');
    }
  }
}

registerTripleStoreAdapter('oxigraph-worker', async (opts) => {
  const filePath = opts?.path as string | undefined;
  return new OxigraphWorkerStore(filePath, {
    operationTimeoutMs:
      typeof opts?.operationTimeoutMs === 'number' ? (opts.operationTimeoutMs as number) : undefined,
  });
});
