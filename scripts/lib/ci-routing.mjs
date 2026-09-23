// The routing tables of the trusted CI planner (scripts/lib/ci-delta.mjs):
// which lanes and EVM scopes each workspace, repository support area and
// per-file trigger selects. This file is part of the trusted controller:
// workflows run it from a sparse checkout that contains ONLY the files in
// CONTROLLER_POLICY_FILES (scripts/ci/trusted-controller-pins.mjs), so it
// imports nothing. The routing tests in scripts/lib/__tests__/ check these
// tables against the repository.

export const EVM_SCOPES = Object.freeze(['chain', 'publisher', 'agent']);

export const WORKSPACE_RULES = Object.freeze({
  'packages/core': {
    lanes: [
      'tornado_core',
      'tornado_blazegraph',
      'tornado_publisher',
      'tornado_agent',
      'bura_cli',
      'bura_query',
      'kosava_node_ui',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: EVM_SCOPES,
  },
  'packages/rdf-utils': {
    lanes: [
      'tornado_core',
      'tornado_blazegraph',
      'tornado_publisher',
      'tornado_agent',
      'bura_cli',
      'bura_query',
      'kosava_node_ui',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: EVM_SCOPES,
  },
  'packages/http-utils': {
    lanes: [
      'tornado_core',
      'tornado_blazegraph',
      'tornado_publisher',
      'tornado_agent',
      'bura_cli',
      'bura_query',
      'kosava_node_ui',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: EVM_SCOPES,
  },
  'packages/storage': {
    // kosava_node_ui: node-ui tests import storage source by relative path.
    lanes: [
      'tornado_core',
      'tornado_blazegraph',
      'tornado_publisher',
      'tornado_agent',
      'bura_cli',
      'bura_query',
      'kosava_node_ui',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    // chain: the DKGAgent the chain scope's node-ui suite starts loads it.
    evmScopes: ['chain', 'publisher', 'agent'],
  },
  'packages/chain': {
    lanes: [
      'tornado_core',
      'tornado_publisher',
      'tornado_agent',
      'bura_cli',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: EVM_SCOPES,
  },
  'packages/query': {
    lanes: [
      'tornado_publisher',
      'tornado_agent',
      'bura_cli',
      'bura_query',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    // chain: the DKGAgent the chain scope's node-ui suite starts loads it.
    evmScopes: ['chain', 'publisher', 'agent'],
  },
  'packages/publisher': {
    lanes: [
      'tornado_publisher',
      'tornado_agent',
      'bura_cli',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    // chain: the DKGAgent the chain scope's node-ui suite starts loads it.
    evmScopes: ['chain', 'publisher', 'agent'],
  },
  'packages/random-sampling': {
    lanes: [
      'tornado_agent',
      'bura_cli',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    // chain: the DKGAgent the chain scope's node-ui suite starts loads it.
    evmScopes: ['chain', 'agent'],
  },
  'packages/agent': {
    lanes: [
      'tornado_agent',
      'bura_cli',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    // chain: the chain scope's node-ui identity-wallet suite starts a DKGAgent.
    evmScopes: ['chain', 'agent'],
  },
  'packages/cli': {
    // tornado_blazegraph: that job's storage conformance suite runs the CLI's
    // built Oxigraph launcher (test-systems/storage-conformance.test.ts),
    // which loads the daemon status route and, through it and the local agent
    // registry, node-ui, graph-viz, mcp-dkg and the three agent adapters.
    // kosava_node_ui: node-ui tests scan the CLI daemon sources
    // (packages/node-ui/test/helpers/read-cli-daemon.ts).
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_node_ui', 'kosava_node_ui_e2e', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/node-ui': {
    // tornado_blazegraph: loaded by the CLI's Oxigraph launcher (see packages/cli).
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_node_ui', 'kosava_node_ui_e2e', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/graph-viz': {
    // tornado_blazegraph: loaded by the CLI's Oxigraph launcher (see packages/cli).
    lanes: [
      'tornado_blazegraph',
      'bura_cli',
      'kosava_node_ui',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: [],
  },
  'packages/epcis': {
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/mcp-dkg': {
    // tornado_blazegraph: loaded by the CLI's Oxigraph launcher (see packages/cli).
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/local-llm': {
    lanes: ['bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/okf': {
    lanes: ['bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-hermes': {
    // tornado_blazegraph: loaded by the CLI's Oxigraph launcher (see packages/cli).
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-openclaw': {
    // tornado_blazegraph: loaded by the CLI's Oxigraph launcher (see packages/cli).
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-prime-agent': {
    // tornado_blazegraph: loaded by the CLI's Oxigraph launcher (see packages/cli).
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-elizaos': {
    lanes: ['kosava_supporting'],
    evmScopes: [],
  },
  'packages/network-sim': {
    lanes: ['kosava_supporting'],
    evmScopes: [],
  },
  'packages/kafka-plugin': {
    lanes: ['kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/evm-module': {
    forceFull: true,
    lanes: [],
    evmScopes: EVM_SCOPES,
  },
  demo: {
    lanes: ['kosava_supporting'],
    evmScopes: [],
  },
});

// Each workspace's direct test owner. The routing test computes the reverse
// workspace dependency graph and proves that every rule includes the owners of
// all current downstream consumers. Explicit integration lanes remain in
// WORKSPACE_RULES in addition to this mechanically checked minimum.
export const WORKSPACE_OWNING_LANES = Object.freeze({
  'packages/core': ['tornado_core'],
  'packages/http-utils': ['tornado_core'],
  'packages/rdf-utils': ['tornado_core'],
  'packages/storage': ['tornado_core', 'tornado_blazegraph'],
  'packages/chain': ['tornado_core'],
  'packages/query': ['bura_query'],
  'packages/publisher': ['tornado_publisher'],
  'packages/random-sampling': ['kosava_hardhat_plugins'],
  'packages/agent': ['tornado_agent'],
  'packages/cli': ['bura_cli'],
  'packages/node-ui': ['kosava_node_ui'],
  'packages/graph-viz': ['kosava_supporting'],
  'packages/epcis': ['tornado_blazegraph', 'kosava_supporting'],
  'packages/mcp-dkg': ['kosava_supporting'],
  'packages/local-llm': ['kosava_supporting'],
  'packages/okf': ['kosava_supporting'],
  'packages/adapter-hermes': ['kosava_supporting'],
  'packages/adapter-openclaw': ['kosava_supporting'],
  'packages/adapter-prime-agent': ['kosava_supporting'],
  'packages/adapter-elizaos': ['kosava_supporting'],
  'packages/network-sim': ['kosava_supporting'],
  'packages/kafka-plugin': ['kosava_hardhat_plugins'],
  'packages/evm-module': ['contracts'],
  demo: ['kosava_supporting'],
});

export const WORKSPACE_OWNING_EVM_SCOPES = Object.freeze({
  'packages/chain': ['chain'],
  'packages/publisher': ['publisher'],
  'packages/agent': ['agent'],
});

// The provisioned Blazegraph image contract: the pinned image metadata, the
// CLI code that provisions it and its tests. Verified natively on arm64.
const BLAZEGRAPH_ARM64_PATTERNS = [
  /^blazegraph-image\.json$/,
  /^packages\/cli\/blazegraph-image-metadata\.cjs$/,
  /^packages\/cli\/(?:src|test)\/.*blazegraph.*\.(?:[cm]?[jt]s|json)$/i,
];

// Source of truth for WHAT this protects: EVM_TEST_SCOPES.chain.files in
// scripts/ci/evm-test-scopes.mjs — packages/chain/test/evm-adapter.test.ts plus
// ../node-ui/integration/identity-wallet-actions-v10.test.ts. That module
// cannot be imported here: the planner runs from the trusted-controller sparse
// checkout, whose file list is pinned to CONTROLLER_POLICY_FILES in
// scripts/ci/trusted-controller-pins.mjs and enforced by sparseCheckoutPaths(),
// so importing any other file hard-fails every workflow that runs it. The
// manifest names the test files the chain scope RUNS; the patterns below name
// the SOURCE changes that must trigger it: the node-ui suite and everything it
// loads outside chain and agent, whose rules select the scope themselves.
// scripts/lib/__tests__/ci-delta-routing.test.mjs derives that set from the
// suite's imports and fails when a file it loads is missing here.
const IDENTITY_WALLET_EVM_PATTERNS = [
  /^packages\/node-ui\/src\/ui\/web3\//,
  /^packages\/node-ui\/src\/ui\/pages\/identity-wallets\//,
  /^packages\/node-ui\/src\/ui\/(?:api|http|identity-wallet-api|pca-api)\.ts$/,
  /^packages\/node-ui\/src\/ui\/(?:lib\/nativeGasSymbol|stores\/wallet)\.ts$/,
  /^packages\/node-ui\/integration\/identity-wallet-actions-v10\.test\.ts$/,
  // The daemon route the suite drives and the CLI modules it loads.
  /^packages\/cli\/src\/daemon\/routes\/(?:identity-wallets|restricted-browser-wallet-rpc)\.ts$/,
  /^packages\/cli\/src\/(?:daemon\/http-utils|auth|config|oxigraph-memory-limits|runtime-assets)\.ts$/,
];

// File-level triggers: lanes or EVM scopes that specific paths select on top
// of the rule for the area that owns them (a workspace or a support route). A
// path outside every area is classified by its triggers alone, and a path a
// trigger claims is a CI input, never documentation. Per-file refinements
// belong in this table, never as special cases inside planCi.
// ci-delta-routing.test.mjs follows every relative reference from the files
// each lane runs and fails when a file it reaches does not select that lane.
export const PATH_TRIGGERS = Object.freeze([
  {
    patterns: BLAZEGRAPH_ARM64_PATTERNS,
    lanes: ['bura_cli', 'bura_blazegraph_arm64'],
    evmScopes: [],
    reason: 'Blazegraph provisioning contract changed',
  },
  {
    patterns: IDENTITY_WALLET_EVM_PATTERNS,
    lanes: [],
    evmScopes: ['chain'],
    reason: 'identity-wallet browser actions require real EVM coverage',
  },
  // Documents that tests read and assert on.
  {
    patterns: [/^RELEASE_PROCESS\.md$/],
    lanes: ['bura_cli'],
    evmScopes: [],
    reason: 'the CLI release tests assert the release process document',
  },
  {
    patterns: [/^packages\/query\/README\.md$/],
    lanes: ['bura_query'],
    evmScopes: [],
    reason: 'the query security tests assert the query README',
  },
  // Files other packages load by relative path, outside their declared
  // dependencies.
  {
    patterns: [/^packages\/cli\/src\/extraction\/markdown-extractor\.ts$/],
    lanes: ['tornado_agent'],
    evmScopes: [],
    reason: 'the agent memory-layer tests import the CLI markdown extractor',
  },
  {
    patterns: [/^packages\/cli\/src\/(?:auth|config|oxigraph-memory-limits|runtime-assets)\.ts$/],
    // The EPCIS lanes are Blazegraph and supporting; the CLI rule already
    // selects Blazegraph.
    lanes: ['kosava_supporting'],
    evmScopes: [],
    reason: 'the EPCIS API tests import the CLI auth and config modules',
  },
  {
    patterns: [/^packages\/cli\/skills\/dkg-node\/SKILL\.md$/],
    lanes: ['kosava_supporting'],
    evmScopes: [],
    reason: 'the OpenClaw adapter entry loads the CLI node skill',
  },
  {
    // packages/chain/test/context-graph-authority-rpc-site-census.unit.test.ts
    // reads these sources and asserts their authority RPC call sites.
    patterns: [
      /^packages\/agent\/src\/dkg-agent-(?:cg-registry|context-graph|join|lifecycle|query)\.ts$/,
      /^packages\/publisher\/src\/workspace-handler\.ts$/,
      /^packages\/cli\/src\/daemon\/routes\/(?:memory|query-catalog)\.ts$/,
    ],
    lanes: ['tornado_core'],
    evmScopes: [],
    reason: 'the chain RPC-site census asserts their authority call sites',
  },
]);

// Repository areas outside the package workspaces, in first-match order. An
// entry with `full` keeps full CI with its own reason (the CI control plane,
// unknown workflow paths, devnet install inputs). Every other entry selects
// the lanes that actually execute the area in CI (ci.yml and its reusable
// workflows) plus the shared build job's own checks (`buildChecks`): its lint,
// repository-script tests and test-inventory checks cover these files, and for
// routes with no lanes they are the only CI consumer (the suites are manual or
// have their own workflow).
export const SUPPORT_PATH_ROUTES = Object.freeze([
  {
    // Workflows whose jobs, conditions and gates define what "CI gate" means.
    // Other top-level workflows run (or are linted) on their own.
    pattern: /^\.github\/workflows\/(?:ci|evm-integration|rfc64-inventory-windows)\.yml$/,
    full: 'CI control-plane workflow changed',
  },
  {
    // GitHub only runs top-level workflow files; anything nested is unknown.
    pattern: /^\.github\/workflows\/[^/]+\//,
    full: 'Unrecognised path under .github/workflows',
  },
  {
    pattern: /^\.github\/actions\//,
    full: 'Composite action used by CI jobs changed',
  },
  {
    // devnet suites are pnpm workspaces: their manifests are install inputs.
    pattern: /^devnet\/[^/]+\/package\.json$/,
    full: 'Devnet workspace manifest changed',
  },
  {
    // The CLI's harness-only `rfc64-gate2-adapter` command loads
    // adapter-process.ts, which imports the shared rfc64-runtime-* modules and
    // the CP2 batch planning; agent fixtures import the Gate 2 runtime hooks.
    pattern: /^devnet\/(?:rfc64-gate2-multi-asset-completeness\/|rfc64-cp2-private-swm-vm-recovery\/|rfc64-runtime-[^/]+$)/,
    lanes: ['tornado_agent', 'bura_cli'],
    reason: 'RFC-64 Gate 2 adapter (started by the CLI) and the modules it loads',
  },
  {
    // Devnet harnesses are built on the agent, and agent tests, fixtures and
    // packages/agent/devnet import several of them. The Gate 0 lifecycle and
    // evidence harnesses run in the Windows job and the Gate 1 rollout tests
    // in the Blazegraph job; ci.yml selects both through tornado_agent.
    pattern: /^devnet\//,
    lanes: ['tornado_agent'],
    reason: 'devnet harnesses are imported by agent tests and fixtures',
  },
  {
    pattern: /^test-systems\//,
    lanes: ['tornado_blazegraph'],
    reason: 'storage conformance runs in the Blazegraph lane',
  },
  {
    // The CLI benchmark tests import the esbench suites and their support.
    pattern: /^bench\//,
    lanes: ['bura_cli'],
    reason: 'benchmarks are imported by the CLI benchmark tests',
  },
  {
    pattern: /^tools\//,
    lanes: [],
    reason: 'operator tools are checked by the shared build job only',
  },
  {
    // Remaining .github inputs: workflows outside the CI control plane,
    // CODEOWNERS, templates and scanner configuration read by repository
    // tooling tests. Control-plane workflows and actions are global above.
    pattern: /^\.github\//,
    lanes: [],
    reason: 'repository automation config is checked by the shared build job only',
  },
]);
