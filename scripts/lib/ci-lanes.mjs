import { AGENT_SHARD_POLICY } from '../ci/agent-shard-policy.mjs';

/** Executable candidate topology: consumed by Actions matrices, runners and receipt aggregation.
 * The immutable controller still owns whether a lane may run or skip.
 * Agent subdivisions come from its existing timing/overhead policy, without a second count.
 */
export const CI_LANE_TOPOLOGY = {
  tornado_core: { job: 'tornado-core', groups: [
    { id: 'core', packages: ['core', 'http-utils', 'rdf-utils', 'storage'], shards: 1, label: 'core + RDF + storage' },
    { id: 'chain', packages: ['chain'], shards: 3, runner: 'weighted' },
  ] },
  tornado_blazegraph: { job: 'tornado-blazegraph' },
  tornado_publisher: { job: 'tornado-publisher', groups: [{ id: 'publisher', packages: ['publisher'], shards: 4, runner: 'vitest' }] },
  tornado_agent: { job: 'tornado-agent', groups: [{ id: 'agent', packages: ['agent'], shards: AGENT_SHARD_POLICY.descriptors.length, runner: 'agent' }] },
  bura_cli: { job: 'bura-cli', groups: [{ id: 'cli', packages: ['cli'], shards: 4, runner: 'weighted' }] },
  bura_blazegraph_arm64: { job: 'bura-blazegraph-arm64' },
  bura_query: { job: 'bura-supporting', groups: [{ id: 'query', packages: ['query'], shards: 1 }] },
  kosava_node_ui: { job: 'kosava-node-ui', groups: [{ id: 'node-ui', packages: ['node-ui'], shards: 1 }] },
  kosava_node_ui_e2e: { job: 'kosava-node-ui-e2e' },
  kosava_supporting: { job: 'kosava-supporting', groups: [{
    id: 'supporting', shards: 1, concurrency: 3, maxWorkers: 2,
    packages: ['epcis', 'mcp-dkg', 'local-llm', 'network-sim', 'graph-viz', 'okf', 'adapter-elizaos', 'adapter-hermes', 'adapter-openclaw', 'adapter-prime-agent'],
  }] },
  kosava_hardhat_plugins: { job: 'kosava-hardhat-plugins', groups: [{ id: 'plugins', packages: ['random-sampling', 'kafka-plugin'], shards: 1 }] },
};

export function compileCiTopology(topology = CI_LANE_TOPOLOGY) {
  const jobs = {};
  const matrices = {};
  const packageCounts = {};
  for (const { job, groups } of Object.values(topology)) {
    if (!groups) continue;
    const rows = [];
    const packages = {};
    for (const group of groups) {
      if (!Number.isSafeInteger(group.shards) || group.shards < 1 || !group.packages?.length) throw new Error(`invalid CI group ${job}/${group.id}`);
      if (group.shards > 1 && (group.packages.length !== 1 || !['vitest', 'weighted', 'agent'].includes(group.runner))) throw new Error(`invalid sharded runner ${job}/${group.id}`);
      for (const name of group.packages) {
        if (Object.hasOwn(packageCounts, name)) throw new Error(`duplicate coverage package ${name}`);
        packages[name] = packageCounts[name] = group.shards;
      }
      for (let index = 0; index < group.shards; index++) rows.push({
        row: rows.length, suite: group.id, shard: group.shards === 1 ? 0 : index + 1, shards: group.shards,
        label: group.shards === 1 ? group.label ?? group.id : `${group.id} [${index + 1}/${group.shards}]`,
        gate1: group.runner === 'agent' && AGENT_SHARD_POLICY.descriptors[index]?.reservedOverheadMs > 0,
      });
    }
    jobs[job] = packages;
    matrices[job] = { include: rows };
  }
  return { jobs, matrices, packageCounts };
}

export const NODE_EVM_LANES = Object.freeze(Object.keys(CI_LANE_TOPOLOGY));
export const PRIMARY_LANE_JOBS = Object.freeze(Object.fromEntries(Object.entries(CI_LANE_TOPOLOGY).map(([lane, { job }]) => [lane, job])));
const compiled = compileCiTopology();
export const COVERAGE_JOBS = compiled.jobs;
export const CI_MATRICES = compiled.matrices;
export const PACKAGE_SHARD_COUNTS = compiled.packageCounts;

export function ciJobRow(job, index = 0, topology = CI_LANE_TOPOLOGY) {
  const row = compileCiTopology(topology).matrices[job]?.include[index];
  if (!Number.isInteger(index) || !row) throw new Error(`unknown CI row ${job}/${index}`);
  const { groups } = Object.values(topology).find((entry) => entry.job === job);
  return { ...groups.find((group) => group.id === row.suite), ...row };
}
