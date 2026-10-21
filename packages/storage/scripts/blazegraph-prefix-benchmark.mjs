#!/usr/bin/env node
// Isolated local experiment for #3270. Build dkg-storage first. Output is JSON.
import { listGraphsByPrefixCandidate } from './blazegraph-prefix-candidate.mjs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BlazegraphStore } from '../dist/adapters/blazegraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../dist/blazegraph-namespace-manager.js';
import { StorePriorityScheduler } from '../dist/store-priority-scheduler.js';

const endpoint = new URL(process.env.BLAZEGRAPH_TEST_URL ?? '');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
  throw new Error('This benchmark creates data: use an owned loopback test server.');
}
const manager = new BlazegraphNamespaceManager({
  namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint.href),
});
const handles = await manager.acquireMany([`prefix-bench-${randomUUID()}`]);
const url = handles[0].sparqlUrl;
const scheduler = new StorePriorityScheduler();
const run = scheduler.run.bind(scheduler);
let timing, wire;
scheduler.run = (priority, operation, work, ...rest) => {
  const queued = performance.now();
  return run(priority, operation, async () => {
    const admitted = performance.now();
    try { return await work(); }
    finally { timing = { queueMs: admitted - queued, serviceMs: performance.now() - admitted }; }
  }, ...rest);
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  if (String(input) === url && init?.headers?.['Content-Type']?.startsWith('application/sparql-query')) {
    const bytes = await response.clone().arrayBuffer();
    wire = { bytes: bytes.byteLength, rows: JSON.parse(new TextDecoder().decode(bytes)).results.bindings.length };
  }
  return response;
};
const store = new BlazegraphStore(url, { scheduler });
const prefix = 'urn:matching:';
const quads = graph => Array.from({ length: 10 }, (_, i) => ({
  graph, subject: `urn:subject:${i}`, predicate: 'urn:predicate', object: '"value"',
}));
const measurements = [];
try {
  await store.insert(Array.from({ length: 8 }, (_, i) => quads(`${prefix}${i}`)).flat());
  let previousCount = 0;
  for (const unrelatedGraphs of [100, 1_000, 5_000]) {
    for (let from = previousCount; from < unrelatedGraphs; from += 100) {
      const to = Math.min(from + 100, unrelatedGraphs);
      await store.insert(Array.from({ length: to - from }, (_, i) => quads(`urn:unrelated:${from + i}`)).flat());
    }
    previousCount = unrelatedGraphs;
    // Alternating order avoids always giving one path the warmed backend.
    // Two warmup pairs precede seven retained repetitions at each graph count.
    for (let repetition = -2; repetition < 7; repetition++) {
      const paths = repetition % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
      for (const path of paths) {
        const start = performance.now(); timing = undefined; wire = undefined;
        const result = path === 'before'
          ? (await store.listGraphs()).filter(g => g.startsWith(prefix))
          : await listGraphsByPrefixCandidate(store, prefix);
        if (result.length !== 8) throw new Error(`Incorrect enumeration: ${path} returned ${result.length}`);
        if (repetition >= 0) measurements.push({ path, repetition, unrelatedGraphs,
          graphCount: unrelatedGraphs + 8, quadCount: (unrelatedGraphs + 8) * 10,
          matchingGraphs: result.length, elapsedMs: performance.now() - start, ...timing, ...wire });
      }
    }
  }
  console.log(JSON.stringify({ note: 'Fresh uncached serial reads on an otherwise idle local server. Service includes response-body measurement and decode; queue reported independently. No engine scan-complexity claim.', measurements }, null, 2));
} finally {
  globalThis.fetch = nativeFetch;
  await store.close(); await manager.disposeAll(handles);
}
