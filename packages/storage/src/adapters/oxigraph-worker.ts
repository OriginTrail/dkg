import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TripleStore, Quad, QueryResult } from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';

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
 */
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;

/**
 * Default chunk size for `insert` — **disabled (0) by default; opt-in**.
 *
 * A large insert posted as ONE worker message holds the single worker thread
 * for its entire duration, head-of-line-blocking every other store op. Setting
 * `insertChunkSize > 0` splits a large insert into sequential worker messages,
 * yielding the worker between chunks so concurrent reads/writes are serviced
 * within ~one chunk instead of waiting for the whole import.
 *
 * The trade-off (why this is OPT-IN rather than on by default): chunking turns
 * one insert into several transactions, so the adapter's "all quads commit, or
 * the call fails" contract weakens to "quads commit a chunk at a time". A
 * concurrent reader can observe a partial graph mid-insert, and a chunk that
 * times out/errors leaves earlier chunks already visible with no rollback.
 * That's only safe for **idempotent bulk-import paths** (re-inserting a quad is
 * a no-op, so a retry converges). To keep the atomic contract for everyone
 * else, default off; operators with heavy idempotent imports opt in via
 * `store.options.insertChunkSize`.
 */
const DEFAULT_INSERT_CHUNK_SIZE = 0;

export interface OxigraphWorkerStoreOptions {
  /** Per-operation timeout in milliseconds. Default 120_000. 0 disables it. */
  operationTimeoutMs?: number;
  /**
   * Max quads per worker insert message. Default 0 = disabled (inserts stay a
   * single atomic message). Set > 0 to chunk large inserts for head-of-line
   * fairness — only on idempotent bulk-import paths (see note above; chunking
   * trades atomic visibility for fairness).
   */
  insertChunkSize?: number;
}

/**
 * Accept only finite, non-negative overrides; otherwise fall back. The result
 * is floored to an INTEGER: both knobs are integer quantities (ms for the
 * timeout, a quad count for the chunk size). A fractional `insertChunkSize`
 * (e.g. `1.5`) would otherwise desync the `i += size` loop counter from
 * `slice()`'s integer-coerced boundaries and yield malformed chunks.
 */
function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Methods that change persisted state. A per-op timeout only drops the CALLER's
 * promise — the single worker thread keeps running the op — so a timed-out
 * MUTATION may STILL commit after we've already rejected. We surface that as an
 * explicit "outcome unknown" signal (see OxigraphWorkerTimeoutError) so callers
 * don't treat it as a clean failure (e.g. report "failed" while the write
 * actually landed, or blindly retry a non-idempotent op). Reads are
 * side-effect-free, so a read timeout is an ordinary, determinate failure.
 */
const MUTATING_METHODS = new Set<string>([
  'insert', 'delete', 'deleteByPattern', 'dropGraph', 'deleteBySubjectPrefix', 'flush',
]);

/** Rejection raised when a worker op exceeds its per-op timeout. */
export interface OxigraphWorkerTimeoutError extends Error {
  code: 'OXIGRAPH_WORKER_OP_TIMEOUT';
  /** Which store method timed out. */
  method: string;
  /** The bound that was exceeded. */
  timeoutMs: number;
  /**
   * True when the timed-out op was a mutation: the worker may still apply it,
   * so the persisted outcome is indeterminate. False for side-effect-free reads.
   */
  outcomeUnknown: boolean;
}

export class OxigraphWorkerStore implements TripleStore {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly operationTimeoutMs: number;
  private readonly insertChunkSize: number;

  constructor(persistPath?: string, opts?: OxigraphWorkerStoreOptions) {
    this.operationTimeoutMs = normalizeNonNegativeInt(opts?.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
    this.insertChunkSize = normalizeNonNegativeInt(opts?.insertChunkSize, DEFAULT_INSERT_CHUNK_SIZE);

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
    this.worker = new Worker(workerPath, {
      workerData: { persistPath },
    });
    this.worker.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
    this.worker.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.callWithTimeout<T>(this.operationTimeoutMs, method, ...args);
  }

  /**
   * Post one op to the worker and await its reply, bounding the caller's wait by
   * `timeoutMs` (0 = wait indefinitely). The bound is per-CALLER: on timeout we
   * reject and drop the pending entry, but the single-threaded worker is STILL
   * running the op — the late reply is then ignored (the message handler no-ops
   * on a missing id) rather than double-settling this promise.
   */
  private callWithTimeout<T>(timeoutMs: number, method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            const outcomeUnknown = MUTATING_METHODS.has(method);
            const err = new Error(
              `oxigraph-worker: "${method}" timed out after ${timeoutMs}ms. ` +
              (outcomeUnknown
                ? `This is a MUTATION whose outcome is INDETERMINATE: the single worker ` +
                  `thread is still running it, so the change may STILL commit after this ` +
                  `rejection. Treat it as "outcome unknown", not a clean failure — only ` +
                  `retry if the operation is idempotent (DKG insert/delete are). `
                : ``) +
              `The embedded store runs on a single worker thread, so a long-running or ` +
              `stuck operation blocks all others. For heavy workloads point the node at ` +
              `an external SPARQL server (store.backend "sparql-http" / "blazegraph"), or ` +
              `raise / disable store.options.operationTimeoutMs.`,
            ) as OxigraphWorkerTimeoutError;
            err.code = 'OXIGRAPH_WORKER_OP_TIMEOUT';
            err.method = method;
            err.timeoutMs = timeoutMs;
            err.outcomeUnknown = outcomeUnknown;
            reject(err);
          }
        }, timeoutMs);
        // A pending-op timer must not keep the process alive on its own.
        if (typeof timer.unref === 'function') timer.unref();
      }
      this.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v as T); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      this.worker.postMessage({ id, method, args });
    });
  }

  async insert(quads: Quad[]): Promise<void> {
    const size = this.insertChunkSize;
    // Default path (chunking disabled, or insert fits in one chunk): a SINGLE
    // atomic worker message — all quads commit together or the call fails.
    if (size <= 0 || quads.length <= size) {
      return this.call('insert', quads);
    }
    // Opt-in chunked path (insertChunkSize > 0). Sequential awaits create yield
    // points between chunks so store ops requested mid-import are serviced
    // BETWEEN chunks instead of waiting for the whole insert (head-of-line
    // relief). Each chunk is independently bounded by the per-op timeout.
    //
    // CAVEAT — this is NOT atomic: a concurrent reader can see a partial graph
    // mid-insert, and if a chunk times out/errors the earlier chunks are
    // already committed with no rollback (the caller only sees a rejected
    // promise). Only enable on idempotent bulk-import paths where re-inserting
    // a quad is a no-op, so an interrupted insert converges on retry. See the
    // DEFAULT_INSERT_CHUNK_SIZE note for the full rationale.
    for (let i = 0; i < quads.length; i += size) {
      await this.call('insert', quads.slice(i, i + size));
    }
  }
  async delete(quads: Quad[]): Promise<void> { return this.call('delete', quads); }
  async deleteByPattern(pattern: Partial<Quad>): Promise<number> { return this.call('deleteByPattern', pattern); }
  async query(sparql: string): Promise<QueryResult> { return this.call('query', sparql); }
  async hasGraph(graphUri: string): Promise<boolean> { return this.call('hasGraph', graphUri); }
  async createGraph(graphUri: string): Promise<void> { return this.call('createGraph', graphUri); }
  async dropGraph(graphUri: string): Promise<void> { return this.call('dropGraph', graphUri); }
  async listGraphs(): Promise<string[]> { return this.call('listGraphs'); }
  async deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number> { return this.call('deleteBySubjectPrefix', graphUri, prefix); }
  async countQuads(graphUri?: string): Promise<number> { return this.call('countQuads', graphUri); }
  async flush(): Promise<void> { return this.call('flush'); }

  async close(): Promise<void> {
    // `close` runs the worker's FINAL synchronous flush (insert() only schedules
    // a 50ms debounced flush, so close is what guarantees durability). It is
    // therefore EXEMPT from the per-op timeout (timeoutMs 0): bounding it could
    // fire the timeout while the worker is mid-flush, and the `finally` would
    // then terminate() the thread before pending writes hit disk — losing data.
    // We still terminate() in `finally`, so a worker that errors/closes cleanly
    // never leaks its thread; a graceful close simply runs to completion first.
    try {
      await this.callWithTimeout<void>(0, 'close');
    } finally {
      await this.worker.terminate();
    }
  }
}

registerTripleStoreAdapter('oxigraph-worker', async (opts) => {
  const filePath = opts?.path as string | undefined;
  return new OxigraphWorkerStore(filePath, {
    operationTimeoutMs:
      typeof opts?.operationTimeoutMs === 'number' ? (opts.operationTimeoutMs as number) : undefined,
    insertChunkSize:
      typeof opts?.insertChunkSize === 'number' ? (opts.insertChunkSize as number) : undefined,
  });
});
