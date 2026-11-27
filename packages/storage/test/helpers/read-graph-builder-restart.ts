import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as forward } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { IDENTITY, expectEqualToMembers, expectSourcesKept, memberData, readGraphTriples } from './read-graph-builder-qualification.js';
import { killWriterOnLine } from './killed-writer-process.js';
import { layerFixture } from './read-graph-layer-conformance.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const WRITER = fileURLToPath(new URL('./read-graph-builder-kill-writer.ts', import.meta.url));

/**
 * Where the builder process dies: `delayMs` after copy batch `batch` returned to it, after the
 * builder flushed the store to its file following that batch, or after the store received and
 * answered that batch while the answer is kept from the builder.
 */
export interface BuilderKillPoint {
  readonly batch: number;
  readonly after: 'receipt' | 'return' | 'flush';
  readonly delayMs: number;
}

/** A proxy holding back the store's answer to one copy batch. */
export interface CopyBatchProxy {
  /** The SPARQL endpoint to give the builder: the store's own path, on the proxy. */
  readonly url: string;
  /** Resolves with the store's status once the store has answered the held copy batch. */
  readonly received: Promise<number>;
  close(): Promise<void>;
}

/**
 * A forwarding proxy in front of a Blazegraph SPARQL endpoint. It passes every request and answer
 * through, except copy batch `batch`, the `batch`-th SPARQL update naming member graphs in a VALUES
 * list (the batches the builder process numbers): that one it sends to the store whole, and it never
 * passes the store's answer on. A copy batch that is never sent leaves `received` pending.
 */
export async function holdCopyBatch(endpoint: string, batch: number): Promise<CopyBatchProxy> {
  const store = new URL(endpoint);
  let copies = 0;
  let resolveReceived!: (status: number) => void;
  let rejectReceived!: (error: unknown) => void;
  const received = new Promise<number>((resolve, reject) => { resolveReceived = resolve; rejectReceived = reject; });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const copyBatch = String(req.headers['content-type'] ?? '').startsWith('application/sparql-update') && body.includes('VALUES ?g');
      if (copyBatch) copies += 1;
      const held = copyBatch && copies === batch;
      const upstream = forward({
        host: store.hostname, port: store.port, path: req.url, method: req.method, headers: { ...req.headers, host: store.host },
      }, (answer) => {
        if (held) {
          answer.resume();
          answer.on('end', () => resolveReceived(answer.statusCode ?? 0));
          return;
        }
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      upstream.on('error', (error) => {
        if (held) rejectReceived(error);
        else if (!res.headersSent) { res.writeHead(502); res.end(String(error)); } else res.destroy(error);
      });
      upstream.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${store.pathname}${store.search}`,
    received,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/**
 * Run the builder process up to `point` and kill it with SIGKILL. It sends no copy batch after
 * `point.batch`. A `receipt` point is armed by `received` alone, never by a line the builder prints.
 * Resolves with whether that batch had returned to the builder when the process died, and the member
 * graphs of every copy batch it sent.
 */
async function killBuilderAt(
  env: Readonly<Record<string, string>>,
  point: BuilderKillPoint,
  received?: Promise<number>,
): Promise<{ readonly returned: boolean; readonly copied: readonly string[] }> {
  if ((point.after === 'receipt') !== (received !== undefined)) throw new Error('A receipt kill point needs the store\'s receipt, and only it does');
  const child = spawn(process.execPath, ['--import', 'tsx', WRITER], {
    cwd: REPO,
    env: { ...process.env, ...env, DKG_KILL_BATCHES: String(point.batch), DKG_KILL_FLUSH: point.after === 'flush' ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const arming = point.after === 'return' ? `returned ${point.batch}` : point.after === 'flush' ? `flushed ${point.batch}` : undefined;
  const lines = await killWriterOnLine(child, line => line === arming, point.delayMs, 'The builder', received);
  if (lines.includes('finished')) throw new Error(`The build finished before copy batch ${point.batch}: the fixture needs more member graphs`);
  const batches = lines.filter(line => line.startsWith('batch ')).map(line => line.split(' '));
  expect(batches.map(([, n]) => Number(n)), 'the copy batches the builder sent').toEqual(Array.from({ length: point.batch }, (_, i) => i + 1));
  return { returned: lines.includes(`returned ${point.batch}`), copied: batches.flatMap(([, , ...graphs]) => graphs) };
}

/**
 * Kill points for each engine. Blazegraph applies each request as it arrives: once a copy batch has
 * returned, and once the store has received and answered one whose answer a proxy keeps from the
 * builder. Embedded Oxigraph applies a batch in memory at once and writes its file a moment later:
 * once the builder's explicit flush has written the file, and right after a batch returned, before
 * the file need hold it.
 */
export const BUILDER_KILL_POINTS: Readonly<Record<'oxigraph' | 'blazegraph', readonly BuilderKillPoint[]>> = {
  blazegraph: [{ batch: 2, after: 'return', delayMs: 0 }, { batch: 3, after: 'receipt', delayMs: 0 }],
  oxigraph: [{ batch: 2, after: 'flush', delayMs: 0 }, { batch: 3, after: 'return', delayMs: 0 }],
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
    const handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>>[number][] = [];
    const run = `restart${randomUUID().slice(0, 8)}`;
    let sequence = 0;

    beforeAll(() => {
      if (backend !== 'blazegraph') return;
      if (!process.env.BLAZEGRAPH_TEST_URL) throw new Error('The live Blazegraph lane requires BLAZEGRAPH_TEST_URL');
      manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(process.env.BLAZEGRAPH_TEST_URL) });
    });
    afterAll(async () => {
      if (manager && handles.length > 0) await manager.disposeAll(handles);
    }, 60_000);

    /**
     * A Blazegraph namespace for one case. This process opens the store again after each kill, and a process starts a
     * backend's read graphs once (`startReadGraphs`). So each case needs a backend this process has not started yet,
     * as after a real restart; the embedded cases get one from their own file.
     */
    const freshNamespace = async (): Promise<string> => {
      const [handle] = await manager!.acquireMany([`read-graph-builder-restart-${randomUUID()}`]);
      handles.push(handle!);
      return handle!.sparqlUrl;
    };

    it.each(BUILDER_KILL_POINTS[backend])('rebuilds to its members after a builder killed at the $after of copy batch $batch, +$delayMs ms', async (point) => {
      // Only Blazegraph has a request in flight: the builder reaches it through a proxy that keeps the answer to the batch.
      if (point.after === 'receipt' && backend !== 'blazegraph') throw new Error('An embedded store has no request in flight to hold');
      const fixture = layerFixture(`${run}-${sequence += 1}`);
      const url = backend === 'blazegraph' ? await freshNamespace() : undefined;
      const dir = backend === 'oxigraph' ? await mkdtemp(join(tmpdir(), 'read-graph-restart-')) : undefined;
      const path = dir ? join(dir, 'store.nq') : undefined;
      const openAdapter = (): TripleStore => (path ? new OxigraphStore(path) : new BlazegraphStore(url!, { timeout: 120_000 }));
      const config: TripleStoreConfig = path ? { backend: 'oxigraph-persistent', options: { path } } : { backend: 'blazegraph', options: { url } };
      const proxy = point.after === 'receipt' ? await holdCopyBatch(url!, point.batch) : undefined;
      try {
        const seeded = [...fixture.facts, ...memberData(fixture)];
        const seeding = openAdapter();
        await seeding.insert(seeded);
        await seeding.close();
        const killed = await killBuilderAt(path
          ? { DKG_KILL_BACKEND: 'oxigraph', DKG_KILL_PATH: path, DKG_KILL_CG: fixture.contextGraphId }
          : { DKG_KILL_BACKEND: 'blazegraph', DKG_KILL_URL: proxy?.url ?? url!, DKG_KILL_CG: fixture.contextGraphId }, point, proxy?.received);
        if (proxy) {
          // The store received the whole copy batch and answered it, and the builder died before the answer reached it.
          expect(await proxy.received, 'the store\'s answer to the copy batch in flight').toBe(200);
          expect(killed.returned, 'the copy batch returned before the kill').toBe(false);
        }

        // The next process opens the same store: this one, which has not touched these read graphs.
        const adapter = openAdapter();
        const store = guardReadGraphPartition(wrapReadGraphLayer(adapter, { ...config, readGraphs: { workingMemoryIdentity: IDENTITY } }));
        const opened = { adapter, store, fixture };
        try {
          // The dead builder may leave its own state unfinished, but none of the sources it read.
          await expectSourcesKept(adapter, fixture, seeded, 'after the restart');
          const [vm] = fixture.keys as [ReadGraphKey];
          const { wholeVm } = fixture.readGraphs;
          const left = (await readStoredReadGraphRow(adapter, wholeVm)).row;
          // On Blazegraph every request the builder sent before the kill has its effect; the embedded store's file holds what was flushed.
          if (backend === 'blazegraph' || point.after === 'flush') {
            expect(left, 'the row the dead builder left').toMatchObject({ state: 'building' });
            // The partial read graph the store kept: exactly the member graphs of the batches the builder sent.
            expect(killed.copied, 'one member graph per copy batch').toHaveLength(point.batch);
            const copied = new Set(killed.copied);
            const partial = [...new Set(seeded.filter(quad => copied.has(quad.graph)).map(quad => `${quad.subject} ${quad.predicate} ${quad.object}`))].sort();
            expect(partial.length, 'the copied member graphs hold data').toBeGreaterThan(0);
            expect(await readGraphTriples(adapter, fixture, wholeVm), 'the read graph the dead builder left').toEqual(partial);
          }
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
          await expectSourcesKept(adapter, fixture, seeded, 'after the rebuild');
        } finally { await adapter.close(); }
      } finally {
        await proxy?.close();
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }, 180_000);
  });
}
