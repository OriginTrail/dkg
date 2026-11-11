/**
 * A builder process for the restart lane, run as its own process with `node --import tsx`. It builds
 * one context graph's whole verifiable-memory read graph, one member graph per copy batch. It prints
 * `batch <n>` before copy batch n goes to the store and `returned <n>` once the store answered, and
 * after copy batch DKG_KILL_BATCHES has returned it stops and waits to be killed.
 *
 * DKG_KILL_BACKEND is `blazegraph` (with DKG_KILL_URL) or `oxigraph` (with DKG_KILL_PATH, a persistent
 * store, which dumps itself shortly after each write). DKG_KILL_CG names the context graph.
 */
import { MemoryLayer, readScope } from '@origintrail-official/dkg-core';
import { guardReadGraphPartition } from '../../src/read-graph-partition-store.js';
import { wrapReadGraphLayer } from '../../src/read-graph/read-graph-store.js';
import { buildReadGraph } from '../../src/read-graph/rebuild.js';
import { openKillWriterStore } from './kill-writer-store.js';

const contextGraphId = process.env.DKG_KILL_CG;
if (!contextGraphId) throw new Error('DKG_KILL_CG is required');
const stopAfter = Number(process.env.DKG_KILL_BATCHES);
if (!Number.isSafeInteger(stopAfter) || stopAfter < 1) throw new Error('DKG_KILL_BATCHES must name a copy batch by its number');

const { adapter, config } = openKillWriterStore();

// A copy batch is one fenced update naming its member graphs in a VALUES list: announce it at the adapter.
let copies = 0;
const update = adapter.update!.bind(adapter);
adapter.update = async (sparql, options) => {
  if (!sparql.includes('VALUES ?g')) return update(sparql, options);
  copies += 1;
  const n = copies;
  process.stdout.write(`batch ${n}\n`);
  await update(sparql, options);
  process.stdout.write(`returned ${n}\n`);
  // No batch after this one: hold the lock and wait for the kill.
  if (n >= stopAfter) await new Promise(() => setInterval(() => undefined, 60_000));
};

// A verifiable-memory read graph's membership does not depend on a working-memory identity, so the process needs none.
const layer = wrapReadGraphLayer(adapter, config);
const store = guardReadGraphPartition(layer);
await buildReadGraph(
  { store, batching: { graphsPerBatch: 1, maxGraphsPerBatch: 1, pauseRatio: 0 } },
  { scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory },
);
process.stdout.write('finished\n');
await new Promise(() => setInterval(() => undefined, 60_000));
