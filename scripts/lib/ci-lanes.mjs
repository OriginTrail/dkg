/** Candidate-side lane topology. The immutable CI controller remains unchanged. */
export const CI_LANE_TOPOLOGY = Object.freeze({
  tornado_core: { job: 'tornado-core', packages: { core: 1, 'http-utils': 1, 'rdf-utils': 1, storage: 1, chain: 3 } },
  tornado_blazegraph: { job: 'tornado-blazegraph' },
  tornado_publisher: { job: 'tornado-publisher', packages: { publisher: 4 } },
  tornado_agent: { job: 'tornado-agent', packages: { agent: 10 } },
  bura_cli: { job: 'bura-cli', packages: { cli: 4 } },
  bura_blazegraph_arm64: { job: 'bura-blazegraph-arm64' },
  bura_query: { job: 'bura-supporting', packages: { query: 1 } },
  kosava_node_ui: { job: 'kosava-node-ui', packages: { 'node-ui': 1 } },
  kosava_node_ui_e2e: { job: 'kosava-node-ui-e2e' },
  kosava_supporting: {
    job: 'kosava-supporting',
    packages: Object.fromEntries(['epcis', 'mcp-dkg', 'local-llm', 'network-sim', 'graph-viz', 'okf', 'adapter-elizaos', 'adapter-hermes', 'adapter-openclaw', 'adapter-prime-agent'].map((name) => [name, 1])),
  },
  kosava_hardhat_plugins: { job: 'kosava-hardhat-plugins', packages: { 'random-sampling': 1, 'kafka-plugin': 1 } },
});
export const NODE_EVM_LANES = Object.freeze(Object.keys(CI_LANE_TOPOLOGY));
export const PRIMARY_LANE_JOBS = Object.freeze(Object.fromEntries(Object.entries(CI_LANE_TOPOLOGY).map(([lane, { job }]) => [lane, job])));
export const COVERAGE_JOBS = Object.freeze(Object.fromEntries(Object.values(CI_LANE_TOPOLOGY).filter(({ packages }) => packages).map(({ job, packages }) => [job, Object.freeze(packages)])));
export const PACKAGE_SHARD_COUNTS = Object.freeze(Object.assign({}, ...Object.values(COVERAGE_JOBS)));
