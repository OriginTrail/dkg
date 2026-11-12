// A read-graph build on the file-backed embedded store: its copy batches skip the store's whole-store
// snapshot, so the build does not rewrite the file once per batch; the job's own row changes still
// schedule one, and the file holds the whole read graph once the build is done.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { guardReadGraphPartition } from '../src/read-graph-partition-store.js';
import { wrapReadGraphLayer } from '../src/read-graph/read-graph-store.js';
import { buildReadGraph } from '../src/read-graph/rebuild.js';
import type { Quad, UpdateOptions } from '../src/triple-store.js';

const CONTEXT_GRAPH = '0x00000000000000000000000000000000000000aa/snapshots';
const KEY: ReadGraphKey = { scope: readScope(CONTEXT_GRAPH), layer: MemoryLayer.VerifiableMemory };
const ASSETS = 24;
const asset = (i: number) => `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/0x${'b'.repeat(40)}/${i}`;
const SEED: Quad[] = Array.from({ length: ASSETS }, (_, i) => [0, 1, 2].map((t): Quad => (
  { subject: `urn:asset:${i}`, predicate: `urn:p:${t}`, object: `"${i}-${t}"`, graph: asset(i) }))).flat();

const count = async (store: OxigraphStore, graph: string) => {
  const result = await store.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`) as { bindings: Array<{ n: string }> };
  return Number.parseInt(result.bindings[0]!.n.replace(/^"(\d+)".*$/s, '$1'), 10);
};

describe('a read-graph build on the file-backed embedded store', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'read-graph-snapshot-'));
    path = join(dir, 'store.nq');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('sends its copy batches without a snapshot, and writes the file no more often than its row changes', async () => {
    // A snapshot as soon as the event loop turns: the builder's pause after each batch gives it that turn.
    const adapter = new OxigraphStore(path, { flushDelayMs: 0 });
    try {
      await adapter.insert(SEED);
      await adapter.flush();
      // Each update the job sends, whether it is a copy batch (member graphs in a VALUES list), and its snapshot option.
      const sent: Array<{ readonly batch: boolean; readonly snapshot: UpdateOptions['snapshot'] }> = [];
      const update = adapter.update.bind(adapter);
      adapter.update = async (sparql, options) => {
        sent.push({ batch: sparql.includes('VALUES ?g'), snapshot: options?.snapshot });
        return update(sparql, options);
      };
      const snapshots = vi.spyOn(adapter as unknown as { flushNow(): Promise<void> }, 'flushNow');
      const store = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph-persistent', options: { path } }));

      const built = await buildReadGraph({ store, batching: { graphsPerBatch: 1, maxGraphsPerBatch: 1 } }, KEY);
      const duringBuild = snapshots.mock.calls.length;

      expect(built).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
      const batches = sent.filter((write) => write.batch);
      const rowChanges = sent.filter((write) => !write.batch);
      expect(batches.length).toBeGreaterThanOrEqual(ASSETS);
      expect(batches.every((write) => write.snapshot === 'deferred'), 'every copy batch is deferred').toBe(true);
      expect(rowChanges.length).toBeGreaterThan(0);
      expect(rowChanges.every((write) => write.snapshot === undefined), 'every other write snapshots').toBe(true);
      // One snapshot at most per write that schedules one, so far fewer than one per batch.
      expect(rowChanges.length).toBeLessThan(batches.length / 2);
      expect(duringBuild).toBeLessThanOrEqual(rowChanges.length);

      // The snapshot scheduled by the change that published the read graph holds all of it; read-only, so the
      // reopened store never writes the file the first one writes.
      await vi.waitFor(async () => {
        const reopened = new OxigraphStore(path, { readOnly: true });
        try {
          expect(await count(reopened, readGraphIri(KEY)), 'the read graph in the file').toBe(SEED.length);
        } finally { await reopened.close(); }
      }, { timeout: 10_000, interval: 100 });
    } finally { await adapter.close(); }
  }, 60_000);
});
