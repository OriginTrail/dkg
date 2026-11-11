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
import { layerFixture } from './read-graph-layer-conformance.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const WRITER = fileURLToPath(new URL('./read-graph-builder-kill-writer.ts', import.meta.url));

/** Where the builder process dies: `delayMs` after copy batch `batch` went to the store, or after it returned. */
export interface BuilderKillPoint {
  readonly batch: number;
  readonly after: 'request' | 'return';
  readonly delayMs: number;
}

/** Run the builder process up to `point` and kill it with SIGKILL. It sends no copy batch after `point.batch`. */
async function killBuilderAt(env: Readonly<Record<string, string>>, point: BuilderKillPoint): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', WRITER], {
    cwd: REPO, env: { ...process.env, ...env, DKG_KILL_BATCHES: String(point.batch) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const arming = point.after === 'request' ? `batch ${point.batch}` : `returned ${point.batch}`;
  let output = '';
  let stderr = '';
  let killed = false;
  let finished = false;
  let timedOut = false;
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    for (let end = output.indexOf('\n'); end >= 0; end = output.indexOf('\n')) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      if (line === 'finished') finished = true;
      if (!killed && line === arming) {
        killed = true;
        setTimeout(() => child.kill('SIGKILL'), point.delayMs);
      }
    }
  });
  try {
    const { code, signal } = await exited;
    if (timedOut) throw new Error(`The builder did not reach copy batch ${point.batch} within 120 s: ${stderr}`);
    if (finished) throw new Error(`The build finished before copy batch ${point.batch}: the fixture needs more member graphs`);
    if (signal !== 'SIGKILL' || !killed) throw new Error(`The builder stopped by itself (code ${code}, signal ${signal}): ${stderr}`);
  } finally { clearTimeout(deadline); }
}

/** Kill points: once a copy batch has returned, and while one is with the store. */
export const BUILDER_KILL_POINTS: readonly BuilderKillPoint[] = [
  { batch: 2, after: 'return', delayMs: 300 },
  { batch: 3, after: 'request', delayMs: 0 },
];

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

    it.each(BUILDER_KILL_POINTS)('rebuilds to its members after a builder killed $delayMs ms after the $after of copy batch $batch', async (point) => {
      const fixture = layerFixture(`${run}-${sequence += 1}`);
      const dir = backend === 'oxigraph' ? await mkdtemp(join(tmpdir(), 'read-graph-restart-')) : undefined;
      const path = dir ? join(dir, 'store.nq') : undefined;
      const openAdapter = (): TripleStore => (path ? new OxigraphStore(path) : new BlazegraphStore(url!, { timeout: 120_000 }));
      const config: TripleStoreConfig = path ? { backend: 'oxigraph-persistent', options: { path } } : { backend: 'blazegraph', options: { url } };
      try {
        const seeding = openAdapter();
        await seeding.insert([...fixture.facts, ...memberData(fixture)]);
        await seeding.close();
        await killBuilderAt(path
          ? { DKG_KILL_BACKEND: 'oxigraph', DKG_KILL_PATH: path, DKG_KILL_CG: fixture.contextGraphId }
          : { DKG_KILL_BACKEND: 'blazegraph', DKG_KILL_URL: url!, DKG_KILL_CG: fixture.contextGraphId }, point);

        // The next process opens the same store: this one, which has not touched these read graphs.
        const adapter = openAdapter();
        const store = guardReadGraphPartition(wrapReadGraphLayer(adapter, { ...config, readGraphs: { workingMemoryIdentity: IDENTITY } }));
        const opened = { adapter, store, fixture };
        try {
          const [vm] = fixture.keys as [ReadGraphKey];
          const { wholeVm } = fixture.readGraphs;
          const left = (await readStoredReadGraphRow(adapter, wholeVm)).row;
          if (backend === 'blazegraph' || point.after === 'return') expect(left, 'the row the dead builder left').toMatchObject({ state: 'building' });
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
