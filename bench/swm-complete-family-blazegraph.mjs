/**
 * Sparse complete-family SWM read probe against a LOCAL Blazegraph namespace.
 * Build core + storage first. Example:
 *   BLAZEGRAPH_TEST_URL=http://127.0.0.1:9999/blazegraph/namespace/swmprobe/sparql \
 *     node bench/swm-complete-family-blazegraph.mjs
 *
 * Defaults reproduce the lower end of the 2026-09-29 mainnet failure shape:
 * 13,000 named graphs, 51 roots, with the selected root in the first and last
 * graph. This is a sparse synthetic probe, not a production-load benchmark.
 */
import { BlazegraphStore } from '../packages/storage/dist/adapters/blazegraph.js';
import { GraphSetIndexStore } from '../packages/storage/dist/graph-set-index-store.js';
import { loadSelectedSharedMemoryQuads } from '../packages/storage/dist/graph-manager.js';
import { contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';

const url = process.env.BLAZEGRAPH_TEST_URL;
if (!url) throw new Error('BLAZEGRAPH_TEST_URL is required');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('This write/delete probe requires a loopback Blazegraph URL');
}
const count = Number(process.env.SWM_BENCH_GRAPHS ?? 13_000);
const rootCount = Number(process.env.SWM_BENCH_ROOTS ?? 51);
if (!Number.isSafeInteger(count) || count < 2 || count > 50_000) {
  throw new Error('SWM_BENCH_GRAPHS must be a safe integer in [2, 50000]');
}
if (!Number.isSafeInteger(rootCount) || rootCount < 1 || rootCount > 100) {
  throw new Error('SWM_BENCH_ROOTS must be a safe integer in [1, 100]');
}

const store = new BlazegraphStore(url, { timeout: 30_000 });
const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const swm = contextGraphSharedMemoryUri(`swm-probe-${runId}`);
const roots = Array.from({ length: rootCount }, (_, i) => `urn:swm-probe:${runId}:root:${i}`);
const quads = Array.from({ length: count }, (_, i) => ({
  subject: `urn:swm-probe:${runId}:decoy:${i}`,
  predicate: 'urn:p',
  object: '"decoy"',
  graph: `${swm}/0xabcdef0123456789abcdef0123456789abcdef01/${i + 1}`,
}));
quads.push(
  { subject: roots[0], predicate: 'urn:p', object: '"same"', graph: quads[0].graph },
  { subject: roots[0], predicate: 'urn:p', object: '"same"', graph: quads[count - 1].graph },
  {
    subject: `${roots[0]}/.well-known/genid/child`,
    predicate: 'urn:p',
    object: '"child"',
    graph: quads[count - 1].graph,
  },
);

let seeded = false;
try {
  const seedAt = performance.now();
  await store.insert(quads);
  seeded = true;
  const seededMs = Math.round(performance.now() - seedAt);
  const indexed = new GraphSetIndexStore(store);
  const readAt = performance.now();
  const selected = await loadSelectedSharedMemoryQuads(
    indexed,
    swm,
    { rootEntities: roots },
    { resultBudget: { pageRows: 100, maxRows: 2, maxBytesEstimate: 1024 * 1024 } },
  );
  const readMs = Math.round(performance.now() - readAt);
  if (selected.length !== 2) throw new Error(`Expected 2 unique quads, got ${selected.length}`);
  process.stdout.write(`${JSON.stringify({ graphs: count, roots: rootCount, seededMs, readMs, resultQuads: selected.length })}\n`);
} finally {
  try {
    if (seeded) await store.delete(quads);
  } finally {
    await store.close();
  }
}
