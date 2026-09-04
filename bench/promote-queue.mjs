// Build publisher first, then: node --expose-gc bench/promote-queue.mjs [baseline-git-ref]
// In-memory Oxigraph claim latency with fixed active work and growing terminal history.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { OxigraphStore } from '../packages/storage/dist/index.js';
import { TripleStoreAsyncPromoteQueue } from '../packages/publisher/dist/async-promote-queue-impl.js';
import { serializeJob, DEFAULT_PROMOTE_CONTROL_GRAPH_URI } from '../packages/publisher/dist/async-promote-queue-utils.js';

const baselineRef = process.argv[2];
const dist = new URL('../packages/publisher/dist/', import.meta.url);
let baseline;
if (baselineRef) {
  const source = execFileSync('git', ['show', `${baselineRef}:packages/publisher/src/async-promote-queue-impl.ts`], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  }}).outputText.replaceAll(/from '([^']+)'/g, (_, specifier) => {
    const url = specifier.startsWith('.') ? new URL(specifier, dist)
      : specifier === '@origintrail-official/dkg-storage' ? new URL('../../storage/dist/index.js', dist)
      : (() => { throw new Error(`Unexpected baseline import: ${specifier}`); })();
    return `from '${url}'`;
  });
  baseline = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).TripleStoreAsyncPromoteQueue;
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = [];
for (const historySize of [1_000, 10_000, 100_000]) {
  const store = new OxigraphStore();
  const graph = DEFAULT_PROMOTE_CONTROL_GRAPH_URI;
  await store.createGraph(graph);
  const job = (jobId, state) => ({
    jobId, state, enqueuedAt: 1, updatedAt: 1, formatVersion: 1,
    request: { contextGraphId: 'benchmark', subGraphName: 'code', assertionName: jobId, entities: 'all' },
    attempt: { count: 0, maxRetries: 5 },
  });
  for (let start = 0; start < historySize; start += 1_000) {
    await store.insert(Array.from({ length: Math.min(1_000, historySize - start) }, (_, i) =>
      serializeJob(job(`history-${start + i}`, i % 2 ? 'failed' : 'succeeded'), graph)).flat());
  }
  const queued = Array.from({ length: 3 }, (_, i) => job(`active-${i}`, 'queued'));
  const originalQuery = store.query.bind(store);
  let candidates = [];
  store.query = async (...args) => {
    const result = await originalQuery(...args);
    if (args[1]?.source === 'publisher.asyncPromote.claimNext.candidates') {
      assert.equal(result.type, 'bindings');
      candidates.push({ rows: result.bindings.length, bytes: Buffer.byteLength(JSON.stringify(result.bindings)) });
    }
    return result;
  };
  for (const [name, Queue] of [['current', TripleStoreAsyncPromoteQueue], ['baseline', baseline]]) {
    if (!Queue) continue;
    const samples = [];
    for (let n = 0; n < 7; n++) {
      // Use the same serializer's subject rather than relying on the URI layout.
      for (const active of queued) {
        const quads = serializeJob(active, graph);
        await store.deleteByPattern({ graph, subject: quads[0].subject });
        await store.insert(quads);
      }
      candidates = [];
      const queue = new Queue(store, { now: () => 1_000, claimTokenGenerator: () => 'benchmark-token' });
      global.gc?.();
      const before = process.memoryUsage().heapUsed;
      const start = performance.now();
      assert.equal((await queue.claimNext('benchmark-worker'))?.jobId, 'active-0');
      const elapsedMs = performance.now() - start;
      const heapDeltaAtReturn = process.memoryUsage().heapUsed - before;
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].rows, name === 'current' ? 3 : historySize + 3);
      if (n >= 2) samples.push({ elapsedMs, heapDeltaAtReturn, ...candidates[0] });
    }
    rows.push({ name, historySize, activeJobs: 3, medianMs: median(samples.map(s => s.elapsedMs)),
      medianHeapDeltaAtReturn: median(samples.map(s => s.heapDeltaAtReturn)), samples });
  }
  await store.close();
}
console.log(JSON.stringify({ node: process.version, baselineRef, gcEnabled: Boolean(global.gc), rows }, null, 2));
