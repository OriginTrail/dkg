// The routing tables of the trusted CI planner (scripts/lib/ci-delta.mjs):
// which lanes and EVM scopes each workspace, repository support area and
// per-file trigger selects. This file is part of the trusted controller:
// workflows run it from a sparse checkout that contains ONLY the files in
// CONTROLLER_POLICY_FILES (scripts/ci/trusted-controller-pins.mjs), so it
// imports nothing. The routing tests in scripts/lib/__tests__/ check these
// tables against the repository.

export const EVM_SCOPES = Object.freeze(['chain', 'publisher', 'agent']);

// The Playwright suite boots four real daemons and drives node-ui against
// them (7 shards, ~45 runner-minutes). On pull requests it follows the UI
// surface it exercises (node-ui, its graph-viz dependency and the daemon HTTP
// API in cli) and the packages its own harness code compiles against (core,
// which packages/node-ui/e2e imports, and its dependency rdf-utils). The rest
// of the runtime those daemons boot (agent, chain, storage, publisher, query,
// adapters, ...; ci-delta-routing.test.mjs pins the list) is deliberately not
// a PR trigger: its own lanes and bura_cli's daemon tests cover it on the PR,
// and the browser suite still runs for it on every protected push,
// merge-queue candidate and nightly run (full CI) and whenever `ci:full` opts
// a PR in before merging.
//
// The Windows lifecycle job (rfc64-inventory-windows.yml) runs wherever the
// agent lane does: ci.yml starts it on that lane's output and the gate
// requires it with the lane, so no rule names it. Besides the SQLite
// persistence suites it runs the RFC-64 Gate 0 lifecycle and evidence
// harnesses, which start a real agent (agent, core, chain, storage and their
// dependencies) and run on no Linux lane.
export const WORKSPACE_RULES = Object.freeze({
  'packages/core': {
    lanes: [
      'chain_rpc_node26',
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
      'chain_rpc_node26',
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
      'chain_rpc_node26',
      'tornado_core',
      'tornado_blazegraph',
      'tornado_publisher',
      'tornado_agent',
      'bura_cli',
      'bura_query',
      'kosava_node_ui',
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
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    // chain: the DKGAgent the chain scope's node-ui suite starts loads it.
    evmScopes: ['chain', 'publisher', 'agent'],
  },
  'packages/chain': {
    lanes: [
      'chain_rpc_node26',
      'tornado_core',
      'tornado_publisher',
      'tornado_agent',
      'bura_cli',
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
  'packages/node-store': {
    // Protocol persistence split out of node-ui: node-ui re-exports it, so every
    // lane that loads node-ui loads it too (tornado_blazegraph through the CLI's
    // Oxigraph launcher, see packages/cli). Its own tests run in kosava_node_ui
    // and open node-ui's DashboardDB by relative path. Daemon runtime, not UI
    // surface: like the other packages the devnet boots, the browser suite
    // follows it after merge rather than on the PR.
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_node_ui', 'kosava_hardhat_plugins'],
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
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/mcp-dkg': {
    // tornado_blazegraph: loaded by the CLI's Oxigraph launcher (see packages/cli).
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/local-llm': {
    lanes: ['bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/okf': {
    lanes: ['bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-hermes': {
    // tornado_blazegraph: loaded by the CLI's Oxigraph launcher (see packages/cli).
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-openclaw': {
    // tornado_blazegraph: loaded by the CLI's Oxigraph launcher (see packages/cli).
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-prime-agent': {
    // tornado_blazegraph: loaded by the CLI's Oxigraph launcher (see packages/cli).
    lanes: ['tornado_blazegraph', 'bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
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
  'packages/node-store': ['kosava_node_ui'],
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
  // The namespace contract the metadata parser loads, which the arm64 job's
  // contract check runs.
  /^packages\/storage\/blazegraph-namespace-contract\.cjs$/,
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
  /^packages\/node-ui\/src\/ui\/(?:lib\/(?:nativeGasSymbol|apiToken)|stores\/wallet)\.ts$/,
  /^packages\/node-ui\/integration\/identity-wallet-actions-v10\.test\.ts$/,
  // The daemon route the suite drives and the CLI modules it loads.
  /^packages\/cli\/src\/daemon\/routes\/(?:identity-wallets|restricted-browser-wallet-rpc)\.ts$/,
  /^packages\/cli\/src\/(?:daemon\/http-utils|daemon\/read-authority-diagnostics|auth|boolean-env-override|config|entity-search\/types|oxigraph-memory-limits|runtime-assets)\.ts$/,
];

// File-level triggers: lanes or EVM scopes that specific paths select on top
// of the rule for the area that owns them (a workspace or a support route). A
// path outside every area is classified by its triggers alone, and a path a
// trigger claims is a CI input, never documentation. Per-file refinements
// belong in this table, never as special cases inside planCi.
// ci-delta-routing.test.mjs follows every relative reference from the files
// each lane runs and fails when a file it reaches does not select that lane.
// What pnpm install runs in every job, inside the package workspaces: the one
// table the planner and the load-closure test both read, as explicit
// variants that installDependency builds and checks:
// - entrypoint(path): a file an install hook runs or loads;
// - repositoryRead(reader, name, path): a file `reader` reads as `name` from
//   a directory it builds at run time, which is the repository's `path`;
// - exemption(reader, name, reason): such a read that names no repository
//   input, and why.
// The planner reads only INSTALL_HOOK_INPUTS, the entrypoints' and repository
// reads' paths: a change to one needs full CI, as a change to an install hook
// does. The routing test checks the install scripts read exactly what the
// reads and exemptions say.
const nonEmpty = (value, field) => {
  if (typeof value !== 'string' || value === '') throw new Error(`an install dependency needs a ${field}`);
  return value;
};
export const installDependency = Object.freeze({
  entrypoint: (path) => Object.freeze({ kind: 'entrypoint', path: nonEmpty(path, 'path') }),
  repositoryRead: (reader, name, path) => Object.freeze({
    kind: 'repositoryRead', reader: nonEmpty(reader, 'reader'), name: nonEmpty(name, 'name'), path: nonEmpty(path, 'path'),
  }),
  exemption: (reader, name, reason) => Object.freeze({
    kind: 'exemption', reader: nonEmpty(reader, 'reader'), name: nonEmpty(name, 'name'), reason: nonEmpty(reason, 'reason'),
  }),
});
const { entrypoint, repositoryRead, exemption } = installDependency;
const MARKITDOWN_BUNDLER = 'packages/cli/scripts/bundle-markitdown-binaries.mjs';
export const INSTALL_HOOK_DEPENDENCIES = Object.freeze([
  // The root and CLI preinstall, the CLI postinstall, and what they load.
  entrypoint('packages/cli/scripts/verify-node-sqlite-runtime.mjs'),
  entrypoint(MARKITDOWN_BUNDLER),
  entrypoint('packages/cli/scripts/markitdown-bundle-validation.mjs'),
  entrypoint('packages/cli/markitdown-build-info.json'),
  // What they read from directories they build at run time.
  repositoryRead(MARKITDOWN_BUNDLER, 'markitdown-targets.json', 'packages/cli/markitdown-targets.json'),
  repositoryRead(MARKITDOWN_BUNDLER, 'scripts/markitdown-entry.py', 'packages/cli/scripts/markitdown-entry.py'),
  repositoryRead(MARKITDOWN_BUNDLER, 'project.json', 'project.json'),
  // The postinstall skips the release download only in a workspace checkout,
  // which it tells by the CLI's tsconfig.json (isWorkspaceCheckout): without
  // it, every job's install downloads a binary for its platform. The CLI's
  // markitdown test packs the CLI to check the published package leaves it
  // out.
  repositoryRead(MARKITDOWN_BUNDLER, 'tsconfig.json', 'packages/cli/tsconfig.json'),
  exemption(
    MARKITDOWN_BUNDLER,
    'package.json',
    "the CLI's version, which names the release binary an installed package downloads; the manifest fields an install reads (install hooks, dependencies, engines) already route to full CI",
  ),
  exemption(MARKITDOWN_BUNDLER, 'Scripts/python.exe', 'the Python virtual environment a source build creates, outside the repository'),
  exemption('packages/cli/scripts/verify-node-sqlite-runtime.mjs', '../package.json', "the CLI's engines.node range; an engines change already routes to full CI"),
]);
// The files whose change needs full CI because an install runs or reads them:
// the entrypoints' and repository reads' paths. A dependency of another kind
// throws, so the planner never skips one.
export function installHookInputs(dependencies) {
  return Object.freeze([...new Set(dependencies.flatMap((dependency) => {
    switch (dependency.kind) {
      case 'entrypoint':
      case 'repositoryRead':
        return [dependency.path];
      case 'exemption':
        return [];
      default:
        throw new Error(`unknown install dependency: ${JSON.stringify(dependency)}`);
    }
  }))]);
}
export const INSTALL_HOOK_INPUTS = installHookInputs(INSTALL_HOOK_DEPENDENCIES);

export const PATH_TRIGGERS = Object.freeze([
  {
    patterns: [/^test-policy\/(?:README\.md|test-routes\.json)$/],
    lanes: ['chain_rpc_node26'],
    evmScopes: [],
    reason: 'supported-runtime regression policy changed',
  },
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
    patterns: [/^packages\/agent\/src\/sync\/(?:exact-assets|exact-batch-stream-contract|wire-compression)\.ts$/],
    lanes: ['tornado_core'],
    evmScopes: [],
    reason: 'the Core stream transport tests import the Agent production codec',
  },
  {
    patterns: [/^packages\/cli\/src\/extraction\/markdown-extractor\.ts$/],
    lanes: ['tornado_agent'],
    evmScopes: [],
    reason: 'the agent memory-layer tests import the CLI markdown extractor',
  },
  {
    patterns: [/^packages\/cli\/src\/(?:auth|boolean-env-override|config|entity-search\/types|oxigraph-memory-limits|runtime-assets)\.ts$/],
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
// unknown workflow paths, devnet install inputs, repository scripts outside
// the known families). Every other entry selects
// the lanes that actually load the area in CI (a CI job running it, or a
// package referencing it, directly or through another support file; the
// routing tests follow those imports) plus the shared build job's own checks
// (`buildChecks`): its lint,
// repository-script tests and test-inventory checks cover these files, and for
// routes with no lanes they are the only CI consumer (the suites are manual or
// have their own workflow).
// Repository scripts known to run only in the shared build job or by hand, by
// family: exact script names, file-name prefixes with the extensions they
// take, and whole directories under scripts/. The load-closure test fails if
// a lane reads or runs one, or assembles a script path it cannot resolve, and
// an inventory test requires every name to exist and every prefix and
// directory to be the first route for an existing script.
export const BUILD_ONLY_SCRIPTS = Object.freeze([
  {
    reason: 'devnet suites and operations run by hand, checked by the shared build job',
    prefixes: [{ prefix: 'devnet-', extensions: ['sh', 'mjs'] }],
    files: [
      '_devnet-full-sweep.sh',
      'dkg-claude.sh',
      'epcis-smoke-test.sh',
      'libp2p-soak-test.sh',
      'publisher-smoke-test.sh',
      'seed-demo.sh',
      'swm-soak-orchestrate.sh',
      'swm-soak-test.sh',
      'two-laptop-test.sh',
      'v10-rc-validation.sh',
    ],
  },
  {
    reason: 'repository checks the shared build job runs',
    prefixes: [{ prefix: 'audit-', extensions: ['mjs', 'test.mjs'] }],
    files: ['check-npm-metadata.mjs', 'release-packages.mjs', 'verify-w1-packet.mjs'],
  },
  {
    reason: 'operator and data tools run by hand, checked by the shared build job',
    prefixes: [
      { prefix: 'debug-neuroweb', extensions: ['ts'] },
      { prefix: 'dkg-v10-', extensions: ['mjs'] },
      { prefix: 'import-', extensions: ['mjs'] },
      { prefix: 'publisher-epoch-snapshot', extensions: ['ts'] },
    ],
    files: [
      'backfill-rs-percgid-meta.mjs',
      'chain-analysis.ts',
      'distribute-publisher-trac.ts',
      'drain-swm-duplicates.mjs',
      'epoch-snapshot.ts',
      'generate-aggregates.ts',
      'generate-random-findings-nt.mjs',
      'redistribute-memory.mjs',
      'register-laptop2-agent.mjs',
      'seed-dkg-code-project.mjs',
      'update-repo-refs.js',
      'verify-addresses.ts',
      'verify-agent-provenance-deployment.mjs',
    ],
    directories: ['load', 'repro', 'testnet-publish-stress'],
  },
]);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The route pattern for scripts under scripts/: an exact name, a prefix
// followed by word characters or hyphens and one of its extensions, or
// anything under a directory.
export function scriptsPattern({ files = [], prefixes = [], directories = [] }) {
  const alternatives = [
    ...files.map(escapeRegExp),
    ...prefixes.map(({ prefix, extensions }) => `${escapeRegExp(prefix)}[\\w-]*\\.(?:${extensions.map(escapeRegExp).join('|')})`),
    ...directories.map((directory) => `${escapeRegExp(directory)}\\/.+`),
  ];
  return new RegExp(`^scripts\\/(?:${alternatives.join('|')})$`);
}

export const SUPPORT_PATH_ROUTES = Object.freeze([
  {
    // The repository-script tests (and their helpers and fixtures) run only in
    // the shared build job's script-test step.
    pattern: /^scripts\/lib\/__tests__\//,
    lanes: [],
    reason: 'repository script tests run in the shared build job',
  },
  {
    // CI tooling (planner-adjacent scripts, lane runners, shared CI libraries)
    // and the fixtures package tests declare as shared inputs: every lane can
    // depend on them.
    pattern: /^scripts\/(?:ci|lib|testing)\//,
    full: 'Global CI input changed',
  },
  {
    // The EVM integration runner every EVM scope uses, and the runtime-asset
    // copy the CLI package's build and prepack run, which everything using the
    // built CLI depends on.
    pattern: scriptsPattern({ files: ['test-evm-integration.sh', 'run-evm-integration.mjs', 'copy-cli-runtime-assets.mjs'] }),
    full: 'Global CI input changed',
  },
  {
    // The devnet bootstrap: the browser suite's Playwright setup, the devnet
    // harnesses and the CLI's Blazegraph smoke fixture (which sources it) run it.
    pattern: /^scripts\/devnet\.sh$/,
    lanes: ['kosava_node_ui_e2e', 'tornado_agent', 'bura_cli'],
    reason: 'the browser suite, the devnet harnesses and the CLI Blazegraph smoke fixture run the devnet bootstrap',
  },
  {
    pattern: /^scripts\/devnet-publish-helpers\.sh$/,
    lanes: ['bura_cli'],
    reason: 'the CLI devnet-publish smoke test runs the publish helpers',
  },
  {
    // packages/chain/test/sync-chain-abis.unit.test.ts runs a copy of it against
    // temporary ABI directories.
    pattern: /^scripts\/sync-chain-abis\.mjs$/,
    lanes: ['tornado_core'],
    reason: 'the chain lane runs the ABI sync script against temporary directories',
  },
  ...BUILD_ONLY_SCRIPTS.map((family) => ({ pattern: scriptsPattern(family), lanes: [], reason: family.reason })),
  {
    // Any other script, including a new one: its consumers are not known, so it
    // fails closed (the build, install hooks and other workflows' scripts too).
    pattern: /^scripts\//,
    full: 'Repository script outside the known build-only families changed',
  },
  {
    // Coverage baselines, read by the root vitest.coverage.ts every lane uses.
    pattern: /^test-policy\/coverage-baselines\.json$/,
    full: 'Global CI input changed',
  },
  {
    // The authority mutation pilot: the core job's `pnpm test:mutation` runs
    // Stryker with this configuration, which names the vitest config it runs.
    pattern: /^test-policy\/(?:stryker\.config\.mjs|vitest\.mutation\.config\.ts)$/,
    lanes: ['tornado_core'],
    reason: 'the core job runs the mutation pilot with these configurations',
  },
  {
    // The disabled-test allowlist and test routes, read by the build job's lint
    // and test inventory.
    pattern: /^test-policy\//,
    lanes: [],
    reason: 'test policy is checked by the shared build job',
  },
  {
    // Workflows whose jobs, conditions and gates define what "CI gate" means.
    // Other top-level workflows run (or are linted) on their own.
    pattern: /^\.github\/workflows\/(?:ci|evm-integration|rfc64-inventory-windows|chain-rpc-node26)\.yml$/,
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
    // evidence harnesses (rfc64-persistence-lifecycle, _bootstrap) run in the
    // Windows job and the Gate 1 rollout tests in the Blazegraph job; both
    // follow the agent lane.
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
