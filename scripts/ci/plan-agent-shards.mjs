import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planWeightedShards } from './plan-vitest-shard.mjs';
import { loadAgentTimings } from './load-agent-timings.mjs';

export const AGENT_UNIT_CONFIG = 'vitest.unit.config.ts';
export const AGENT_INTEGRATION_CONFIG = 'vitest.config.ts';
const TIMINGS = loadAgentTimings(new URL('./timings/agent.json', import.meta.url));
export const AGENT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Each entry is one runner. Configuration, indices and reserved work all
// derive from this policy; the final unit runner owns the evidence sidecars.
const LANES = [
  { config: AGENT_INTEGRATION_CONFIG, inventory: 'integration', overheadMs: [0, 0, 0, 0] },
  { config: AGENT_UNIT_CONFIG, inventory: 'unit', overheadMs: [0, 0, 0, 0, 0, 40_000] },
];
const DESCRIPTORS = Object.freeze(LANES.flatMap((lane) => lane.overheadMs.map((reservedOverheadMs) => ({
  config: lane.config, inventory: lane.inventory, reservedOverheadMs,
}))).map((shard, index) => Object.freeze({ ...shard, index: index + 1 })));
export const AGENT_SHARD_COUNT = DESCRIPTORS.length;

export function agentShardDescriptor(index) {
  if (!Number.isInteger(index) || index < 1 || index > AGENT_SHARD_COUNT) {
    throw new Error(`Agent shard must be an integer from 1 to ${AGENT_SHARD_COUNT}`);
  }
  return DESCRIPTORS[index - 1];
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
  const inventories = {
    integration: allFiles.filter((file) => !unit.has(file)),
    unit: unitFiles,
  };
  return LANES.flatMap((lane) => {
    const descriptors = DESCRIPTORS.filter((shard) => shard.inventory === lane.inventory);
    return planWeightedShards({
      files: inventories[lane.inventory],
      ...TIMINGS,
      shardCount: descriptors.length,
      shardOverheadMs: descriptors.map((shard) => shard.reservedOverheadMs),
    }).map((shard, index) => ({ ...shard, ...descriptors[index] }));
  });
}
