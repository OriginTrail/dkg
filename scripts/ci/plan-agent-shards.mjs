import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planWeightedShards } from './plan-vitest-shard.mjs';

export const AGENT_SHARD_COUNT = 10;
export const AGENT_INTEGRATION_SHARDS = 4;
export const AGENT_UNIT_CONFIG = 'vitest.unit.config.ts';
export const AGENT_INTEGRATION_CONFIG = 'vitest.config.ts';
export const AGENT_TIMINGS = JSON.parse(fs.readFileSync(new URL('./timings/agent.json', import.meta.url), 'utf8'));
export const AGENT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function agentShardConfig(index) {
  if (!Number.isInteger(index) || index < 1 || index > AGENT_SHARD_COUNT) {
    throw new Error('Agent shard must be an integer from 1 to 10');
  }
  return index <= AGENT_INTEGRATION_SHARDS ? AGENT_INTEGRATION_CONFIG : AGENT_UNIT_CONFIG;
}

export function discoverAgentTests(config, repoRoot = AGENT_REPO_ROOT, filters = []) {
  const packageRoot = path.join(repoRoot, 'packages/agent');
  // Ask the actual resolver: filesystem enumeration alone can assign files
  // that a Vitest include/exclude silently drops. `list` runs no globalSetup.
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
    '--dir', packageRoot, 'exec', 'vitest', 'list', '--filesOnly', '--json', '--config', config, ...filters,
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Agent discovery failed for ${config}: ${result.error?.message ?? result.stderr}`);
  }
  const records = JSON.parse(result.stdout);
  if (!Array.isArray(records) || records.length === 0) throw new Error(`No tests discovered by ${config}`);
  const files = records.map(({ file }) => path.relative(packageRoot, path.resolve(packageRoot, file)).split(path.sep).join('/'));
  if (files.some((file) => !file.startsWith('test/') || !file.endsWith('.test.ts'))
      || new Set(files).size !== files.length) {
    throw new Error(`Unexpected or duplicate test paths from ${config}`);
  }
  return files.sort();
}

export function planAgentShards(repoRoot = AGENT_REPO_ROOT, { discover = discoverAgentTests } = {}) {
  const allFiles = discover(AGENT_INTEGRATION_CONFIG, repoRoot);
  const unitFiles = discover(AGENT_UNIT_CONFIG, repoRoot);
  const all = new Set(allFiles);
  const unit = new Set(unitFiles);
  if (unitFiles.some((file) => !all.has(file))) {
    throw new Error('Agent unit config includes files outside the primary test inventory');
  }
  const groups = [
    { files: allFiles.filter((file) => !unit.has(file)), count: AGENT_INTEGRATION_SHARDS, offset: 0 },
    { files: unitFiles, count: AGENT_SHARD_COUNT - AGENT_INTEGRATION_SHARDS, offset: AGENT_INTEGRATION_SHARDS },
  ];
  return groups.flatMap(({ files, count, offset }) => planWeightedShards({
    files,
    bodyWeightsMs: AGENT_TIMINGS.bodyWeightsMs,
    shardCount: count,
    perFileOverheadMs: AGENT_TIMINGS.perFileOverheadMs,
    // The last shard also generates Gate 1 and rollout-transition evidence.
    shardOverheadMs: Array.from({ length: count }, (_, index) => offset + index + 1 === 10 ? 40_000 : 0),
  }).map((shard) => ({
    ...shard,
    index: shard.index + offset,
    config: agentShardConfig(shard.index + offset),
  })));
}
