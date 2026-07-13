import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineSuite } from 'esbench';
// Import the store classes + types from their SPECIFIC source modules rather
// than the storage barrel: the barrel also re-exports GraphManager /
// PrivateContentStore etc., which transitively import `@origintrail-official/
// dkg-core` — pulling that into the benchmark and requiring `dkg-core/dist` on a
// clean checkout. These adapter modules depend only on `oxigraph` + the local
// triple-store types, so the bench needs nothing beyond the storage build.
import { OxigraphStore } from '../packages/storage/src/adapters/oxigraph.ts';
import { OxigraphWorkerStore } from '../packages/storage/src/adapters/oxigraph-worker.ts';
import type { Quad, QueryResult } from '../packages/storage/src/triple-store.ts';
import { GET_TOTAL_TRIPLES_SPARQL, parseRdfInt } from '../packages/cli/src/daemon/metrics-queries.ts';
import { benchAsyncWithHooks } from './support/esbench-case-hooks.ts';

/**
 * Store read-latency benchmark — the signal behind the rc.13 → rc.14 perf
 * regression (issue #939) that the existing publish-async-get suite cannot see
 * (it runs against an in-memory mock client).
 *
 * It exercises the REAL Oxigraph triple store and measures the two read shapes
 * that hung on the live node when the daemon was saturated:
 *   - a trivial `LIMIT 1` scan (the UI's "is the store responsive?" probe), and
 *   - the production `getTotalTriples` `COUNT(*)` aggregate the 30s metrics
 *     collector runs (`packages/cli/src/daemon/lifecycle.ts`).
 *
 * Backends (env `DKG_BENCH_STORE_BACKENDS`, comma-separated):
 *   - `inprocess` — `OxigraphStore`, no build step required.
 *   - `worker` — `OxigraphWorkerStore`, the PRODUCTION backend; requires
 *     `pnpm --filter @origintrail-official/dkg-storage build` first (it spawns a
 *     compiled worker artefact).
 * Default: `inprocess`, plus `worker` automatically when its compiled artefact
 * is present (so a built tree / CI measures both; an unbuilt tree degrades to
 * `inprocess`-only instead of erroring).
 *
 * CONTENTION — the `(under write load)` cases — is measured ONLY on the `worker`
 * backend, by design. The production read-starvation is a property of the
 * single-writer oxigraph WORKER, whose message queue serialises a read behind
 * queued writes — exactly what an out-of-process MVCC server (#938) relieves.
 * The in-process `OxigraphStore` runs its insert/query work SYNCHRONOUSLY on one
 * thread, so a read and a write can never truly overlap; a same-thread "writer"
 * would only measure event-loop interleaving (not store contention) and could
 * report misleadingly idle reads. So `inprocess` runs the idle read-latency
 * baselines only.
 *
 * Store sizes via env `DKG_BENCH_STORE_SIZES` (default `1k,50k`).
 */

type Backend = 'inprocess' | 'worker';

interface ReadStore {
  insert(quads: Quad[]): Promise<void>;
  delete(quads: Quad[]): Promise<void>;
  query(sparql: string): Promise<QueryResult>;
  close(): Promise<void>;
}

const GRAPH = 'http://bench.dkg/g/store-read';
const READ_LIMIT1 = `SELECT ?s WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } } LIMIT 1`;
// The production `getTotalTriples` aggregate the 30s metrics collector runs —
// default graph UNION all named graphs. Imported from cli as the single source
// of truth so the benchmark can't silently drift from the real read path. The
// synthetic data lives in a named graph, so the `GRAPH ?g` branch carries the scan.
const READ_TOTAL_TRIPLES = GET_TOTAL_TRIPLES_SPARQL;

// Bounded write churn: the background writer repeatedly inserts then deletes a
// fixed batch in a region disjoint from the pre-populated base, so it generates
// sustained write work WITHOUT drifting the store size (which would otherwise
// confound the getTotalTriples-under-load measurement).
const CHURN_BATCH = 50;
const CHURN_OFFSET = 1_000_000_000;

const STORE_SIZES: Record<string, number> = { '1k': 1_000, '10k': 10_000, '50k': 50_000, '200k': 200_000 };
const INSERT_CHUNK = 1_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Result-shape guards so the benchmark FAILS (rather than reporting a healthy
// latency) if setup regressed and the store is empty or the read path changed.
function assertNonEmptySelect(result: QueryResult, label: string): void {
  if (result.type !== 'bindings' || result.bindings.length === 0) {
    throw new Error(`${label} returned no bindings — store empty or read path regressed`);
  }
}

function assertCountAtLeast(result: QueryResult, min: number, label: string): void {
  if (result.type !== 'bindings' || result.bindings.length === 0) {
    throw new Error(`${label} returned no count row — read path regressed`);
  }
  // Parse with the SAME helper the daemon's metrics collector uses, so the
  // benchmark can't disagree with production on a given response shape.
  const count = parseRdfInt(result.bindings[0]['c']);
  if (count < min) {
    throw new Error(`${label} count ${count} below expected minimum ${min} — store under-populated or read path regressed`);
  }
}

function makeQuads(count: number, offset: number): Quad[] {
  const quads: Quad[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const n = offset + i;
    quads[i] = {
      subject: `http://bench.dkg/s/${n}`,
      predicate: `http://bench.dkg/p/${n % 16}`,
      object: `"value-${n}"`,
      graph: GRAPH,
    };
  }
  return quads;
}

// The compiled worker artefact sits next to the storage dist build; its presence
// means the `worker` backend can be constructed without throwing.
function workerArtifactAvailable(): boolean {
  try {
    return existsSync(fileURLToPath(new URL('../packages/storage/dist/adapters/oxigraph-worker-impl.js', import.meta.url)));
  } catch {
    return false;
  }
}

function resolveBackends(): Backend[] {
  const raw = process.env.DKG_BENCH_STORE_BACKENDS?.trim();
  if (!raw) {
    if (workerArtifactAvailable()) return ['inprocess', 'worker'];
    // Loud, because the worker backend is the one this regression is about — a
    // silent inprocess-only run would look like it measured the production path.
    console.warn(
      '[store-read-latency] worker backend SKIPPED (compiled adapter missing) — ' +
        'measuring `inprocess` idle read latency ONLY, NOT the production write-contention path. ' +
        'Run `pnpm --filter @origintrail-official/dkg-storage build` (or `pnpm bench:store-read`, ' +
        'which builds it) to include the worker backend.',
    );
    return ['inprocess'];
  }
  const known = new Set<Backend>(['inprocess', 'worker']);
  const requested = raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (const b of requested) {
    if (!known.has(b as Backend)) {
      throw new Error(`Unknown DKG_BENCH_STORE_BACKENDS entry "${b}". Expected: inprocess, worker`);
    }
  }
  if (requested.includes('worker') && !workerArtifactAvailable()) {
    throw new Error(
      'DKG_BENCH_STORE_BACKENDS requested "worker", but the compiled adapter is missing. ' +
        'Run `pnpm --filter @origintrail-official/dkg-storage build` first.',
    );
  }
  return requested.length > 0 ? (requested as Backend[]) : ['inprocess'];
}

function resolveStoreSizeLabels(): string[] {
  const raw = process.env.DKG_BENCH_STORE_SIZES?.trim();
  const labels = raw ? raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean) : ['1k', '50k'];
  for (const label of labels) {
    if (!(label in STORE_SIZES)) {
      throw new Error(`Unknown DKG_BENCH_STORE_SIZES entry "${label}". Expected one of: ${Object.keys(STORE_SIZES).join(', ')}`);
    }
  }
  return labels;
}

function createStore(backend: Backend): ReadStore {
  // `worker` availability is gated in resolveBackends(), so by the time we get
  // here the compiled adapter is present.
  return backend === 'worker' ? new OxigraphWorkerStore() : new OxigraphStore();
}

export default defineSuite({
  params: {
    backend: resolveBackends(),
    storeSize: resolveStoreSizeLabels(),
  },
  baseline: {
    type: 'Name',
    value: 'read LIMIT 1 (idle)',
  },
  timing: {
    evaluateOverhead: false,
    iterations: 50,
    samples: 5,
    unrollFactor: 1,
    warmup: 1,
  },
  async setup(scene) {
    const backend = scene.params.backend as Backend;
    const sizeLabel = scene.params.storeSize as string;
    const quadCount = STORE_SIZES[sizeLabel];

    const store = createStore(backend);

    const churn = makeQuads(CHURN_BATCH, CHURN_OFFSET);
    let writerActive = false;
    let writerDone: Promise<void> | undefined;
    let writerError: unknown;

    const stopWriter = async (): Promise<void> => {
      if (!writerDone) return;
      writerActive = false;
      const done = writerDone;
      writerDone = undefined;
      // The loop captures its own failures into `writerError`, so this never rejects.
      await done;
      // Remove the churn batch so a half-applied cycle (an insert without its
      // matching delete) can't leak into the next iteration's getTotalTriples count.
      try {
        await store.delete(churn);
      } catch {
        /* store may be mid-teardown */
      }
      // Fail fast if the writer died: a stopped writer must never let an
      // `(under write load)` case record a successful (effectively idle) sample.
      if (writerError !== undefined) {
        const err = writerError;
        writerError = undefined;
        throw new Error(`background writer died during the under-load iteration: ${errorText(err)}`);
      }
    };

    // ONE ordered teardown for the scene: stop the writer and await its loop
    // BEFORE closing the store, so an in-flight insert/delete can never race a
    // closed store/worker. esbench may run scene teardown hooks concurrently, so
    // all ordering lives inside this single callback. Registered up-front so the
    // store is still closed (and any worker thread terminated) even if the
    // population below throws.
    scene.teardown(async () => {
      let stopErr: unknown;
      try {
        await stopWriter();
      } catch (err) {
        stopErr = err; // capture; still close the store below
      }
      // `close()` is the only place the worker thread is joined, so a failure
      // here is a real teardown bug — surface it (log + reject) rather than
      // swallow it and let a broken worker benchmark look green.
      try {
        await store.close();
      } catch (closeErr) {
        console.error(`[store-read-latency] store.close() failed (worker thread may not have joined): ${errorText(closeErr)}`);
        throw closeErr;
      }
      if (stopErr !== undefined) throw stopErr;
    });

    // Pre-populate the base graph the reads scan.
    for (let inserted = 0; inserted < quadCount; inserted += INSERT_CHUNK) {
      await store.insert(makeQuads(Math.min(INSERT_CHUNK, quadCount - inserted), inserted));
    }

    benchAsyncWithHooks(scene, 'read LIMIT 1 (idle)', async () => {
      assertNonEmptySelect(await store.query(READ_LIMIT1), 'read LIMIT 1');
    }, {});

    benchAsyncWithHooks(scene, 'read getTotalTriples (idle)', async () => {
      assertCountAtLeast(await store.query(READ_TOTAL_TRIPLES), quadCount, 'read getTotalTriples');
    }, {});

    // Contention is meaningful only on the worker backend (see file docstring):
    // the in-process store is single-threaded + synchronous, so reads and writes
    // cannot truly overlap. Skip the `(under write load)` cases for it rather
    // than report a misleading same-thread number.
    if (backend !== 'worker') return;

    // Background writer for the worker-backend `(under write load)` cases,
    // scoped to each loaded iteration (not to case-execution order):
    //   - `beforeIteration` (startWriter) AWAITS one full insert/delete cycle so
    //     writes are provably queued in the worker before the measured read.
    //   - a writer that dies is recorded in `writerError` and surfaced as a
    //     FAILED case — startWriter throws if it died before the first cycle,
    //     the workload throws if it died mid-measurement, and stopWriter throws
    //     if it died just after — so a broken writer can never silently degrade
    //     into an idle read.
    //   - `afterIteration` (stopWriter) stops it and clears the churn batch.
    const startWriter = async (): Promise<void> => {
      if (writerActive) return;
      writerActive = true;
      writerError = undefined;
      let signalFirstCycle!: () => void;
      const firstCycle = new Promise<void>((resolve) => { signalFirstCycle = resolve; });
      writerDone = (async () => {
        try {
          let signalled = false;
          while (writerActive) {
            await store.insert(churn);
            await store.delete(churn);
            if (!signalled) { signalled = true; signalFirstCycle(); }
          }
        } catch (err) {
          writerError = err;
        } finally {
          // Unblock the barrier even if the first cycle threw, so a writer
          // failure surfaces (below) instead of hanging the benchmark.
          signalFirstCycle();
        }
      })();
      await firstCycle;
      if (writerError !== undefined) {
        throw new Error(`background writer failed before its first write cycle: ${errorText(writerError)}`);
      }
    };

    benchAsyncWithHooks(scene, 'read LIMIT 1 (under write load)', async () => {
      assertNonEmptySelect(await store.query(READ_LIMIT1), 'read LIMIT 1');
      if (writerError !== undefined) {
        throw new Error(`background writer died during the measurement: ${errorText(writerError)}`);
      }
    }, { beforeIteration: startWriter, afterIteration: stopWriter });

    benchAsyncWithHooks(scene, 'read getTotalTriples (under write load)', async () => {
      assertCountAtLeast(await store.query(READ_TOTAL_TRIPLES), quadCount, 'read getTotalTriples');
      if (writerError !== undefined) {
        throw new Error(`background writer died during the measurement: ${errorText(writerError)}`);
      }
    }, { beforeIteration: startWriter, afterIteration: stopWriter });
  },
});
