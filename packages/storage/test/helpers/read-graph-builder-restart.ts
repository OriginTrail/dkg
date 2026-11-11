import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReadGraphKey } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { OxigraphStore } from '../../src/adapters/oxigraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../../src/blazegraph-namespace-manager.js';
import { guardReadGraphPartition } from '../../src/read-graph-partition-store.js';
import { wrapReadGraphLayer } from '../../src/read-graph/read-graph-store.js';
import { buildReadGraph, readStoredReadGraphRow } from '../../src/read-graph/rebuild.js';
import { startReadGraphs } from '../../src/read-graph/startup.js';
import { readGraphBackfillBatch, readGraphFencedDrop } from '../../src/read-graph/statements.js';
import type { TripleStoreConfig } from '../../src/triple-store-composition.js';
import type { TripleStore } from '../../src/triple-store.js';
import { IDENTITY, expectEqualToMembers, memberData, readGraphTriples } from './read-graph-builder-qualification.js';
import { killWriterOnLine } from './killed-writer-process.js';
import { layerFixture } from './read-graph-layer-conformance.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const WRITER = fileURLToPath(new URL('./read-graph-builder-kill-writer.ts', import.meta.url));

/** Where the builder process dies: `delayMs` after copy batch `batch` went to the store, or after it returned. */
export interface BuilderKillPoint {
  readonly batch: number;
  readonly after: 'request' | 'return';
  readonly delayMs: number;
}

/**
 * Run the builder process up to `point` and kill it with SIGKILL. It sends no copy batch after
 * `point.batch`. Resolves with whether that batch had returned when the process died.
 */
async function killBuilderAt(env: Readonly<Record<string, string>>, point: BuilderKillPoint): Promise<{ readonly returned: boolean }> {
  const child = spawn(process.execPath, ['--import', 'tsx', WRITER], {
    cwd: REPO, env: { ...process.env, ...env, DKG_KILL_BATCHES: String(point.batch) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const arming = point.after === 'request' ? `batch ${point.batch}` : `returned ${point.batch}`;
  const lines = await killWriterOnLine(child, line => line === arming, point.delayMs, 'The builder');
  if (lines.includes('finished')) throw new Error(`The build finished before copy batch ${point.batch}: the fixture needs more member graphs`);
  expect(lines.filter(line => line.startsWith('batch ')).at(-1), 'the last copy batch the builder sent').toBe(`batch ${point.batch}`);
  return { returned: lines.includes(`returned ${point.batch}`) };
}

/**
 * Kill points for each engine. Blazegraph applies each request as it arrives: once a copy batch has
 * returned, and while one is with the store, where the kill must land before the store's answer.
 * Embedded Oxigraph applies a batch in memory at once and writes its file a moment later: once that
 * dump has caught up, and right after a batch returned, before it has.
 */
export const BUILDER_KILL_POINTS: Readonly<Record<'oxigraph' | 'blazegraph', readonly BuilderKillPoint[]>> = {
  blazegraph: [{ batch: 2, after: 'return', delayMs: 0 }, { batch: 3, after: 'request', delayMs: 0 }],
  oxigraph: [{ batch: 2, after: 'return', delayMs: 300 }, { batch: 3, after: 'return', delayMs: 0 }],
};

/**
 * A build across a restart, on one engine through its production adapter: a builder process dies in
 * the middle of a build, a new process starts the read graphs of the same store, a copy batch of the
 * dead process arrives after that start, and the new process rebuilds. The read graph ends equal to its
 * members, and the late batch changes nothing.
 */
export function readGraphBuilderRestartSuite(backend: 'oxigraph' | 'blazegraph') {
  describe(`a read-graph build across a restart (${backend})`, () => {
    let manager: BlazegraphNamespaceManager | undefined;
    let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> | undefined;
    let url: string | undefined;
    const run = `restart${randomUUID().slice(0, 8)}`;
    let sequence = 0;

    beforeAll(async () => {
      if (backend !== 'blazegraph') return;
      if (!process.env.BLAZEGRAPH_TEST_URL) throw new Error('The live Blazegraph lane requires BLAZEGRAPH_TEST_URL');
      manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(process.env.BLAZEGRAPH_TEST_URL) });
      handles = await manager.acquireMany([`read-graph-builder-restart-${randomUUID()}`]);
      url = handles[0]!.sparqlUrl;
    }, 60_000);
    afterAll(async () => {
      if (manager && handles) await manager.disposeAll(handles);
    }, 60_000);

    it.each(BUILDER_KILL_POINTS[backend])('rebuilds to its members after a builder killed $delayMs ms after the $after of copy batch $batch', async (point) => {
      const fixture = layerFixture(`${run}-${sequence += 1}`);
      const dir = backend === 'oxigraph' ? await mkdtemp(join(tmpdir(), 'read-graph-restart-')) : undefined;
      const path = dir ? join(dir, 'store.nq') : undefined;
      const openAdapter = (): TripleStore => (path ? new OxigraphStore(path) : new BlazegraphStore(url!, { timeout: 120_000 }));
      const config: TripleStoreConfig = path ? { backend: 'oxigraph-persistent', options: { path } } : { backend: 'blazegraph', options: { url } };
      try {
        const seeding = openAdapter();
        await seeding.insert([...fixture.facts, ...memberData(fixture)]);
        await seeding.close();
        const killed = await killBuilderAt(path
          ? { DKG_KILL_BACKEND: 'oxigraph', DKG_KILL_PATH: path, DKG_KILL_CG: fixture.contextGraphId }
          : { DKG_KILL_BACKEND: 'blazegraph', DKG_KILL_URL: url!, DKG_KILL_CG: fixture.contextGraphId }, point);
        // A kill timed from a request landed before the store answered it: the batch was interrupted, not finished.
        if (point.after === 'request') expect(killed.returned, 'the copy batch returned before the kill').toBe(false);

        // The next process opens the same store: this one, which has not touched these read graphs.
        const adapter = openAdapter();
        const store = guardReadGraphPartition(wrapReadGraphLayer(adapter, { ...config, readGraphs: { workingMemoryIdentity: IDENTITY } }));
        const opened = { adapter, store, fixture };
        try {
          const [vm] = fixture.keys as [ReadGraphKey];
          const { wholeVm } = fixture.readGraphs;
          const left = (await readStoredReadGraphRow(adapter, wholeVm)).row;
          // On Blazegraph every request the builder sent before the kill has its effect, and the embedded store has dumped its file 300 ms after a batch.
          if (backend === 'blazegraph' || point.delayMs >= 300) expect(left, 'the row the dead builder left').toMatchObject({ state: 'building' });
          await startReadGraphs(store, { maintains: (key) => key.scope.contextGraphId === fixture.contextGraphId });
          if (left) {
            // The start leaves a build it does not own dirty, at a newer generation, before anything else runs.
            const marked = (await readStoredReadGraphRow(adapter, wholeVm)).row;
            expect(marked).toMatchObject({ state: 'dirty' });
            expect(marked!.generation).toBeGreaterThan(left.generation);
            // A copy batch and a drop of the dead process arrive after the start: their fence no longer matches.
            const before = await readGraphTriples(adapter, fixture, wholeVm);
            await adapter.update!(readGraphBackfillBatch(wholeVm, left, [fixture.graphs[1]!, fixture.graphs[9]!]));
            await adapter.update!(readGraphFencedDrop(wholeVm, left));
            expect(await readGraphTriples(adapter, fixture, wholeVm), 'the late operations').toEqual(before);
          }
          expect(await buildReadGraph({ store, batching: { pauseRatio: 0 } }, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
          await expectEqualToMembers(opened, vm, fixture.registry, 'after the restart and the rebuild');
        } finally { await adapter.close(); }
      } finally { if (dir) await rm(dir, { recursive: true, force: true }); }
    }, 180_000);
  });
}
