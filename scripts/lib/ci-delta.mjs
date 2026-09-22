import { isDeepStrictEqual } from 'node:util';

// This module is part of the trusted CI controller: workflows run it from a
// sparse checkout that contains ONLY the files in CONTROLLER_POLICY_FILES
// (scripts/ci/trusted-controller-pins.mjs). It may import node: builtins and
// the other controller files, nothing else, or every planner run fails with
// ERR_MODULE_NOT_FOUND and the pin can never be rotated. The executable lane
// topology in ci-lanes.mjs is checked against this map instead.
export const PRIMARY_LANE_JOBS = Object.freeze({
  tornado_core: 'tornado-core',
  tornado_blazegraph: 'tornado-blazegraph',
  tornado_publisher: 'tornado-publisher',
  tornado_agent: 'tornado-agent',
  tornado_agent_windows: 'inventory-windows',
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
// image contract and the reusable Windows lifecycle workflow), so selecting
// them alone never requires the shared Linux build.
export const SELF_BUILDING_LANES = Object.freeze(['tornado_agent_windows', 'bura_blazegraph_arm64']);

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


// The Playwright suite boots four real daemons and drives node-ui against
// them (7 shards, ~45 runner-minutes). On pull requests it follows only the
// UI surface it exercises: node-ui, its graph-viz dependency and the daemon
// HTTP API in cli. Changes deeper in the stack are covered on PRs by their own
// lanes plus bura_cli's daemon tests; the browser suite still runs for them on
// every protected push, merge-queue candidate and nightly run (full CI), and
// `ci:full` opts a PR in before merging.
//
// The Windows lifecycle job (rfc64-inventory-windows.yml) runs wherever the
// agent lane does. Besides the SQLite persistence suites it runs the RFC-64
// Gate 0 lifecycle and evidence harnesses, which start a real agent (agent,
// core, chain, storage and their dependencies) and run on no Linux lane, so
// every workspace in that closure selects it.
export const WORKSPACE_RULES = Object.freeze({
  'packages/core': {
    lanes: [
      'tornado_core',
      'tornado_blazegraph',
      'tornado_publisher',
      'tornado_agent',
      'tornado_agent_windows',
      'bura_cli',
      'bura_query',
      'kosava_node_ui',
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
      'tornado_agent_windows',
      'bura_cli',
      'bura_query',
      'kosava_node_ui',
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
      'tornado_agent_windows',
      'bura_cli',
      'bura_query',
      'kosava_node_ui',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: EVM_SCOPES,
  },
  'packages/storage': {
    lanes: [
      'tornado_core',
      'tornado_blazegraph',
      'tornado_publisher',
      'tornado_agent',
      'tornado_agent_windows',
      'bura_cli',
      'bura_query',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: ['publisher', 'agent'],
  },
  'packages/chain': {
    lanes: [
      'tornado_core',
      'tornado_publisher',
      'tornado_agent',
      'tornado_agent_windows',
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
      'tornado_agent_windows',
      'bura_cli',
      'bura_query',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: ['publisher', 'agent'],
  },
  'packages/publisher': {
    lanes: [
      'tornado_publisher',
      'tornado_agent',
      'tornado_agent_windows',
      'bura_cli',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: ['publisher', 'agent'],
  },
  'packages/random-sampling': {
    lanes: [
      'tornado_agent',
      'tornado_agent_windows',
      'bura_cli',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: ['agent'],
  },
  'packages/agent': {
    lanes: [
      'tornado_agent',
      'tornado_agent_windows',
      'bura_cli',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: ['agent'],
  },
  'packages/cli': {
    lanes: ['bura_cli', 'kosava_node_ui_e2e', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/node-ui': {
    lanes: ['bura_cli', 'kosava_node_ui', 'kosava_node_ui_e2e', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/graph-viz': {
    lanes: [
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
    lanes: ['bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
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
    lanes: ['bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-openclaw': {
    lanes: ['bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-prime-agent': {
    lanes: ['bura_cli', 'kosava_supporting', 'kosava_hardhat_plugins'],
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

const NODE_LANES = NODE_EVM_LANES.filter((lane) => !SELF_BUILDING_LANES.includes(lane));
const MAX_REPORTED_FILES = 200;

// Source of truth for WHAT this protects: EVM_TEST_SCOPES.chain.files in
// scripts/ci/evm-test-scopes.mjs — packages/chain/test/evm-adapter.test.ts plus
// ../node-ui/integration/identity-wallet-actions-v10.test.ts. That module
// cannot be imported here: ci-delta.mjs runs from the trusted-controller sparse
// checkout, whose file list is pinned to CONTROLLER_POLICY_FILES in
// scripts/ci/trusted-controller-pins.mjs and enforced by sparseCheckoutPaths(),
// so a fifth entry hard-fails every workflow that runs the planner. The
// manifest names the test files the chain scope RUNS; the patterns below name
// the SOURCE changes that must trigger it. Drift between the two copies is
// guarded from the test side in scripts/lib/__tests__/ci-delta-routing.test.mjs.
const IDENTITY_WALLET_EVM_PATTERNS = [
  /^packages\/node-ui\/src\/ui\/web3\/(?:identityWalletActions|browserWalletTransaction)\.[cm]?[jt]sx?/,
  /^packages\/node-ui\/src\/ui\/pages\/identity-wallets\//,
  /^packages\/node-ui\/integration\/identity-wallet-actions-v10\.test\.ts$/,
];

// File-level triggers: lanes or EVM scopes that specific paths select on top
// of the rule for the area that owns them (a workspace or a support route). A
// path outside every area is classified by its triggers alone. Per-file
// refinements belong in this table, never as special cases inside planCi.
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

function isDocumentationOnlyPath(filePath) {
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

// Workflows whose jobs, conditions and gates define what "CI gate" means. Other
// top-level workflows run (or are linted) on their own; see supportPathRoute.
const CI_CONTROL_WORKFLOWS = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/evm-integration.yml',
  '.github/workflows/rfc64-inventory-windows.yml',
]);

function isGlobalFullPath(filePath) {
  return GLOBAL_FULL_PATHS.has(filePath)
    || CI_CONTROL_WORKFLOWS.has(filePath)
    // GitHub only runs top-level workflow files; anything nested is unknown.
    || /^\.github\/workflows\/[^/]+\/./.test(filePath)
    || filePath.startsWith('.github/actions/')
    || filePath.startsWith('patches/')
    || filePath.startsWith('scripts/')
    // devnet suites are pnpm workspaces: their manifests are install inputs.
    || /^devnet\/[^/]+\/package\.json$/.test(filePath)
    || /^tsconfig(?:\.[^/]+)?\.json$/.test(filePath);
}

// Repository areas outside the package workspaces, mapped to the lanes that
// actually execute them in CI (ci.yml and its reusable workflows). Every route
// also selects the shared build job's own checks (`buildChecks`): its lint,
// repository-script tests and test-inventory checks cover these files, and for
// routes with no lanes they are the only CI consumer (the suites are manual or
// have their own workflow).
const SUPPORT_PATH_ROUTES = Object.freeze([
  {
    pattern: /^devnet\/rfc64-gate1-public-open\//,
    lanes: ['tornado_agent', 'tornado_blazegraph'],
    reason: 'RFC-64 Gate 1 harness runs in the agent and Blazegraph lanes',
  },
  {
    // Gate 0 persistence evidence and the evidence bootstrap run in the
    // Windows lifecycle job, and agent code imports the Gate 0 evidence
    // helpers (packages/agent/devnet/rfc64-private-catalog).
    pattern: /^devnet\/(?:rfc64-persistence-lifecycle|_bootstrap)\//,
    lanes: ['tornado_agent', 'tornado_agent_windows'],
    reason: 'RFC-64 persistence harness runs in the agent and Windows lifecycle jobs',
  },
  {
    // Devnet harnesses are built on the agent, and agent tests, fixtures and
    // packages/agent/devnet import several of them (shared rfc64-runtime-*
    // modules, the Gate 0 evidence helpers, the Gate 2 runtime hooks).
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
// the workspace resolves (dependency ranges, pnpm/overrides, engines, bin,
// name, type), so it keeps the full profile.
const PACKAGE_SCOPED_MANIFEST_FIELDS = new Set([
  'author',
  'browser',
  'bugs',
  'contributors',
  'description',
  'directories',
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
  let before;
  let after;
  try {
    before = JSON.parse(readManifest('base', filePath));
    after = JSON.parse(readManifest('head', filePath));
  } catch {
    return { packageScoped: false, detail: `${filePath} could not be read and compared` };
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
//   1. global CI inputs (control plane, lockfile, scripts/, ...) -> full CI
//   2. a package workspace -> its WORKSPACE_RULES entry; the highest-risk
//      workspace and install-affecting manifest edits -> full CI
//   3. a repository support area -> SUPPORT_PATH_ROUTES plus the shared
//      build job's own checks
//   4. a path claimed only by PATH_TRIGGERS (blazegraph-image.json)
//   5. anything else -> full CI
// PATH_TRIGGERS add lanes and EVM scopes on top of whichever of 2-4 applies.
// Returns { full: reason } or { lanes, evmScopes, buildChecks, reasons }.
function routePath(filePath, { modifiedFiles, readManifest }) {
  if (isGlobalFullPath(filePath)) return { full: `Global CI input changed: ${filePath}` };

  const triggers = pathTriggers(filePath);
  const route = {
    lanes: triggers.flatMap((trigger) => trigger.lanes),
    evmScopes: triggers.flatMap((trigger) => trigger.evmScopes),
    buildChecks: false,
    reasons: triggers.map((trigger) => trigger.reason),
  };

  const workspace = workspaceForPath(filePath);
  if (workspace) {
    const rule = WORKSPACE_RULES[workspace];
    if (rule.forceFull) return { full: `Highest-risk workspace changed: ${workspace}` };
    if (filePath === `${workspace}/package.json`) {
      if (!modifiedFiles.has(filePath)) {
        return { full: `Workspace manifest added, removed or moved: ${filePath}` };
      }
      const manifestChange = classifyManifestChange(filePath, readManifest);
      if (!manifestChange.packageScoped) {
        return { full: `Workspace manifest changed install inputs: ${manifestChange.detail}` };
      }
      route.reasons.push(`Package-scoped manifest change: ${manifestChange.detail}`);
    }
    route.lanes.push(...rule.lanes);
    route.evmScopes.push(...rule.evmScopes);
    route.reasons.push(`${workspace} and its downstream consumers`);
    return route;
  }

  const supportRoute = supportPathRoute(filePath);
  if (supportRoute) {
    route.lanes.push(...supportRoute.lanes);
    route.buildChecks = true;
    route.reasons.push(supportRoute.reason);
    return route;
  }

  if (triggers.length) return route;
  return { full: `Unclassified path changed: ${filePath}` };
}

// Git name-status codes whose paths can be routed like ordinary edits: a
// deleted, renamed or copied file affects exactly the areas that own its old
// and new paths. Type changes (T), unmerged (U), unknown (X) and broken
// pairings (B) - and anything git adds later - still fail closed.
const ROUTABLE_CHANGE_STATUSES = new Set(['A', 'M', 'D', 'R', 'C']);

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
    return {
      mode: 'docs-only',
      fullCi: false,
      runNode: false,
      buildChecks: false,
      abiFreshnessRelevant: solidityRelevance.abiFreshnessRelevant,
      lanes: emptyLanes(),
      evmScopes: [],
      changedFileCount: changedFiles.length,
      changedFiles: changedFiles.slice(0, MAX_REPORTED_FILES),
      reasons: ['Only documentation or repository metadata changed'],
    };
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

  const deduplicatedReasons = [...new Set(reasons)];
  const runNode = buildChecks || NODE_LANES.some((lane) => lanes[lane]);
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
