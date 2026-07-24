/**
 * Sync-ingest oversize-literal guard (OT-RFC-56) — the 2026-07-08 mainnet
 * poison-literal retry storm.
 *
 * The load-bearing property: a synced page containing an oversized literal
 * must CONVERGE (conforming quads stored, offenders tombstoned, offset
 * checkpoint advanced/deleted) instead of throwing inside the per-CG sync
 * loop before the checkpoint moves — which re-fetched the identical page
 * from every peer forever. The regression test drives the REAL
 * `runDurableSync` both ways: pre-fix behavior (raw throwing storeInsert →
 * checkpoint stuck) is asserted as the disease, guard-wired behavior as the
 * cure.
 */
import { describe, it, expect } from 'vitest';
import {
  createOperationContext,
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  JAVA_WRITE_UTF_MAX_BYTES,
  OversizedRdfLiteralError,
  assertQuadLiteralsMutf8Safe,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  estimateSyncStoreInsertQuadBytes,
  filterOversizedSyncQuads,
  insertWithOversizeGuard,
  splitStoreRejectedQuads,
  SYNC_STORE_INSERT_BATCH_MAX_BYTES,
  type OversizeDrop,
} from '../src/sync/oversize-filter.js';
import { OversizeTombstoneLog } from '../src/sync/oversize-tombstones.js';
import { runOversizeSweep } from '../src/sync/oversize-sweep.js';
import { isSyncPermanentRejection, isSyncBackoffWorthyError } from '../src/sync/error-tags.js';
import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const CG = 'did:dkg:context-graph:agents';
const DATA_GRAPH = `${CG}`;
const SWM_GRAPH = `${CG}/_shared_memory/0xabc`;
const VM_GRAPH = `${CG}/_verifiable_memory/0xabc/1`;

const lit = (bytes: number) => `"${'x'.repeat(bytes)}"`; // ASCII ⇒ 1 MUTF-8 byte per char
const quad = (object: string, graph = DATA_GRAPH, subject = 'http://ex.org/s'): Quad =>
  ({ subject, predicate: 'https://schema.org/description', object, graph }) as Quad;

describe('filterOversizedSyncQuads (protocol limit, 60,000)', () => {
  it('passes literals at the boundary and drops above it', () => {
    // rdfLiteralTermMutf8ByteLength measures the FULL serialized term
    // (including the surrounding quotes) — same semantics as the #1323
    // producer guards. 59,998 content chars + 2 quotes = exactly 60,000.
    const atLimit = quad(lit(DKG_RDF_LITERAL_SAFE_MUTF8_BYTES - 2));
    const over = quad(lit(DKG_RDF_LITERAL_SAFE_MUTF8_BYTES + 1));
    const r = filterOversizedSyncQuads([atLimit, over]);
    expect(r.kept).toEqual([atLimit]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.kind).toBe('oversize');
    expect(r.dropped[0]!.quad).toBe(over);
    expect(r.dropped[0]!.bytes).toBeGreaterThan(DKG_RDF_LITERAL_SAFE_MUTF8_BYTES);
  });

  it('never drops IRIs or blank-node objects (only literals are measured)', () => {
    const iri = quad(`<http://ex.org/${'y'.repeat(70_000)}>`);
    const r = filterOversizedSyncQuads([iri]);
    expect(r.kept).toEqual([iri]);
    expect(r.dropped).toEqual([]);
  });

  it('passes a real (small) externalLiteralRef placeholder term', () => {
    const ref = quad(`"sha256:${'a'.repeat(64)}"^^<http://dkg.io/ontology/externalLiteralRef>`);
    const r = filterOversizedSyncQuads([ref]);
    expect(r.kept).toEqual([ref]);
    expect(r.dropped).toEqual([]);
  });

  it('DROPS an oversized ref-datatype term (no datatype-suffix bypass — review finding)', () => {
    // A hostile peer attaches the ref datatype to a huge value; it must NOT be
    // exempted just because of the suffix.
    const fakeRef = quad(`"${'x'.repeat(70_000)}"^^<http://dkg.io/ontology/externalLiteralRef>`);
    const r = filterOversizedSyncQuads([fakeRef]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.kind).toBe('oversize');
  });

  it('exempts _shared_memory DATA graphs (bucket + per-KA), where large literals are legitimately blob-externalized', () => {
    const bucket = quad(lit(70_000), SWM_GRAPH);
    const perKa = quad(lit(70_000), `${CG}/_shared_memory/0xauthor/7`, 'http://ex.org/ka');
    const r = filterOversizedSyncQuads([bucket, perKa]);
    expect(r.kept).toEqual([bucket, perKa]);
    expect(r.dropped).toEqual([]);
  });

  it('does NOT exempt _shared_memory_meta (sibling segment, not blob-externalized — review finding)', () => {
    const bigMeta = quad(lit(70_000), `${CG}/_shared_memory_meta`);
    const r = filterOversizedSyncQuads([bigMeta]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.kind).toBe('oversize');
  });

  it('quarantines a _verifiable_memory graph ALL-OR-NOTHING (never a partial Merkle-committed graph)', () => {
    const vmBig = quad(lit(70_000), VM_GRAPH, 'http://ex.org/a');
    const vmSmall = quad(lit(10), VM_GRAPH, 'http://ex.org/b');
    const other = quad(lit(10), DATA_GRAPH);
    const r = filterOversizedSyncQuads([vmBig, vmSmall, other]);
    expect(r.kept).toEqual([other]);
    expect(r.dropped.map((d) => d.kind)).toEqual(['vm-quarantine', 'vm-quarantine']);
  });

  it('leaves a clean VM graph untouched', () => {
    const vmSmall = quad(lit(10), VM_GRAPH);
    const r = filterOversizedSyncQuads([vmSmall]);
    expect(r.kept).toEqual([vmSmall]);
    expect(r.dropped).toEqual([]);
  });
});

describe('splitStoreRejectedQuads (store hard limit, 65,535)', () => {
  it('keeps 60k–65,535 range literals (store can hold them) and drops only above the hard limit', () => {
    const between = quad(lit(61_000), SWM_GRAPH);
    const above = quad(lit(JAVA_WRITE_UTF_MAX_BYTES + 100), SWM_GRAPH);
    const r = splitStoreRejectedQuads([between, above]);
    expect(r.kept).toEqual([between]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.kind).toBe('store-reject');
  });
});

describe('insertWithOversizeGuard', () => {
  const collect = () => {
    const drops: Array<{ drop: OversizeDrop; seam: string }> = [];
    return {
      drops,
      hooks: { recordDrops: (ds: OversizeDrop[], seam: string) => ds.forEach((d) => drops.push({ drop: d, seam })) },
    };
  };

  it('inserts conforming quads, tombstones the oversized, returns what was inserted', async () => {
    const { drops, hooks } = collect();
    const inserted: Quad[][] = [];
    const good = quad(lit(10));
    const bad = quad(lit(70_000));
    const result = await insertWithOversizeGuard(async (q) => { inserted.push(q); }, [good, bad], hooks, 'test');
    expect(result).toEqual([good]);
    expect(inserted).toEqual([[good]]);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.seam).toBe('test');
  });

  it('BACKSTOP: a store OversizedRdfLiteralError splits at the hard limit, tombstones, retries once', async () => {
    // A 70k literal in an EXEMPT (_shared_memory) graph passes the pre-filter,
    // then a Blazegraph-like store throws. The guard must converge: drop it,
    // record store-reject, retry with the remainder.
    const { drops, hooks } = collect();
    const good = quad(lit(10), SWM_GRAPH);
    const bad = quad(lit(70_000), SWM_GRAPH);
    const batches: Quad[][] = [];
    const blazegraphLike = async (quads: Quad[]) => {
      batches.push(quads);
      assertQuadLiteralsMutf8Safe(quads, { maxBytes: JAVA_WRITE_UTF_MAX_BYTES, label: 'test.insert' });
    };
    const result = await insertWithOversizeGuard(blazegraphLike, [good, bad], hooks, 'swm-sync');
    expect(result).toEqual([good]);
    expect(batches).toHaveLength(2); // first attempt (throws), retry (succeeds)
    expect(drops).toHaveLength(1);
    expect(drops[0]!.drop.kind).toBe('store-reject');
    expect(drops[0]!.seam).toBe('swm-sync:store-reject');
  });

  it('propagates non-oversize store errors unchanged (never masks transient failures)', async () => {
    const { hooks } = collect();
    await expect(
      insertWithOversizeGuard(async () => { throw new Error('store connection refused'); }, [quad(lit(10))], hooks, 'test'),
    ).rejects.toThrow('store connection refused');
  });

  it('splits a large sync ingest into adapter-neutral byte-bounded inserts', async () => {
    const { hooks } = collect();
    const item = quad(lit(50_000), SWM_GRAPH);
    const input = Array.from({ length: 200 }, () => ({ ...item }));
    const batches: Quad[][] = [];

    const result = await insertWithOversizeGuard(
      async (batch) => { batches.push(batch); },
      input,
      hooks,
      'swm-sync',
    );

    expect(result).toHaveLength(input.length);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(input.length);
    for (const batch of batches) {
      const bytes = batch.reduce((sum, q) => sum + estimateSyncStoreInsertQuadBytes(q), 0);
      expect(bytes).toBeLessThanOrEqual(SYNC_STORE_INSERT_BATCH_MAX_BYTES);
    }
  });

  it('rethrows an oversize error the split cannot explain (real store bug, loud failure)', async () => {
    const { hooks } = collect();
    const smallButRejected = quad(lit(10));
    await expect(
      insertWithOversizeGuard(
        async () => { throw new OversizedRdfLiteralError({ actualBytes: 99, maxBytes: 1 }); },
        [smallButRejected],
        hooks,
        'test',
      ),
    ).rejects.toThrow(OversizedRdfLiteralError);
  });
});

describe('error-tags: permanent-rejection classification', () => {
  it('OversizedRdfLiteralError is permanent, and NOT backoff-worthy', () => {
    const err = new OversizedRdfLiteralError({ actualBytes: 70_000, maxBytes: 65_535 });
    expect(isSyncPermanentRejection(err)).toBe(true);
    expect(isSyncBackoffWorthyError(err)).toBe(false);
  });
  it('transient transport errors are not permanent', () => {
    expect(isSyncPermanentRejection(new Error('stream reset'))).toBe(false);
  });
});

describe('error-tags: retry classification', () => {
  it('treats typed exhausted chain RPC reads as backoff-worthy', () => {
    const error = Object.assign(new Error(
      'cgStorage.kaToContextGraph read failed on all configured RPC endpoints: '
      + 'RPC #3 timed out after 4000ms',
    ), { code: 'RPC_ENDPOINTS_EXHAUSTED' });
    expect(isSyncBackoffWorthyError(error)).toBe(true);
    expect(isSyncPermanentRejection(error)).toBe(false);
  });

  it('does not infer chain transport failure from message text alone', () => {
    const error = new Error('read failed on all configured RPC endpoints');
    expect(isSyncBackoffWorthyError(error)).toBe(false);
  });
});

describe('runDurableSync — the poison-page retry-loop regression', () => {
  const bad = quad(lit(120_000)); // the incident shape: a ~118KB agents-graph literal
  const goodA = quad(lit(10), DATA_GRAPH, 'http://ex.org/a');
  const goodB = quad(lit(10), DATA_GRAPH, 'http://ex.org/b');

  function makeContext(storeInsert: (quads: Quad[]) => Promise<void>) {
    const deletedCheckpoints: string[] = [];
    const setCheckpoints: Array<{ key: string; offset: number }> = [];
    const page = (phase: 'data' | 'meta'): SyncPageResult => ({
      quads: phase === 'data' ? [goodA, bad, goodB] : [],
      bytesReceived: 100,
      resumedFromOffset: 0,
      nextOffset: 3,
      checkpointKey: `cp|${phase}`,
      completed: true,
      timedOut: false,
    });
    return {
      deletedCheckpoints,
      setCheckpoints,
      context: {
        ctx: createOperationContext('sync'),
        remotePeerId: 'peerR',
        contextGraphIds: ['agents'],
        createContextGraphFetchDeadline: () => Date.now() + 10_000,
        createGraphScopedAuthenticationDeadline: () => Date.now() + 10_000,
        fetchSyncPages: async (_c: unknown, _p: string, _cg: string, _swm: boolean, phase: 'data' | 'meta') => page(phase),
        processDurableBatchInWorker: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
          verifiedData: dataQuads,
          verifiedMeta: metaQuads,
          totalFetchedDataQuads: dataQuads.length,
          totalFetchedMetaQuads: metaQuads.length,
          rejectedKcs: 0,
          emptyResponses: 0,
          metaOnlyResponses: 0,
          dataRejectedMissingMeta: 0,
        }),
        storeInsert,
        deleteCheckpoint: (key: string) => { deletedCheckpoints.push(key); },
        setCheckpoint: (key: string, offset: number) => { setCheckpoints.push({ key, offset }); },
        logInfo: () => {},
        logWarn: () => {},
        logDebug: () => {},
      },
    };
  }

  it('DISEASE (pre-fix): a raw throwing store leaves the checkpoint untouched — the page re-fetches forever', async () => {
    const throwing = async (quads: Quad[]) =>
      assertQuadLiteralsMutf8Safe(quads, { maxBytes: JAVA_WRITE_UTF_MAX_BYTES, label: 'blazegraph.insert' });
    const { context, deletedCheckpoints, setCheckpoints } = makeContext(throwing);
    const summary = await runDurableSync(context as never);
    expect(summary.failedPhases).toBe(1);
    // Neither advanced nor completed: the stuck-cursor loop.
    expect(deletedCheckpoints).toEqual([]);
    expect(setCheckpoints).toEqual([]);
  });

  it('CURE: the guard converges the page — conforming quads stored, offender tombstoned, checkpoints completed', async () => {
    const stored: Quad[][] = [];
    const tomb = new OversizeTombstoneLog({ logWarn: () => {} });
    const guarded = async (quads: Quad[]) => {
      await insertWithOversizeGuard(
        async (kept) => {
          assertQuadLiteralsMutf8Safe(kept, { maxBytes: JAVA_WRITE_UTF_MAX_BYTES, label: 'blazegraph.insert' });
          stored.push(kept);
        },
        quads,
        { recordDrops: (drops, seam) => tomb.record(drops, seam) },
        'durable-sync',
      );
    };
    const { context, deletedCheckpoints } = makeContext(guarded);
    const summary = await runDurableSync(context as never);
    expect(summary.failedPhases).toBe(0);
    expect(stored).toEqual([[goodA, goodB]]); // poison excluded, the rest converged
    expect(deletedCheckpoints).toEqual(expect.arrayContaining(['cp|meta', 'cp|data'])); // page consumed → no re-fetch
    expect(tomb.size).toBe(1);
    expect(tomb.list(10)[0]).toMatchObject({
      kind: 'oversize',
      seam: 'durable-sync',
      predicate: 'https://schema.org/description',
    });
  });
});

describe('production wiring — the real sync-ingest seam calls the guard', () => {
  // Falsification (review): the pure-filter regression above proves the helper
  // works, not that the production seam uses it. This drives the REAL
  // insertSyncedQuadsAndInvalidateListCache (durable-sync's storeInsert) on a
  // live agent + store. On oxigraph (no size limit) a removed guard would store
  // the oversized quad, so deleting the production call turns this red.
  it('insertSyncedQuadsAndInvalidateListCache drops+tombstones oversized, stores the rest, does not throw', async () => {
    const { DKGAgent } = await import('../src/index.js');
    const { NoChainAdapter } = await import('@origintrail-official/dkg-chain');
    const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'IngestWiringNode', listenPort: 0, listenHost: '127.0.0.1',
      store, chainAdapter: new NoChainAdapter(), nodeRole: 'core', skills: [],
    });
    try {
      const good = { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"small"', graph: 'http://ex.org/g' } as Quad;
      const poison = { subject: 'http://ex.org/s2', predicate: 'http://ex.org/p', object: `"${'x'.repeat(120_000)}"`, graph: 'http://ex.org/g' } as Quad;

      await expect((agent as any).insertSyncedQuadsAndInvalidateListCache([good, poison])).resolves.toBeUndefined();

      const r = await store.query('SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }');
      const subjects = r.type === 'bindings' ? r.bindings.map((b) => b.s) : [];
      expect(subjects).toContain('http://ex.org/s');       // conforming quad stored
      expect(subjects).not.toContain('http://ex.org/s2');  // poison NOT stored (guard dropped it pre-insert)
      expect((agent as any).oversizeTombstoneLog.size).toBeGreaterThan(0);
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});

describe('runOversizeSweep (boot-time resident-poison removal)', () => {
  const bigTerm = `"${'x'.repeat(120_000)}"`;
  const overSelectedButLegal = `"${'y'.repeat(25_000)}"`; // over-select, but 25,002 bytes < 60,000 → must survive
  const makeStore = (graphQuads: Record<string, Quad[]>) => {
    const deletions: Array<Partial<Quad>> = [];
    return {
      deletions,
      store: {
        listGraphs: async () => Object.keys(graphQuads),
        query: async (sparql: string) => {
          const g = /GRAPH <([^>]+)>/.exec(sparql);
          // Faithful STRLEN simulation: COUNT CODE POINTS (not UTF-16 units)
          // against the threshold the sweep actually put in the query, so an
          // astral literal is over-selected exactly as real oxigraph would.
          const thr = Number(/STRLEN\(STR\(\?o\)\) > (\d+)/.exec(sparql)?.[1] ?? '0');
          const quads = (graphQuads[g![1]!] ?? []).filter((q) => {
            const val = q.object.startsWith('"') ? q.object.slice(1, q.object.lastIndexOf('"')) : '';
            return [...val].length > thr;
          });
          return { type: 'quads', quads };
        },
        deleteByPattern: async (pattern: Partial<Quad>) => { deletions.push(pattern); return 1; },
      },
    };
  };
  const drops: Array<{ seam: string; kind: string }> = [];
  const hooks = {
    recordDrops: (ds: OversizeDrop[], seam: string) => ds.forEach((d) => drops.push({ seam, kind: d.kind })),
    logInfo: () => {},
    logWarn: () => {},
  };

  it('removes exact offenders only, skips exempt graphs, writes the marker, and no-ops on the second run', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dataDir = await mkdtemp(`${tmpdir()}/oversweep-`);
    drops.length = 0;
    const { store, deletions } = makeStore({
      [DATA_GRAPH]: [quad(bigTerm), quad(overSelectedButLegal, DATA_GRAPH, 'http://ex.org/legal')],
      [SWM_GRAPH]: [quad(bigTerm, SWM_GRAPH)],
      [VM_GRAPH]: [quad(bigTerm, VM_GRAPH)],
    });

    const first = await runOversizeSweep({ store, dataDir, ...hooks });
    expect(first.ran).toBe(true);
    expect(first.sweptQuads).toBe(1); // only the true offender in the mutable data graph
    expect(deletions).toHaveLength(1);
    expect(deletions[0]).toMatchObject({ graph: DATA_GRAPH, object: bigTerm });
    expect(first.scannedGraphs).toBe(1); // SWM + VM graphs never scanned
    expect(drops).toEqual([{ seam: 'sweep', kind: 'oversize' }]);

    const second = await runOversizeSweep({ store, dataDir, ...hooks });
    expect(second.ran).toBe(false); // marker gates the re-run
    expect(deletions).toHaveLength(1);
  });

  it('catches ASTRAL-only oversized poison the 19k threshold would have missed (review finding)', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dataDir = await mkdtemp(`${tmpdir()}/oversweep-astral-`);
    drops.length = 0;
    // 11,000 × 😀 = 11,000 code points (STRLEN) but 66,000 MUTF-8 bytes: an
    // offender that STRLEN>19,000 would skip. The 9,000 threshold over-selects
    // it, and the exact byte-verify confirms + deletes it.
    const astral = `"${'😀'.repeat(11_000)}"`;
    const { store, deletions } = makeStore({ [DATA_GRAPH]: [quad(astral)] });
    const r = await runOversizeSweep({ store, dataDir, ...hooks });
    expect(r.sweptQuads).toBe(1);
    expect(deletions).toHaveLength(1);
    expect(deletions[0]).toMatchObject({ graph: DATA_GRAPH, object: astral });
  });

  it('SWEEPS _shared_memory_meta (mutable, not blob-externalized) but skips SWM data + VM', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dataDir = await mkdtemp(`${tmpdir()}/oversweep-meta-`);
    drops.length = 0;
    const metaGraph = `${CG}/_shared_memory_meta`;
    const { store, deletions } = makeStore({
      [metaGraph]: [quad(bigTerm, metaGraph)],
      [SWM_GRAPH]: [quad(bigTerm, SWM_GRAPH)],
      [VM_GRAPH]: [quad(bigTerm, VM_GRAPH)],
    });
    const r = await runOversizeSweep({ store, dataDir, ...hooks });
    expect(r.scannedGraphs).toBe(1);   // only _shared_memory_meta scanned
    expect(r.sweptQuads).toBe(1);
    expect(deletions[0]).toMatchObject({ graph: metaGraph });
  });

  it('skips entirely without a dataDir (in-memory store)', async () => {
    const { store, deletions } = makeStore({ [DATA_GRAPH]: [quad(bigTerm)] });
    const r = await runOversizeSweep({ store, dataDir: undefined, ...hooks });
    expect(r.ran).toBe(false);
    expect(deletions).toEqual([]);
  });

  it('does NOT write the marker on failure — retries next boot', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dataDir = await mkdtemp(`${tmpdir()}/oversweep-fail-`);
    const failing = {
      listGraphs: async () => [DATA_GRAPH],
      query: async () => { throw new Error('store exploded'); },
      deleteByPattern: async () => 1,
    };
    const r1 = await runOversizeSweep({ store: failing, dataDir, ...hooks });
    expect(r1.ran).toBe(true);
    expect(r1.sweptQuads).toBe(0);
    // Marker absent → a healthy second run still executes.
    const { store, deletions } = makeStore({ [DATA_GRAPH]: [quad(bigTerm)] });
    const r2 = await runOversizeSweep({ store, dataDir, ...hooks });
    expect(r2.ran).toBe(true);
    expect(deletions).toHaveLength(1);
  });
});
