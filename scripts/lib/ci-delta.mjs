export const NODE_EVM_LANES = Object.freeze([
  'tornado_core',
  'tornado_blazegraph',
  'tornado_publisher',
  'tornado_agent',
  'bura_cli',
  'bura_blazegraph_arm64',
  'bura_query',
  'kosava_node_ui',
  'kosava_node_ui_e2e',
  'kosava_supporting',
  'kosava_hardhat_plugins',
]);

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
    lanes: [
      'tornado_core',
      'tornado_blazegraph',
      'tornado_publisher',
      'tornado_agent',
      'bura_cli',
      'bura_query',
      'kosava_node_ui_e2e',
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
    evmScopes: ['publisher', 'agent'],
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
    evmScopes: ['publisher', 'agent'],
  },
  'packages/random-sampling': {
    lanes: [
      'tornado_agent',
      'bura_cli',
      'kosava_node_ui_e2e',
      'kosava_supporting',
      'kosava_hardhat_plugins',
    ],
    evmScopes: ['agent'],
  },
  'packages/agent': {
    lanes: [
      'tornado_agent',
      'bura_cli',
      'kosava_node_ui_e2e',
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
    lanes: ['bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/mcp-dkg': {
    lanes: ['bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
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
    lanes: ['bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-openclaw': {
    lanes: ['bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
    evmScopes: [],
  },
  'packages/adapter-prime-agent': {
    lanes: ['bura_cli', 'kosava_node_ui_e2e', 'kosava_supporting', 'kosava_hardhat_plugins'],
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
  'packages/epcis': ['kosava_supporting'],
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

const BLAZEGRAPH_ARM64_PATHS = new Set([
  'blazegraph-image.json',
  'packages/cli/blazegraph-image-metadata.cjs',
  'packages/cli/src/daemon/blazegraph-docker.ts',
  'packages/cli/test/blazegraph-docker.test.ts',
  'packages/cli/test/blazegraph-image-metadata.test.ts',
  'packages/cli/test/blazegraph-integration.test.ts',
]);

function isBlazegraphArm64Path(filePath) {
  return BLAZEGRAPH_ARM64_PATHS.has(filePath)
    || /^packages\/cli\/(?:src|test)\/.*blazegraph.*\.(?:[cm]?[jt]s|json)$/i.test(filePath);
}

const NODE_LANES = NODE_EVM_LANES.filter((lane) => lane !== 'bura_blazegraph_arm64');
const MAX_REPORTED_FILES = 200;

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
  auditSampled = false,
}) {
  const lanes = Object.fromEntries(NODE_EVM_LANES.map((lane) => [lane, true]));
  lanes.contracts = solidityRelevance.contracts;
  return {
    mode: 'full',
    fullCi: true,
    auditSampled,
    runNode: true,
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

function isGlobalFullPath(filePath) {
  return GLOBAL_FULL_PATHS.has(filePath)
    || filePath.startsWith('.github/workflows/')
    || filePath.startsWith('patches/')
    || filePath.startsWith('scripts/')
    || /^tsconfig(?:\.[^/]+)?\.json$/.test(filePath);
}

function workspaceForPath(filePath) {
  return Object.keys(WORKSPACE_RULES)
    .sort((left, right) => right.length - left.length)
    .find((workspace) => filePath === workspace || filePath.startsWith(`${workspace}/`));
}

function isAuditSample(sampleKey, percentage) {
  if (!sampleKey || percentage <= 0) return false;
  const prefix = sampleKey.match(/^[0-9a-f]{8}/i)?.[0];
  if (!prefix) return false;
  return Number.parseInt(prefix, 16) % 100 < percentage;
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

export function planCi({
  eventName,
  changeEntries = [],
  labels = [],
  sampleKey = '',
  auditPercentage = 5,
} = {}) {
  const changedFiles = [...new Set(changeEntries.flatMap((entry) => entry.paths).map(normalizePath))];
  const isPullRequest = eventName === 'pull_request' || eventName === 'pull_request_delta_disabled';
  const diffKnown = !isPullRequest || (changeEntries.length > 0 && changedFiles.length > 0);
  const solidityRelevance = classifySolidityRelevance(eventName, changedFiles, diffKnown);
  const fullForCurrentDiff = (reasons, auditSampled = false) => fullPlan({
    reasons,
    solidityRelevance,
    changedFiles,
    auditSampled,
  });

  if (!isPullRequest) {
    return fullForCurrentDiff([`${eventName || 'unknown'} events always run full CI`]);
  }

  // Missing diff data is the highest-risk input and must win over every PR
  // override. Labels, audit sampling, and the delta rollback switch may force
  // a known diff to full CI, but they cannot infer that Solidity is irrelevant
  // when GitHub reported no changed files at all.
  if (!diffKnown) {
    return fullForCurrentDiff(['No changed files were reported; failing closed']);
  }

  if (eventName === 'pull_request_delta_disabled') {
    return fullForCurrentDiff(['PR delta routing is disabled; running full CI']);
  }

  if (labels.includes('ci:full')) {
    return fullForCurrentDiff(['PR has the ci:full override label']);
  }

  if (isAuditSample(sampleKey, auditPercentage)) {
    return fullForCurrentDiff([`${auditPercentage}% deterministic audit sample`], true);
  }

  const riskyChange = changeEntries.find(({ status }) => ['D', 'R', 'C', 'T', 'U', 'X', 'B'].includes(status[0]));
  if (riskyChange) {
    return fullForCurrentDiff([`Git change status ${riskyChange.status} cannot be narrowed safely`]);
  }

  const productionFiles = changedFiles.filter((filePath) => !isDocumentationOnlyPath(filePath));
  if (productionFiles.length === 0) {
    return {
      mode: 'docs-only',
      fullCi: false,
      auditSampled: false,
      runNode: false,
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

  const touchedWorkspaces = new Set(productionFiles.map(workspaceForPath).filter(Boolean));
  if (touchedWorkspaces.size >= 4) {
    return fullForCurrentDiff([`Cross-cutting PR (${touchedWorkspaces.size} production workspaces)`]);
  }

  const lanes = emptyLanes();
  const evmScopes = new Set();
  const reasons = [];
  lanes.contracts = solidityRelevance.contracts;

  for (const filePath of productionFiles) {
    if (isGlobalFullPath(filePath)) {
      return fullForCurrentDiff([`Global CI input changed: ${filePath}`]);
    }

    const blazegraphProvisioningChange = isBlazegraphArm64Path(filePath);
    if (blazegraphProvisioningChange) {
      lanes.bura_cli = true;
      lanes.bura_blazegraph_arm64 = true;
      reasons.push(`Blazegraph provisioning contract changed: ${filePath}`);
    }

    const workspace = workspaceForPath(filePath);
    if (!workspace) {
      if (blazegraphProvisioningChange) continue;
      return fullForCurrentDiff([`Unclassified path changed: ${filePath}`]);
    }

    if (filePath === `${workspace}/package.json`) {
      return fullForCurrentDiff([`Workspace dependency manifest changed: ${filePath}`]);
    }

    const rule = WORKSPACE_RULES[workspace];
    if (rule.forceFull) {
      return fullForCurrentDiff([`Highest-risk workspace changed: ${workspace}`]);
    }

    for (const lane of rule.lanes) lanes[lane] = true;
    for (const scope of rule.evmScopes) evmScopes.add(scope);
    reasons.push(`${workspace} and its downstream consumers`);
  }

  const deduplicatedReasons = [...new Set(reasons)];
  const runNode = NODE_LANES.some((lane) => lanes[lane]);
  if (!runNode && !lanes.bura_blazegraph_arm64 && !lanes.contracts && evmScopes.size === 0) {
    return fullForCurrentDiff(['Planner selected no lane for a production change; failing closed']);
  }

  return {
    mode: 'delta',
    fullCi: false,
    auditSampled: false,
    runNode,
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

  return [
    '## CI delta plan',
    '',
    `- Mode: **${plan.mode}**`,
    `- Full-CI audit sample: **${plan.auditSampled ? 'yes' : 'no'}**`,
    `- Selected lanes: ${selected.length ? selected.map((lane) => `\`${lane}\``).join(', ') : '_none_'}`,
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
