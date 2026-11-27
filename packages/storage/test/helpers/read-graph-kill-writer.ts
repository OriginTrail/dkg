/**
 * A writer for the kill-at-commit lane, run as its own process with `node --import tsx`.
 * It keeps one context graph's verifiable-memory read graph ready and sends the maintained
 * writes of the kill cycle in order, up to and including write DKG_KILL_TARGET. Then it waits
 * to be killed: no write after the target starts. It prints `sending <n> <kind>` before each
 * write, `to-store <n>` when the layer hands the write's request to the store below it, and
 * `returned <n>` once the write has returned (on the embedded store, once it is dumped too).
 *
 * The writes go through each engine's production adapter under the read-graph layer.
 * DKG_KILL_BACKEND is `blazegraph` (with DKG_KILL_URL) or `oxigraph` (with DKG_KILL_PATH, a
 * persistent embedded store dumped after every write). DKG_KILL_CG names the context graph.
 */
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { guardReadGraphPartition } from '../../src/read-graph-partition-store.js';
import { wrapReadGraphLayer } from '../../src/read-graph/read-graph-store.js';
import { CURRENT_READ_GRAPH_VERSIONS } from '../../src/read-graph/state.js';
import type { Quad } from '../../src/triple-store.js';
import { killAtCommitBatch, killAtCommitMember, killAtCommitWrite } from './read-graph-kill-fixture.js';
import { openKillWriterStore } from './kill-writer-store.js';

const contextGraphId = process.env.DKG_KILL_CG;
if (!contextGraphId) throw new Error('DKG_KILL_CG is required');
const target = Number(process.env.DKG_KILL_TARGET);
if (!Number.isSafeInteger(target) || target < 0) throw new Error('DKG_KILL_TARGET must name a write by its number');
const batchSize = Number(process.env.DKG_KILL_BATCH ?? 2_000);

const { adapter, config } = openKillWriterStore();
const embedded = process.env.DKG_KILL_BACKEND === 'oxigraph';

// The layer sends each maintained write as one insert or delete to the adapter below it, with
// the read graph's part in the same request. Announce that request as it goes.
let current = -1;
const insert = adapter.insert.bind(adapter);
const remove = adapter.delete.bind(adapter);
adapter.insert = (quads, options) => { process.stdout.write(`to-store ${current}\n`); return insert(quads, options); };
adapter.delete = (quads, options) => { process.stdout.write(`to-store ${current}\n`); return remove(quads, options); };

const layer = wrapReadGraphLayer(adapter, config);
const store = guardReadGraphPartition(layer);
const readGraph = readGraphIri({ scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory });
layer.runtime.mirror.set({ readGraph, state: 'ready', generation: 1, ...CURRENT_READ_GRAPH_VERSIONS });

for (let n = 0; n <= target; n += 1) {
  current = n;
  const write = killAtCommitWrite(n);
  const quads: Quad[] = killAtCommitBatch(killAtCommitMember(contextGraphId, write.member), batchSize);
  process.stdout.write(`sending ${n} ${write.kind}\n`);
  if (write.kind === 'insert') await store.insert(quads);
  else await store.delete(quads);
  if (embedded) await adapter.flush?.();
  process.stdout.write(`returned ${n}\n`);
}
// The target write was the last: stay alive, with nothing more to send, until the kill.
setInterval(() => undefined, 60_000);
