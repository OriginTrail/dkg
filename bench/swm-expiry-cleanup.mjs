/** Run after building agent: node bench/swm-expiry-cleanup.mjs [operations=10000] [family=100]. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { runSwmExpiryCleanup, SWM_CLEANUP_BATCH_SIZE, SWM_CLEANUP_MAX_BATCHES } from '../packages/agent/dist/swm-expiry-cleanup.js';
import { SwmExpiryCleanupWorker } from '../packages/agent/dist/swm-expiry-cleanup-worker.js';

const count = Number(process.argv[2] ?? 10000);
const familySize = Number(process.argv[3] ?? 100);
assert(Number.isSafeInteger(count) && count > 0);
assert(Number.isSafeInteger(familySize) && familySize >= 0);
const root = 'did:dkg:context-graph:expiry-benchmark/_shared_memory';
const meta = `${root}_meta`;
const operations = new Set(Array.from({ length: count }, (_, i) => `urn:expiry:${i}`));
const family = Array.from({ length: familySize }, (_, i) => `${root}/family-${i}`);
const stats = { passes: 0, selections: 0, largestBatch: 0, maxOperationsPerPass: 0, familyLists: 0, active: 0, maxActive: 0, triplesDeleted: 0 };
const store = {
  async listGraphsByPrefix(prefix) {
    if (prefix === `${root}/`) { stats.familyLists++; return family; }
    return [meta].filter(graph => graph.startsWith(prefix));
  },
  async hasGraph() { return true; },
  async query(sparql, options) {
    if (options?.source === 'agent.swmCleanup.expiredOperations') {
      stats.selections++;
      const limit = Number(/LIMIT\s+(\d+)/i.exec(sparql)?.[1]);
      assert.equal(limit, SWM_CLEANUP_BATCH_SIZE);
      const rows = Array.from(operations).slice(0, limit);
      stats.largestBatch = Math.max(stats.largestBatch, rows.length);
      return { type: 'bindings', bindings: rows.map(op => ({ op, re: 'urn:expiry:root' })) };
    }
    if (options?.source === 'agent.swmCleanup.revalidateOperation') {
      const rows = Array.from(operations).filter(op => sparql.includes(`<${op}>`));
      return { type: 'bindings', bindings: rows.map(op => ({ op, re: 'urn:expiry:root' })) };
    }
    return { type: 'bindings', bindings: [] };
  },
  async deleteByPattern(pattern) {
    return pattern.graph === meta && operations.delete(pattern.subject) ? 3 : 0;
  },
  async deleteBySubjectPrefix() { return 0; },
};
const ttlSettings = {
  sharedMemoryTtlMs: 60_000,
  getSharedMemoryTtlMs() { return this.sharedMemoryTtlMs; },
  setSharedMemoryTtlMs(ttlMs) { this.sharedMemoryTtlMs = ttlMs; },
};
const writeLocks = new Map();
const worker = new SwmExpiryCleanupWorker(async (ttl, isClosed, continuation) => {
  stats.passes++;
  stats.active++;
  stats.maxActive = Math.max(stats.maxActive, stats.active);
  const before = operations.size;
  try {
    return await runSwmExpiryCleanup({ store, workspaceOwnedEntities: new Map(), writeLocks, log: { info() {}, warn(_ctx, message) { throw new Error(message); } }, isClosed }, ttl, continuation);
  } finally {
    stats.maxOperationsPerPass = Math.max(stats.maxOperationsPerPass, before - operations.size);
    stats.active--;
  }
}, ttlSettings, 60_000);
const cpu = process.cpuUsage();
const start = performance.now();
while (operations.size) {
  const before = operations.size;
  const first = worker.runNow();
  assert.equal(worker.runNow(), first, 'overlapping callers must share the same pass');
  stats.triplesDeleted += await first;
  assert(operations.size < before, 'each pass must make progress');
}
await worker.stop();
assert.equal(stats.triplesDeleted, count * 3);
assert.equal(stats.maxActive, 1);
assert(stats.largestBatch <= SWM_CLEANUP_BATCH_SIZE);
assert(stats.maxOperationsPerPass <= SWM_CLEANUP_BATCH_SIZE * SWM_CLEANUP_MAX_BATCHES);
assert.equal(stats.familyLists, count);
const used = process.cpuUsage(cpu);
console.log(JSON.stringify({ operations: count, familyGraphs: familySize + 1, ...stats, elapsedMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000 }, null, 2));
