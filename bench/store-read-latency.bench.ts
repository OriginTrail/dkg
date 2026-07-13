import { defineSuite } from 'esbench';
// Import the store classes + types from their SPECIFIC source modules rather
// than the storage barrel: the barrel also re-exports GraphManager /
// PrivateContentStore etc., which transitively import `@origintrail-official/
// dkg-core` — pulling that into the benchmark and requiring `dkg-core/dist` on a
// clean checkout. These adapter modules depend only on `oxigraph` + the local
// triple-store types, so the bench needs nothing beyond the storage build.
import { OxigraphStore } from '../packages/storage/src/adapters/oxigraph.ts';
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
 * Store sizes via env `DKG_BENCH_STORE_SIZES` (default `1k,50k`).
 */

interface ReadStore {
  insert(quads: Quad[]): Promise<void>;
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

export default defineSuite({
  params: {
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
    const sizeLabel = scene.params.storeSize as string;
    const quadCount = STORE_SIZES[sizeLabel];

    const store: ReadStore = new OxigraphStore();

    // Registered up-front so the store is still closed even if population or a
    // benchmark case throws.
    scene.teardown(async () => {
      try {
        await store.close();
      } catch (closeErr) {
        console.error(`[store-read-latency] store.close() failed: ${errorText(closeErr)}`);
        throw closeErr;
      }
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
  },
});
