/**
 * A writer for the kill-at-commit lane, run as its own process with `node --import tsx`.
 * It keeps one context graph's verifiable-memory read graph ready and sends maintained
 * writes until it is killed. Before each write it prints `sending <n> <kind>`, and after it
 * `committed <n>`, so the parent can kill it while a write is in flight.
 *
 * DKG_KILL_BACKEND is `blazegraph` (with DKG_KILL_URL) or `oxigraph` (with DKG_KILL_PATH, a
 * persistent store flushed after every write). DKG_KILL_CG names the context graph.
 */
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { guardReadGraphPartition } from '../../src/read-graph-partition-store.js';
import { wrapReadGraphLayer } from '../../src/read-graph/read-graph-store.js';
import { CURRENT_READ_GRAPH_VERSIONS } from '../../src/read-graph/state.js';
import type { TripleStoreConfig } from '../../src/triple-store-composition.js';
import type { Quad, TripleStore } from '../../src/triple-store.js';
import { PlanningOxigraphStore } from './read-graph-planning-store.js';
import { KILL_AT_COMMIT_CYCLE, killAtCommitBatch, killAtCommitMember } from './read-graph-kill-fixture.js';

const backend = process.env.DKG_KILL_BACKEND;
const contextGraphId = process.env.DKG_KILL_CG;
if (!contextGraphId) throw new Error('DKG_KILL_CG is required');
const batchSize = Number(process.env.DKG_KILL_BATCH ?? 2_000);

let adapter: TripleStore;
let config: TripleStoreConfig;
if (backend === 'blazegraph') {
  const url = process.env.DKG_KILL_URL;
  if (!url) throw new Error('DKG_KILL_URL is required');
  adapter = new BlazegraphStore(url, { timeout: 120_000 });
  config = { backend: 'blazegraph', options: { url } };
} else if (backend === 'oxigraph') {
  const path = process.env.DKG_KILL_PATH;
  if (!path) throw new Error('DKG_KILL_PATH is required');
  adapter = new PlanningOxigraphStore(path);
  config = { backend: 'oxigraph-persistent', options: { path } };
} else {
  throw new Error(`Unknown DKG_KILL_BACKEND: ${backend}`);
}

const layer = wrapReadGraphLayer(adapter, config);
const store = guardReadGraphPartition(layer);
const readGraph = readGraphIri({ scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory });
layer.runtime.mirror.set({ readGraph, state: 'ready', generation: 1, ...CURRENT_READ_GRAPH_VERSIONS });

for (let n = 0; ; n += 1) {
  const step = KILL_AT_COMMIT_CYCLE[n % KILL_AT_COMMIT_CYCLE.length]!;
  const quads: Quad[] = killAtCommitBatch(killAtCommitMember(contextGraphId, step.member), batchSize);
  process.stdout.write(`sending ${n} ${step.kind}\n`);
  if (step.kind === 'insert') await store.insert(quads);
  else await store.delete(quads);
  if (backend === 'oxigraph') await adapter.flush?.();
  process.stdout.write(`committed ${n}\n`);
}
