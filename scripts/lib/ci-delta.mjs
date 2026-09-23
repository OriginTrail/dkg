import { isDeepStrictEqual } from 'node:util';
import {
  EVM_SCOPES,
  PATH_TRIGGERS,
  SUPPORT_PATH_ROUTES,
  WORKSPACE_OWNING_EVM_SCOPES,
  WORKSPACE_OWNING_LANES,
  WORKSPACE_RULES,
} from './ci-routing.mjs';

export { EVM_SCOPES, WORKSPACE_OWNING_EVM_SCOPES, WORKSPACE_OWNING_LANES, WORKSPACE_RULES };

// This module is part of the trusted CI controller: workflows run it from a
// sparse checkout that contains ONLY the files in CONTROLLER_POLICY_FILES
// (scripts/ci/trusted-controller-pins.mjs). It may import node: builtins and
// the other controller files, nothing else, or every planner run fails with
// ERR_MODULE_NOT_FOUND and the pin can never be rotated. The executable lane
// topology in ci-lanes.mjs is checked against this map instead.
//
// It holds the lane map, manifest classification, plan shape and outputs; the
// routing tables (WORKSPACE_RULES, SUPPORT_PATH_ROUTES, PATH_TRIGGERS) live in
// the sibling controller file ci-routing.mjs. Every controller file widens the
// security-reviewed sparse checkout that four workflow checkouts pin, so add
// one only together with CONTROLLER_POLICY_FILES and every trusted checkout.
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

// Lanes that restore the shared Hardhat 0.8.20/london compiler outputs.
export const NODE_TEST_ARTIFACT_LANES = Object.freeze([
  'tornado_core', 'tornado_publisher', 'tornado_agent', 'bura_cli', 'kosava_hardhat_plugins',
]);

export function needsNodeTestArtifacts(plan) {
  return NODE_TEST_ARTIFACT_LANES.some((lane) => plan.lanes?.[lane] === true);
}


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


const MAX_REPORTED_FILES = 200;

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

// Every plan the planner returns has this one shape, declared here once.
function planOf({ mode, lanes, evmScopes, buildChecks = false, solidityRelevance, changedFiles, reasons }) {
  return {
    mode,
    fullCi: mode === 'full',
    runNode: needsSharedBuild({ lanes, buildChecks }),
    buildChecks,
    abiFreshnessRelevant: solidityRelevance.abiFreshnessRelevant,
    lanes,
    evmScopes,
    changedFileCount: changedFiles.length,
    changedFiles: changedFiles.slice(0, MAX_REPORTED_FILES),
    reasons,
  };
}

function fullPlan({
  reasons,
  solidityRelevance,
  changedFiles = [],
}) {
  const lanes = Object.fromEntries(NODE_EVM_LANES.map((lane) => [lane, true]));
  lanes.contracts = solidityRelevance.contracts;
  return planOf({ mode: 'full', lanes, evmScopes: [...EVM_SCOPES], solidityRelevance, changedFiles, reasons });
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

  return planOf({
    mode: 'delta',
    lanes,
    evmScopes: EVM_SCOPES.filter((scope) => evmScopes.has(scope)),
    buildChecks,
    solidityRelevance,
    changedFiles,
    reasons: deduplicatedReasons,
  });
}

// Plan fields only the summary reports; the gate reads every other field, so
// a new plan field reaches it without another list to update.
const REPORT_ONLY_PLAN_FIELDS = new Set(['changedFileCount', 'changedFiles', 'reasons']);

export function githubOutputsForPlan(plan) {
  const gatePlan = Object.fromEntries(
    Object.entries(plan).filter(([field]) => !REPORT_ONLY_PLAN_FIELDS.has(field)),
  );
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
