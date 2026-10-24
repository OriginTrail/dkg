import { performance } from 'node:perf_hooks';
import { SparqlHttpStore } from '../dist/adapters/sparql-http.js';

const iterations = Number.parseInt(process.env.DKG_DELETE_BENCH_ITERATIONS ?? '100', 10);
const latencyMs = Number.parseFloat(process.env.DKG_DELETE_BENCH_LATENCY_MS ?? '2');
if (!Number.isSafeInteger(iterations) || iterations <= 0) {
  throw new Error('DKG_DELETE_BENCH_ITERATIONS must be a positive integer');
}
if (!Number.isFinite(latencyMs) || latencyMs < 0) {
  throw new Error('DKG_DELETE_BENCH_LATENCY_MS must be a non-negative number');
}

const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async (_input, init) => {
  requests += 1;
  if (latencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }
  const body = String(init?.body ?? '');
  if (body.startsWith('SELECT')) {
    return new Response(JSON.stringify({
      head: { vars: ['c'] },
      results: { bindings: [{ c: { type: 'literal', value: '1' } }] },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    });
  }
  return new Response(null, { status: 200 });
};

const pattern = { graph: 'urn:benchmark:graph', subject: 'urn:benchmark:subject' };
const store = new SparqlHttpStore({
  queryEndpoint: 'http://benchmark.invalid/query',
  updateEndpoint: 'http://benchmark.invalid/update',
  timeout: 30_000,
});

async function measure(run) {
  requests = 0;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) await run();
  return {
    elapsedMs: performance.now() - started,
    requests,
    requestsPerDelete: requests / iterations,
  };
}

try {
  const counted = await measure(() => store.deleteByPattern(pattern));
  const noCount = await measure(() => store.deleteByPatternWithoutCount(pattern));
  process.stdout.write(`${JSON.stringify({
    iterations,
    simulatedRequestLatencyMs: latencyMs,
    counted,
    noCount,
    requestReductionPercent: (1 - noCount.requests / counted.requests) * 100,
    elapsedSpeedup: counted.elapsedMs / noCount.elapsedMs,
  }, null, 2)}\n`);
} finally {
  await store.close();
  globalThis.fetch = originalFetch;
}
