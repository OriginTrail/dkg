// SPDX-License-Identifier: Apache-2.0
// Synthetic loopback-only benchmark. Use an owned disposable Blazegraph instance.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [root, label, output] = process.argv.slice(2);
assert(root && label && output, 'usage: node benchmark-exact-verification.mjs ABSOLUTE_CHECKOUT LABEL OUTPUT.json');
const load = path => import(pathToFileURL(`${root}/${path}`));
const { computeFlatKCRootV10 } = await load('packages/publisher/dist/index.js');
const { BlazegraphStore, StorePriorityScheduler } = await load('packages/storage/dist/index.js');
const { BlazegraphNamespaceManager } = await load('packages/storage/dist/blazegraph-namespace-manager.js');
const { verifyExactGraphContent } = await load('packages/agent/dist/exact-graph-content-verifier.js');
const storageHash = createHash('sha256').update(await readFile(`${root}/packages/storage/dist/bounded-rdf.js`)).digest('hex');
const manager = new BlazegraphNamespaceManager({ namespaceApiUrl: 'http://127.0.0.1:56928/bigdata/namespace' });
const handles = await manager.acquireMany([`exact-verification-${randomUUID()}`]);
const scheduler = new StorePriorityScheduler({ maxConcurrent: 4, ackReservedSlots: 1,
  healthReservedSlots: 1, normalReservedSlots: 1, backgroundReservedSlots: 1 });
const store = new BlazegraphStore(handles[0].sparqlUrl, { scheduler });
const graph = 'urn:synthetic:assertion';
const quads = Array.from({ length: 5000 }, (_, i) => ({ graph, subject: `urn:synthetic:${i}`,
  predicate: 'urn:synthetic:value', object: '"Synthetic verification payload"' }));
const rootHash = computeFlatKCRootV10(quads, []);
const verify = () => verifyExactGraphContent(store, { graphUri: graph, publicTripleCount: quads.length,
  expectedMerkleRoot: rootHash, source: 'benchmark.exactVerification' });
const foregroundGraph = 'urn:synthetic:foreground', metaGraph = 'urn:synthetic:foreground-meta';
const foregroundQuads = Array.from({ length: 10000 }, (_, i) => ({ graph: foregroundGraph,
  subject: `urn:synthetic:foreground:${i}`, predicate: 'urn:synthetic:value', object: '"Foreground payload"' }));
const observations = [], foreground = [], rounds = [];
const query = store.query.bind(store);
let phase = 'setup';
store.query = async (sparql, options) => {
  const start = performance.now();
  try { return await query(sparql, options); }
  finally { if (options?.source === 'benchmark.exactVerification') observations.push({ phase,
    kind: sparql.includes('COUNT(*)') ? 'count' : 'payload', elapsedMs: performance.now() - start }); }
};
try {
  await store.insert(quads);
  for (let i = 0; i < 3; i++) assert.equal((await verify()).status, 'verified');
  for (const concurrent of [false, true]) {
    phase = concurrent ? 'concurrent' : 'idle';
    let done = false;
    const probes = concurrent ? (async () => {
      do {
        const start = performance.now();
        await store.replaceGraphAndSubject(foregroundGraph, foregroundQuads, metaGraph, 'urn:synthetic:asset',
          [{ graph: metaGraph, subject: 'urn:synthetic:asset', predicate: 'urn:synthetic:version', object: `"${foreground.length}"` }]);
        foreground.push({ elapsedMs: performance.now() - start });
        assert.equal(await store.countQuads(foregroundGraph), foregroundQuads.length);
        assert.equal(await store.countQuads(metaGraph), 1);
        await delay(25);
      } while (!done);
    })() : Promise.resolve();
    const measurements = [], started = performance.now();
    const reads = (async () => {
      try {
        for (let i = 0; i < 36; i++) {
          const start = performance.now(), result = await verify();
          assert.equal(result.status, 'verified');
          assert.equal(result.quads.length, quads.length);
          measurements.push(performance.now() - start);
        }
        rounds.push({ phase, elapsedMs: performance.now() - started, measurements });
      } finally { done = true; }
    })();
    // Settle both paths before closing the namespace, including on failure.
    const outcomes = await Promise.allSettled([reads, probes]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }
  await writeFile(output, JSON.stringify({ label, storageHash, triples: quads.length,
    rounds, foreground, observations }, null, 2) + '\n');
  console.log(JSON.stringify({ label, rounds: rounds.map(({ phase, elapsedMs }) => ({ phase, elapsedMs })) }));
} finally { await store.close(); await manager.disposeAll(handles); }
