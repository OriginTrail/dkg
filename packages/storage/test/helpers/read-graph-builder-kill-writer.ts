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
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { OxigraphStore } from '../../src/adapters/oxigraph.js';
import { guardReadGraphPartition } from '../../src/read-graph-partition-store.js';
import { wrapReadGraphLayer } from '../../src/read-graph/read-graph-store.js';
import { buildReadGraph } from '../../src/read-graph/rebuild.js';
import type { TripleStoreConfig } from '../../src/triple-store-composition.js';
import type { TripleStore } from '../../src/triple-store.js';

const contextGraphId = process.env.DKG_KILL_CG;
if (!contextGraphId) throw new Error('DKG_KILL_CG is required');
const stopAfter = Number(process.env.DKG_KILL_BATCHES);
if (!Number.isSafeInteger(stopAfter) || stopAfter < 1) throw new Error('DKG_KILL_BATCHES must name a copy batch by its number');

let adapter: TripleStore;
let config: TripleStoreConfig;
if (process.env.DKG_KILL_BACKEND === 'blazegraph') {
  const url = process.env.DKG_KILL_URL;
  if (!url) throw new Error('DKG_KILL_URL is required');
  adapter = new BlazegraphStore(url, { timeout: 120_000 });
  config = { backend: 'blazegraph', options: { url } };
} else if (process.env.DKG_KILL_BACKEND === 'oxigraph') {
  const path = process.env.DKG_KILL_PATH;
  if (!path) throw new Error('DKG_KILL_PATH is required');
  adapter = new OxigraphStore(path);
  config = { backend: 'oxigraph-persistent', options: { path } };
} else {
  throw new Error(`Unknown DKG_KILL_BACKEND: ${process.env.DKG_KILL_BACKEND}`);
}

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
