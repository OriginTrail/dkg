// Controlled external-store experiment; creates and removes its own namespace.
// Build agent/storage first, then set DKG_STORE_BENCHMARK_BASE_URL to an isolated
// Blazegraph /bigdata endpoint. No wallet or public-chain operation is performed.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  BlazegraphStore, BlazegraphNamespaceManager, StorePriorityScheduler,
} from '../../packages/storage/dist/index.js';
import {
  DKG_ONTOLOGY as DKG, contextGraphDataGraphUri, contextGraphMetaGraphUri,
} from '../../packages/core/dist/index.js';
import { resolveContextGraphMetadataConfirmationV1 } from '../../packages/agent/dist/context-graph-meta-confirmation.js';

const baseUrl = process.env.DKG_STORE_BENCHMARK_BASE_URL;
if (!baseUrl) throw new Error('Set DKG_STORE_BENCHMARK_BASE_URL to an isolated Blazegraph /bigdata endpoint');
const manager = new BlazegraphNamespaceManager({ namespaceApiUrl: `${baseUrl.replace(/\/$/, '')}/namespace` });
const handles = await manager.acquireMany([`admission-${randomUUID()}`]);
const endpoint = handles[0].sparqlUrl;
const count = 384;
const width = 24;
const ids = Array.from({ length: 64 }, (_, i) => `0x3409/bench-${i}`);

function stats(values) {
  if (!values.length) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => {
    const index = (sorted.length - 1) * fraction;
    return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
  };
  return { n: sorted.length, median: percentile(.5), p90: percentile(.9), p95: percentile(.95), max: sorted.at(-1) };
}

async function seed() {
  const store = new BlazegraphStore(endpoint);
  const quads = ids.flatMap((id, i) => {
    const base = { graph: contextGraphMetaGraphUri(id), subject: contextGraphDataGraphUri(id) };
    return [
      { ...base, predicate: DKG.RDF_TYPE, object: DKG.DKG_CONTEXT_GRAPH },
      { ...base, predicate: DKG.DKG_ACCESS_POLICY, object: JSON.stringify(i % 2 ? 'public' : 'private') },
      ...(i % 2 ? [] : [DKG.DKG_CREATOR, DKG.DKG_CURATOR].map(predicate => ({
        ...base, predicate, object: 'did:dkg:agent:0x3409',
      }))),
    ];
  });
  await store.insert(quads);
  await store.insert(Array.from({ length: 10_000 }, (_, i) => ({
    graph: 'urn:3409:catalog', subject: `urn:3409:row:${i}`,
    predicate: 'urn:3409:value', object: JSON.stringify(`catalog ${i}`),
  })));
}

async function arm(index, capacity) {
  const scheduler = new StorePriorityScheduler({
    maxConcurrent: capacity, ackReservedSlots: 1, healthReservedSlots: 1, queueLimits: 64,
  });
  const store = new BlazegraphStore(endpoint, { scheduler });
  const operations = [];
  const run = scheduler.run.bind(scheduler);
  scheduler.run = (priority, source, work, signal, metadata) => {
    const queuedAt = performance.now();
    return run(priority, source, async () => {
      const startedAt = performance.now();
      try { return await work(); }
      finally { operations.push({ source, waitMs: startedAt - queuedAt, runMs: performance.now() - startedAt }); }
    }, signal, metadata);
  };
  const dependencies = {
    store, chain: {}, peerId: 'benchmark', localApprovedAgentByContextGraph: new Map(), subscriptions: new Map(),
    isPrivateContextGraph: async () => false,
    resolveActivePublicChainProof: async () => { throw new Error('Unexpected chain fallback for complete metadata'); },
  };
  const confirm = async i => {
    const result = await resolveContextGraphMetadataConfirmationV1(dependencies, ids[i % ids.length]);
    if (result.outcome !== 'confirmed') throw new Error('Complete metadata did not confirm');
  };
  for (let i = 0; i < 64; i++) await confirm(i);
  operations.length = 0;
  let stop = false, next = 0, successful = 0, failed = 0, writes = 0, writeErrors = 0, probeErrors = 0;
  const latency = [], probes = [];
  const sleep = () => new Promise(resolve => setTimeout(resolve, 25));
  const writer = (async () => {
    while (!stop) {
      try {
        await store.update(`DELETE { GRAPH <urn:3409:jobs> { <urn:3409:job:1> <urn:3409:payload> ?old } }
          INSERT { GRAPH <urn:3409:jobs> { <urn:3409:job:1> <urn:3409:payload> "heartbeat ${writes}" } }
          WHERE { OPTIONAL { GRAPH <urn:3409:jobs> { <urn:3409:job:1> <urn:3409:payload> ?old } } }`,
        { source: 'benchmark.jobBookkeeping' });
        writes++;
      } catch { writeErrors++; }
      await sleep();
    }
  })();
  const probe = async priority => {
    while (!stop) {
      const startedAt = performance.now();
      try {
        await store.query('ASK { GRAPH <urn:3409:catalog> { <urn:3409:row:1> ?p ?o } }',
          { priority, source: `probe.${priority}` });
        probes.push({ priority, ms: performance.now() - startedAt });
      } catch { probeErrors++; }
      await sleep();
    }
  };
  const probeJobs = [probe('ack'), probe('health')];
  let samples = 0, queuePositive = 0, peakQueued = 0, peakNormal = 0;
  const sampler = setInterval(() => {
    const snapshot = scheduler.snapshot;
    samples++; if (snapshot.normalQueued) queuePositive++;
    peakQueued = Math.max(peakQueued, snapshot.normalQueued);
    peakNormal = Math.max(peakNormal, snapshot.normalInflight);
  }, 10);
  const startedAt = performance.now();
  let elapsedMs;
  try {
    await Promise.all(Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= count) break;
        const acceptedAt = performance.now();
        try { await confirm(i); successful++; latency.push(performance.now() - acceptedAt); }
        catch { failed++; }
      }
    }));
    elapsedMs = performance.now() - startedAt;
  } finally {
    stop = true;
    await Promise.all([...probeJobs, writer]);
    clearInterval(sampler);
  }
  const normal = operations.filter(operation => !operation.source.startsWith('probe.'));
  return {
    index, capacity, ordinaryLimit: capacity - 2, successful, failed, writes, writeErrors, probeErrors,
    elapsedMs, requestsPerSecond: successful / (elapsedMs / 1000), latency: stats(latency),
    normalOperations: normal.length, queueWait: stats(normal.map(operation => operation.waitMs)),
    execution: stats(normal.map(operation => operation.runMs)),
    ack: stats(probes.filter(sample => sample.priority === 'ack').map(sample => sample.ms)),
    health: stats(probes.filter(sample => sample.priority === 'health').map(sample => sample.ms)),
    samples, queuePositive, peakQueued, peakNormal,
  };
}

const results = [];
try {
  await seed();
  const capacities = [4, 6, 8, 10, 10, 8, 6, 4];
  for (let i = 0; i < capacities.length; i++) {
    results.push(await arm(i, capacities[i]));
    console.error(JSON.stringify(results.at(-1)));
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  console.log(JSON.stringify({ count, width, contextGraphs: 64, catalogTriples: 10_000, results }, null, 2));
  if (results.some(result => result.failed || result.writeErrors || result.probeErrors)) process.exitCode = 1;
} finally {
  await manager.disposeAll(handles);
}
