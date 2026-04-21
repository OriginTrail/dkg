#!/usr/bin/env node
/**
 * Greedy bin-packing shard allocator for `packages/agent` vitest files.
 *
 * Why this exists
 * ---------------
 * vitest's built-in `--shard=N/M` hashes test file paths and can land multiple
 * heavy files on the same runner. On ubuntu-latest (2 cores) each file pays
 * ~30s of beforeAll/afterAll hook wall-clock; three heavy files in one shard
 * adds up to ~4m 22s, which is currently the critical path for the whole CI
 * pipeline (see `.github/workflows/ci.yml` header on `tornado-agent`).
 *
 * This script picks the files for a given shard using a greedy bin-packing
 * strategy: sort files by known runtime descending, then assign each to the
 * lightest bin. The three heaviest files (e2e-privacy, e2e-publish-protocol,
 * e2e-flows) land alone on three shards; the remaining ~37 files distribute
 * evenly across the other seven shards. Projected ceiling is ~3m 30s per
 * shard (e2e-privacy's own hook wall-clock), down from ~4m 22s.
 *
 * Weights
 * -------
 * Weights are the per-file test-body durations (in ms) from a recent green
 * CI run. Refresh when any single file's runtime changes by >20% or when new
 * heavy test files are added. Unknown files get DEFAULT_WEIGHT and will end
 * up in whichever bin is currently lightest — this self-heals for new files
 * without requiring manual intervention.
 *
 * Usage
 * -----
 *   node scripts/ci-shard-agent.mjs <shardId> <totalShards>
 *
 * Prints one test file path per line on stdout (paths relative to
 * `packages/agent`). Exits non-zero if the requested shard is out of range
 * or if the test directory is empty.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEIGHTS = {
  'test/e2e-privacy.test.ts': 47457,
  'test/e2e-publish-protocol.test.ts': 43336,
  'test/e2e-flows.test.ts': 39324,
  'test/e2e-network.test.ts': 30463,
  'test/e2e-security.test.ts': 23016,
  'test/e2e-workspace-sync.test.ts': 20705,
  'test/e2e-sub-graphs.test.ts': 20576,
  'test/agent.test.ts': 18637,
  'test/e2e-bulletproof.test.ts': 18199,
  'test/gossip-validation.test.ts': 16221,
  'test/e2e-agents.test.ts': 15124,
  'test/e2e-sub-graph-gossip.test.ts': 12034,
  'test/e2e-workspace.test.ts': 9800,
  'test/e2e-memory-layers.test.ts': 9711,
  'test/workspace-ttl.test.ts': 8758,
  'test/e2e-context-graph.test.ts': 8003,
  'test/publish-jsonld.test.ts': 7601,
  'test/paranet-discovery.test.ts': 5800,
  'test/e2e-assertion-lifecycle.test.ts': 5318,
  'test/e2e-chain.test.ts': 5000,
  'test/e2e-finalization.test.ts': 5000,
  'test/per-cg-quorum-extra.test.ts': 2018,
  'test/agent-audit-extra.test.ts': 1898,
  'test/swm-first-writer-wins-extra.test.ts': 1139,
  'test/v10-ack-provider.test.ts': 1131,
  'test/finalization-promote-extra.test.ts': 1058,
  'test/wm-multi-agent-isolation-extra.test.ts': 1022,
  'test/swm-512kb-boundary-extra.test.ts': 1000,
};
const DEFAULT_WEIGHT = 500;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const [, , shardArg, totalArg] = process.argv;
const shardId = parseInt(shardArg, 10);
const totalShards = parseInt(totalArg, 10);
if (!Number.isInteger(shardId) || !Number.isInteger(totalShards) || shardId < 1 || shardId > totalShards) {
  console.error(`usage: ci-shard-agent.mjs <shardId> <totalShards> (got ${shardArg} ${totalArg})`);
  process.exit(2);
}

const packageRoot = process.cwd();
const testRoot = join(packageRoot, 'test');
const files = walk(testRoot)
  .map(abs => relative(packageRoot, abs))
  .sort();

if (files.length === 0) {
  console.error('ci-shard-agent: no *.test.ts files found under test/');
  process.exit(2);
}

const weighted = files
  .map(f => ({ f, w: WEIGHTS[f] ?? DEFAULT_WEIGHT }))
  .sort((a, b) => b.w - a.w);

const bins = Array.from({ length: totalShards }, () => ({ load: 0, files: [] }));
for (const { f, w } of weighted) {
  let minIdx = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].load < bins[minIdx].load) minIdx = i;
  }
  bins[minIdx].load += w;
  bins[minIdx].files.push(f);
}

for (const f of bins[shardId - 1].files) {
  console.log(f);
}
