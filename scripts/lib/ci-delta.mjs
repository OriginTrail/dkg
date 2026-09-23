import { isDeepStrictEqual } from 'node:util';

// This module is part of the trusted CI controller: workflows run it from a
// sparse checkout that contains ONLY the files in CONTROLLER_POLICY_FILES
// (scripts/ci/trusted-controller-pins.mjs). It may import node: builtins and
// the other controller files, nothing else, or every planner run fails with
// ERR_MODULE_NOT_FOUND and the pin can never be rotated. The executable lane
// topology in ci-lanes.mjs is checked against this map instead.
//
// It is deliberately one policy module (lane map, routing tables, manifest
// classification, plan shape and outputs): every controller file widens the
// security-reviewed sparse checkout that four workflow checkouts pin. If it
// grows past ~1,000 lines, move the routing tables (WORKSPACE_RULES,
// SUPPORT_PATH_ROUTES, PATH_TRIGGERS) into a sibling controller file and add
// it to CONTROLLER_POLICY_FILES and every trusted checkout in one change.
export const PRIMARY_LANE_JOBS = Object.freeze({
  tornado_core: 'tornado-core',
  tornado_blazegraph: 'tornado-blazegraph',
  tornado_publisher: 'tornado-publisher',
  tornado_agent: 'tornado-agent',
  bura_cli: 'bura-cli',
  bura_blazegraph_arm64: 'bura-blazegraph-arm64',
  bura_query: 'bura-supporting',
  kosava_node_ui: 'kosava-node-ui',
  kosava_node_ui_e2e: 'kosava-node-ui-e2e',
  kosava_supporting: 'kosava-supporting',
  kosava_hardhat_plugins: 'kosava-hardhat-plugins',
});

export const NODE_EVM_LANES = Object.freeze(Object.keys(PRIMARY_LANE_JOBS));

// Lanes whose jobs build what they need on their own runner (the native arm64
// image contract), so selecting them alone never requires the shared Linux
// build.
export const SELF_BUILDING_LANES = Object.freeze(['bura_blazegraph_arm64']);
const NODE_LANES = NODE_EVM_LANES.filter((lane) => !SELF_BUILDING_LANES.includes(lane));

// Whether a plan must run the shared build job: a selected lane consumes its
// outputs, or the plan declared the build job's own repository checks. The
// planner derives runNode from it and the aggregate gate checks against it.
export function needsSharedBuild(plan) {
  return plan.buildChecks === true || NODE_LANES.some((lane) => plan.lanes?.[lane] === true);
}

// `contracts` remains a workflow output for compatibility, but Solidity is an
// independent relevance gate rather than part of the Node/EVM "full" profile.
export const CI_LANES = Object.freeze([...NODE_EVM_LANES, 'contracts']);

export const EVM_SCOPES = Object.freeze(['chain', 'publisher', 'agent']);

// Lanes that restore the shared Hardhat 0.8.20/london compiler outputs.
export const NODE_TEST_ARTIFACT_LANES = Object.freeze([
  'tornado_core', 'tornado_publisher', 'tornado_agent', 'bura_cli', 'kosava_hardhat_plugins',
]);

export function needsNodeTestArtifacts(plan) {
  return NODE_TEST_ARTIFACT_LANES.some((lane) => plan.lanes?.[lane] === true);
}


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

const GLOBAL_FULL_PATHS = new Set([
  '.npmrc',
  '.nvmrc',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'turbo.json',
  'vitest.config.ts',
  'vitest.coverage.ts',
  'vitest.evm-integration.ts',
]);

// Preserve the independent Solidity gate that existed before delta CI, while
// also covering Hardhat-loaded support code that the former paths-filter
// missed. A PR can be promoted to full Node/EVM CI for many reasons without
// making a four-shard Hardhat run relevant, but any production input inside
// evm-module can affect compilation, deployment, or the test environment.
const SOLIDITY_RELEVANT_PATHS = new Set([
  'packages/evm-module/package.json',
  'packages/evm-module/slither.config.json',
  'packages/evm-module/.solhint.json',
  'packages/evm-module/.solhintignore',
  'packages/evm-module/aderyn.toml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.github/workflows/ci.yml',
]);

function isSolidityRelevantPath(filePath) {
  if (
    SOLIDITY_RELEVANT_PATHS.has(filePath)
    || /^packages\/evm-module\/(?:contracts|test|deploy|scripts)\//.test(filePath)
    || /^packages\/evm-module\/hardhat\.[^/]+$/.test(filePath)
  ) {
    return true;
  }

  if (!filePath.startsWith('packages/evm-module/')) return false;

  // Committed ABIs are runtime inputs for Node/EVM integration lanes, but they
  // do not alter Hardhat compile/test behavior. Package documentation is also
  // intentionally excluded unless it lives under a legacy matched directory.
  return !filePath.startsWith('packages/evm-module/abi/')
    && !isDocumentationOnlyPath(filePath);
}

function isAbiFreshnessRelevantPath(filePath) {
  return isSolidityRelevantPath(filePath)
    || /^packages\/evm-module\/abi\/.*\.json$/i.test(filePath);
}

// The provisioned Blazegraph image contract: the pinned image metadata, the
// CLI code that provisions it and its tests. Verified natively on arm64.
const BLAZEGRAPH_ARM64_PATTERNS = [
  /^blazegraph-image\.json$/,
  /^packages\/cli\/blazegraph-image-metadata\.cjs$/,
  /^packages\/cli\/(?:src|test)\/.*blazegraph.*\.(?:[cm]?[jt]s|json)$/i,
];


const MAX_REPORTED_FILES = 200;

// Source of truth for WHAT this protects: EVM_TEST_SCOPES.chain.files in
// scripts/ci/evm-test-scopes.mjs — packages/chain/test/evm-adapter.test.ts plus
// ../node-ui/integration/identity-wallet-actions-v10.test.ts. That module
// cannot be imported here: ci-delta.mjs runs from the trusted-controller sparse
// checkout, whose file list is pinned to CONTROLLER_POLICY_FILES in
// scripts/ci/trusted-controller-pins.mjs and enforced by sparseCheckoutPaths(),
// so a fifth entry hard-fails every workflow that runs the planner. The
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
const PATH_TRIGGERS = Object.freeze([
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
    lanes: ['tornado_blazegraph', 'kosava_supporting'],
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

function pathTriggers(filePath) {
  return PATH_TRIGGERS.filter(({ patterns }) => patterns.some((pattern) => pattern.test(filePath)));
}

function emptyLanes() {
  return Object.fromEntries(CI_LANES.map((lane) => [lane, false]));
}

function classifySolidityRelevance(eventName, changedFiles, diffKnown) {
  const isPullRequest = eventName === 'pull_request'
    || eventName === 'pull_request_delta_disabled';
  if (!isPullRequest || !diffKnown) {
    return { contracts: true, abiFreshnessRelevant: true };
  }
  return {
    contracts: changedFiles.some(isSolidityRelevantPath),
    abiFreshnessRelevant: changedFiles.some(isAbiFreshnessRelevantPath),
  };
}

function fullPlan({
  reasons,
  solidityRelevance,
  changedFiles = [],
}) {
  const lanes = Object.fromEntries(NODE_EVM_LANES.map((lane) => [lane, true]));
  lanes.contracts = solidityRelevance.contracts;
  return {
    mode: 'full',
    fullCi: true,
    runNode: true,
    buildChecks: false,
    abiFreshnessRelevant: solidityRelevance.abiFreshnessRelevant,
    lanes,
    evmScopes: [...EVM_SCOPES],
    changedFileCount: changedFiles.length,
    changedFiles: changedFiles.slice(0, MAX_REPORTED_FILES),
    reasons,
  };
}

function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

const DOCUMENTATION_EXTENSIONS = new Set([
  'docx',
  'gif',
  'jpeg',
  'jpg',
  'md',
  'mdx',
  'pdf',
  'png',
  'svg',
  'txt',
  'webp',
]);

function hasDocumentationExtension(filePath) {
  const extension = filePath.split('.').at(-1)?.toLowerCase();
  return DOCUMENTATION_EXTENSIONS.has(extension);
}

// A document a test reads is a CI input claimed by PATH_TRIGGERS, its one
// home: it leaves the docs-only profile and routes to the reading lanes alone.
function isDocumentationOnlyPath(filePath) {
  return isDocumentationPath(filePath) && pathTriggers(filePath).length === 0;
}

function isDocumentationPath(filePath) {
  if (
    filePath === 'LICENSE'
    || filePath === 'SECURITY.md'
    || filePath === 'CODE_OF_CONDUCT.md'
    || filePath === 'CONTRIBUTING.md'
    || filePath === '.editorconfig'
    || filePath === '.gitignore'
    || /^[^/]+\.(?:md|mdx)$/i.test(filePath)
    || ((filePath.startsWith('docs/') || filePath.startsWith('dkgv10-spec/'))
      && hasDocumentationExtension(filePath))
    || (filePath.startsWith('.changeset/') && hasDocumentationExtension(filePath))
    || (filePath.startsWith('.github/ISSUE_TEMPLATE/')
      && /\.(?:md|ya?ml)$/i.test(filePath))
    || (filePath.startsWith('.github/PULL_REQUEST_TEMPLATE/')
      && /\.md$/i.test(filePath))
  ) {
    return true;
  }

  return /^packages\/[^/]+\/(?:README|CHANGELOG|CONTRIBUTING|LICENSE)(?:\.(?:md|mdx|txt))?$/i.test(filePath)
    || (/^packages\/[^/]+\/docs\//.test(filePath) && hasDocumentationExtension(filePath))
    || /^demo\/(?:README|CHANGELOG|CONTRIBUTING|LICENSE)(?:\.(?:md|mdx|txt))?$/i.test(filePath)
    || (filePath.startsWith('demo/docs/') && hasDocumentationExtension(filePath));
}

function isGlobalFullPath(filePath) {
  return GLOBAL_FULL_PATHS.has(filePath)
    || filePath.startsWith('patches/')
    || filePath.startsWith('scripts/')
    || /^tsconfig(?:\.[^/]+)?\.json$/.test(filePath);
}

// Repository areas outside the package workspaces, in first-match order. An
// entry with `full` keeps full CI with its own reason (the CI control plane,
// unknown workflow paths, devnet install inputs). Every other entry selects
// the lanes that actually execute the area in CI (ci.yml and its reusable
// workflows) plus the shared build job's own checks (`buildChecks`): its lint,
// repository-script tests and test-inventory checks cover these files, and for
// routes with no lanes they are the only CI consumer (the suites are manual or
// have their own workflow).
const SUPPORT_PATH_ROUTES = Object.freeze([
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

function supportPathRoute(filePath) {
  return SUPPORT_PATH_ROUTES.find(({ pattern }) => pattern.test(filePath));
}

// Top-level manifest fields whose change only affects the package itself and
// the downstream consumers its WORKSPACE_RULES entry already selects. Every
// other field, including unknown ones, can change what pnpm installs or how
// the workspace resolves (dependency ranges, pnpm/overrides, engines, bin and
// directories, which can declare bin links and man pages, name, type), so it
// keeps the full profile.
const PACKAGE_SCOPED_MANIFEST_FIELDS = new Set([
  'author',
  'browser',
  'bugs',
  'contributors',
  'description',
  'exports',
  'files',
  'funding',
  'homepage',
  'imports',
  'keywords',
  'license',
  'main',
  'module',
  'private',
  'publishConfig',
  'repository',
  'scripts',
  'sideEffects',
  'types',
  'typesVersions',
  'typings',
  'version',
]);

// Scripts a package manager runs implicitly while installing, which every CI
// job does: npm's install and prepare lifecycles (pnpm runs the same ones for
// workspace projects), npm's legacy `prepublish` and its `dependencies` hook,
// and every `pnpm:`-namespaced hook such as `pnpm:devPreinstall`. Any other
// script runs only when invoked by name, so it is package code exercised by
// the shared build and the package's own lanes.
const INSTALL_LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
  'prepublish',
  'dependencies',
]);

function isInstallLifecycleScript(name) {
  return INSTALL_LIFECYCLE_SCRIPTS.has(name) || name.startsWith('pnpm:');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Compares the base and head copies of a modified workspace manifest. Any
// missing reader, unreadable side or unparseable JSON fails closed.
function classifyManifestChange(filePath, readManifest) {
  if (typeof readManifest !== 'function') {
    return { packageScoped: false, detail: `${filePath} contents are unavailable to the planner` };
  }
  let texts;
  let before;
  let after;
  try {
    texts = { base: readManifest('base', filePath), head: readManifest('head', filePath) };
    before = JSON.parse(texts.base);
    after = JSON.parse(texts.head);
  } catch {
    return { packageScoped: false, detail: `${filePath} could not be read and compared` };
  }
  // git reports the manifest as modified, so identical text means the compared
  // commits are not the diff being routed.
  if (texts.base === texts.head) {
    return { packageScoped: false, detail: `${filePath} is identical in both compared commits although the diff modifies it` };
  }
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return { packageScoped: false, detail: `${filePath} is not a JSON object` };
  }

  const changedFields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => !isDeepStrictEqual(before[field], after[field]))
    .sort();
  const installFields = changedFields.filter((field) => !PACKAGE_SCOPED_MANIFEST_FIELDS.has(field));
  if (installFields.length) {
    return { packageScoped: false, detail: `${filePath} changed ${installFields.join(', ')}` };
  }
  const scripts = { before: before.scripts ?? {}, after: after.scripts ?? {} };
  if (!isPlainObject(scripts.before) || !isPlainObject(scripts.after)) {
    return { packageScoped: false, detail: `${filePath} scripts is not a JSON object` };
  }
  const lifecycleScripts = [...new Set([...Object.keys(scripts.before), ...Object.keys(scripts.after)])]
    .filter((name) => isInstallLifecycleScript(name))
    .filter((name) => !isDeepStrictEqual(scripts.before[name], scripts.after[name]))
    .sort();
  if (lifecycleScripts.length) {
    return {
      packageScoped: false,
      detail: `${filePath} changed install lifecycle scripts ${lifecycleScripts.join(', ')}`,
    };
  }
  return {
    packageScoped: true,
    detail: `${filePath} changed ${changedFields.join(', ') || 'formatting only'}`,
  };
}

function workspaceForPath(filePath) {
  return Object.keys(WORKSPACE_RULES)
    .sort((left, right) => right.length - left.length)
    .find((workspace) => filePath === workspace || filePath.startsWith(`${workspace}/`));
}

export function parseNameStatusZ(buffer) {
  if (!buffer?.length) return [];
  const fields = buffer.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();

  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) throw new Error('Missing git change status');

    const code = status[0];
    const oldPath = fields[index++];
    if (!oldPath) throw new Error(`Missing path for git change status ${status}`);

    if (code === 'R' || code === 'C') {
      const newPath = fields[index++];
      if (!newPath) throw new Error(`Missing destination path for git change status ${status}`);
      entries.push({ status, paths: [normalizePath(oldPath), normalizePath(newPath)] });
    } else {
      entries.push({ status, paths: [normalizePath(oldPath)] });
    }
  }

  return entries;
}

// The routing decision for one changed path. Precedence, first match wins:
//   1. global CI inputs (lockfile, root configs, patches/, scripts/) -> full CI
//   2. a package workspace -> its WORKSPACE_RULES entry; the highest-risk
//      workspace and install-affecting manifest edits -> full CI
//   3. a repository support area -> the first matching SUPPORT_PATH_ROUTES
//      entry: full CI for the control plane, unknown workflow paths and
//      devnet manifests, otherwise its lanes plus the shared build checks
//   4. a path claimed only by PATH_TRIGGERS (blazegraph-image.json)
//   5. anything else -> full CI
// PATH_TRIGGERS add lanes and EVM scopes on top of whichever of 2-4 applies.
// Every decision has one shape, { full, lanes, evmScopes, buildChecks,
// reasons }: `full` is the reason the path needs full CI (and the rest is
// empty) or null when the other fields route it.
const NONE = Object.freeze([]);
const fullRoute = (reason) => ({ full: reason, lanes: NONE, evmScopes: NONE, buildChecks: false, reasons: NONE });

function routePath(filePath, { modifiedFiles, readManifest }) {
  if (isGlobalFullPath(filePath)) return fullRoute(`Global CI input changed: ${filePath}`);

  // The area that owns the path: its workspace rule, else a support route. A
  // document reaching here is claimed by PATH_TRIGGERS, so only the lanes that
  // read it run, not the rule of the package it documents.
  let area;
  const document = isDocumentationPath(filePath);
  const workspace = workspaceForPath(filePath);
  if (workspace && !document) {
    const rule = WORKSPACE_RULES[workspace];
    if (rule.forceFull) return fullRoute(`Highest-risk workspace changed: ${workspace}`);
    const reasons = [];
    if (filePath === `${workspace}/package.json`) {
      if (!modifiedFiles.has(filePath)) return fullRoute(`Workspace manifest added, removed or moved: ${filePath}`);
      const manifestChange = classifyManifestChange(filePath, readManifest);
      if (!manifestChange.packageScoped) {
        return fullRoute(`Workspace manifest changed install inputs: ${manifestChange.detail}`);
      }
      reasons.push(`Package-scoped manifest change: ${manifestChange.detail}`);
    } else if (filePath.endsWith('/package.json')) {
      // A manifest below a workspace root is its own pnpm workspace
      // (packages/cli/test-fixtures/*), so it is an install input too.
      return fullRoute(`Nested workspace manifest changed: ${filePath}`);
    }
    reasons.push(`${workspace} and its downstream consumers`);
    area = { lanes: rule.lanes, evmScopes: rule.evmScopes, buildChecks: false, reasons };
  } else if (!document) {
    const supportRoute = supportPathRoute(filePath);
    if (supportRoute?.full) return fullRoute(`${supportRoute.full}: ${filePath}`);
    if (supportRoute) area = { lanes: supportRoute.lanes, evmScopes: NONE, buildChecks: true, reasons: [supportRoute.reason] };
  }

  const triggers = pathTriggers(filePath);
  if (!area && triggers.length === 0) return fullRoute(`Unclassified path changed: ${filePath}`);
  return {
    full: null,
    lanes: [...triggers.flatMap((trigger) => trigger.lanes), ...(area?.lanes ?? NONE)],
    evmScopes: [...triggers.flatMap((trigger) => trigger.evmScopes), ...(area?.evmScopes ?? NONE)],
    buildChecks: area?.buildChecks ?? false,
    reasons: [...triggers.map((trigger) => trigger.reason), ...(area?.reasons ?? NONE)],
  };
}

// Git name-status codes whose paths can be routed like ordinary edits: a
// deleted, renamed or copied file affects exactly the areas that own its old
// and new paths. Type changes (T), unmerged (U), unknown (X) and broken
// pairings (B) - and anything git adds later - still fail closed.
const ROUTABLE_CHANGE_STATUSES = new Set(['A', 'M', 'D', 'R', 'C']);

// The environment through which the workflows hand plan-ci.mjs the candidate
// checkout and the two diffed commits that back `readManifest` (environment,
// not flags, so an older pinned controller simply ignores it). Workflows and
// tests are checked against these names.
export const MANIFEST_READER_ENV = Object.freeze({
  repository: 'CI_CANDIDATE_REPO',
  base: 'CI_DIFF_BASE_SHA',
  head: 'CI_DIFF_HEAD_SHA',
});

// `readManifest(side, path)` returns the raw text of `path` at the diff base
// ('base') or the merge candidate ('head'); plan-ci.mjs backs it with git.
// Without it, every workspace manifest edit keeps the full profile.
export function planCi({
  eventName,
  changeEntries = [],
  labels = [],
  readManifest,
} = {}) {
  const changedFiles = [...new Set(changeEntries.flatMap((entry) => entry.paths).map(normalizePath))];
  const isPullRequest = eventName === 'pull_request' || eventName === 'pull_request_delta_disabled';
  const diffKnown = !isPullRequest || (changeEntries.length > 0 && changedFiles.length > 0);
  const solidityRelevance = classifySolidityRelevance(eventName, changedFiles, diffKnown);
  const fullForCurrentDiff = (reasons) => fullPlan({
    reasons,
    solidityRelevance,
    changedFiles,
  });

  if (!isPullRequest) {
    return fullForCurrentDiff([`${eventName || 'unknown'} events always run full CI`]);
  }

  // Missing diff data is the highest-risk input and must win over every PR
  // override. Labels and the delta rollback switch may force a known diff to
  // full CI, but they cannot infer that Solidity is irrelevant when GitHub
  // reported no changed files at all.
  if (!diffKnown) {
    return fullForCurrentDiff(['No changed files were reported; failing closed']);
  }

  if (eventName === 'pull_request_delta_disabled') {
    return fullForCurrentDiff(['PR delta routing is disabled; running full CI']);
  }

  if (labels.includes('ci:full')) {
    return fullForCurrentDiff(['PR has the ci:full override label']);
  }

  const unroutableChange = changeEntries.find(({ status }) => !ROUTABLE_CHANGE_STATUSES.has(status[0]));
  if (unroutableChange) {
    return fullForCurrentDiff([`Git change status ${unroutableChange.status} cannot be narrowed safely`]);
  }

  const productionFiles = changedFiles.filter((filePath) => !isDocumentationOnlyPath(filePath));
  if (productionFiles.length === 0) {
    return planOf({
      mode: 'docs-only',
      lanes: emptyLanes(),
      evmScopes: [],
      solidityRelevance,
      changedFiles,
      reasons: ['Only documentation or repository metadata changed'],
    });
  }

  if (productionFiles.length > 100) {
    return fullForCurrentDiff([`Large PR (${productionFiles.length} non-documentation files)`]);
  }

  // A manifest can only be compared field by field when it exists on both
  // sides; added, deleted, renamed or copied manifests change the workspace
  // graph itself.
  const modifiedFiles = new Set(changeEntries
    .filter(({ status }) => status[0] === 'M')
    .flatMap((entry) => entry.paths.map(normalizePath)));

  // Changes spanning many workspaces select the union of their rules; there is
  // no workspace-count cut-off, because each rule already includes every
  // downstream consumer and unknown paths still fail closed below.
  const lanes = emptyLanes();
  const evmScopes = new Set();
  const reasons = [];
  let buildChecks = false;
  lanes.contracts = solidityRelevance.contracts;

  for (const filePath of productionFiles) {
    const route = routePath(filePath, { modifiedFiles, readManifest });
    if (route.full) return fullForCurrentDiff([route.full]);
    for (const lane of route.lanes) lanes[lane] = true;
    for (const scope of route.evmScopes) evmScopes.add(scope);
    buildChecks ||= route.buildChecks;
    reasons.push(...route.reasons);
  }

  // The Blazegraph job also runs the agent's live Blazegraph suites
  // (packages/agent/vitest.blazegraph.config.ts), so ci.yml starts it for
  // either lane; the plan records that, so the gate requires the job.
  if (lanes.tornado_agent) lanes.tornado_blazegraph = true;

  const deduplicatedReasons = [...new Set(reasons)];
  const runNode = needsSharedBuild({ lanes, buildChecks });
  const selfBuildingLane = SELF_BUILDING_LANES.some((lane) => lanes[lane]);
  if (!runNode && !selfBuildingLane && !lanes.contracts && evmScopes.size === 0) {
    return fullForCurrentDiff(['Planner selected no lane for a production change; failing closed']);
  }

  return {
    mode: 'delta',
    fullCi: false,
    runNode,
    buildChecks,
    abiFreshnessRelevant: solidityRelevance.abiFreshnessRelevant,
    lanes,
    evmScopes: EVM_SCOPES.filter((scope) => evmScopes.has(scope)),
    changedFileCount: changedFiles.length,
    changedFiles: changedFiles.slice(0, MAX_REPORTED_FILES),
    reasons: deduplicatedReasons,
  };
}

export function githubOutputsForPlan(plan) {
  const gatePlan = {
    mode: plan.mode,
    fullCi: plan.fullCi,
    runNode: plan.runNode,
    buildChecks: plan.buildChecks,
    abiFreshnessRelevant: plan.abiFreshnessRelevant,
    lanes: plan.lanes,
    evmScopes: plan.evmScopes,
  };
  return {
    full_ci: String(plan.fullCi),
    run_node: String(plan.runNode),
    node_test_artifacts: String(needsNodeTestArtifacts(plan)),
    abi_freshness: String(plan.abiFreshnessRelevant),
    ...Object.fromEntries(CI_LANES.map((lane) => [lane, String(plan.lanes[lane])])),
    evm_matrix: JSON.stringify(plan.evmScopes),
    plan_json: JSON.stringify(gatePlan),
  };
}

export function renderPlanSummary(plan) {
  const selected = CI_LANES.filter((lane) => plan.lanes[lane]);
  const skipped = CI_LANES.filter((lane) => !plan.lanes[lane]);
  const safe = (value) => value.replace(/[|`\r\n]/g, '_');

  const noLaneSummary = plan.buildChecks ? '_none (shared build checks only)_' : '_none_';

  return [
    '## CI delta plan',
    '',
    `- Mode: **${plan.mode}**`,
    `- Selected lanes: ${selected.length ? selected.map((lane) => `\`${lane}\``).join(', ') : noLaneSummary}`,
    `- Skipped lanes: ${skipped.length ? skipped.map((lane) => `\`${lane}\``).join(', ') : '_none_'}`,
    `- EVM scopes: ${plan.evmScopes.length ? plan.evmScopes.map((scope) => `\`${scope}\``).join(', ') : '_none_'}`,
    `- Reason: ${plan.reasons.map(safe).join('; ')}`,
    '',
    '<details><summary>Changed files</summary>',
    '',
    ...plan.changedFiles.slice(0, 100).map((filePath) => `- \`${safe(filePath)}\``),
    ...(plan.changedFileCount > 100 ? [`- _and ${plan.changedFileCount - 100} more_`] : []),
    '',
    '</details>',
    '',
  ].join('\n');
}
