// The routing guard's policy (lane-entrypoints.mjs): which package scripts CI
// runs, and what a change to what they run must select.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { workflowExecution } from './ci-execution-graph.mjs';
import { REPO_ROOT, change, pullRequestPlan } from './ci-plan-fixtures.mjs';
import { edgeRequirement, jobRequirement, parseRequirement, requirement, requirementCoveredByPlan } from './lane-entrypoints.mjs';

// The package scripts a workflow runs, as '<requirement> <workspace> <script>'.
function scriptRuns(workflows, execution) {
  return [...new Set(workflows.flatMap(([workflow, source]) => workflowExecution(source, execution)
    .flatMap(({ job, condition, edges }) => edges
      .filter(({ kind }) => kind === 'script')
      .map(({ workspace, script, chain }) => `${edgeRequirement(jobRequirement(workflow, job, condition), chain)} ${workspace} ${script}`))))].sort();
}

test('workspace scripts count where CI runs them, not because their workspace owns a lane', () => {
  // A manual script in a lane-owning workspace is no lane input; a job
  // command that runs it adds that job's lane. The shared build runs every
  // workspace's build (turbo build) for the output every lane restores, so
  // what a build runs carries that workspace's build output; an install hook
  // runs in every job. A workspace script's paths resolve from its own
  // directory.
  const cli = {
    name: '@origintrail-official/dkg',
    scripts: {
      preinstall: 'node ./scripts/verify-node-sqlite-runtime.mjs',
      build: 'pnpm run build:prepared',
      'build:prepared': 'tsc && node scripts/build-prerequisites.mjs && node ../../scripts/copy-cli-runtime-assets.mjs',
      'release:dry-run': 'node ../../scripts/release-helper.mjs',
    },
  };
  const execution = { workspaces: { manifests: new Map([['packages/cli', cli]]), workspaceByName: new Map([[cli.name, 'packages/cli']]) }, rootManifest: {} };
  const workflow = (laneCommand) => [['ci.yml', [
    'jobs:',
    '  build:',
    "    if: needs.changes.outputs.run_node == 'true'",
    '    steps:',
    '      - run: pnpm install --frozen-lockfile && turbo build',
    '  bura-cli:',
    "    if: needs.changes.outputs.bura_cli == 'true'",
    '    steps:',
    `      - run: ${laneCommand}`,
  ].join('\n')]];
  const shared = ['build-output:packages/cli packages/cli build', 'build-output:packages/cli packages/cli build:prepared', 'install packages/cli preinstall'];
  assert.deepEqual(scriptRuns(workflow('pnpm install --frozen-lockfile'), execution), shared);
  assert.deepEqual(scriptRuns(workflow("pnpm --filter '@origintrail-official/dkg' run release:dry-run"), execution), [...shared, 'bura_cli packages/cli release:dry-run'].sort());
  // A filter the graph cannot resolve fails instead of hiding what runs.
  assert.throws(() => scriptRuns(workflow('pnpm --filter "[origin/main]" run build'), execution), /unsupported pnpm filter selector/);
  const [build] = workflowExecution(workflow('echo ok')[0][1], execution);
  assert.deepEqual([...new Set(build.edges.filter(({ kind }) => kind === 'file').map(({ file }) => file))], [
    'packages/cli/scripts/verify-node-sqlite-runtime.mjs',
    'packages/cli/scripts/build-prerequisites.mjs',
    'scripts/copy-cli-runtime-assets.mjs',
  ]);

  // The repository's own: the CLI build and pack run the asset copier, and
  // lane jobs run the node-ui UI build and the demo and Hermes suites.
  const real = new Set(scriptRuns(['ci.yml', 'evm-integration.yml'].map((workflow) => [
    workflow,
    fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', workflow), 'utf8'),
  ])));
  for (const run of [
    'build-output:packages/cli packages/cli build:prepared',
    'build-output:packages/cli packages/cli prepack',
    'install packages/cli postinstall',
    'install . preinstall',
    'kosava_node_ui packages/node-ui build:ui',
    'kosava_supporting demo test',
    'kosava_supporting packages/adapter-hermes test:py',
  ]) {
    assert.ok(real.has(run), run);
  }
});

test('each requirement kind is evaluated against a plan, and an unknown one is rejected', () => {
  const plan = (file) => pullRequestPlan([change(file)]);
  const covered = (required, file) => requirementCoveredByPlan(required, plan(file), file);
  // A lane, an EVM scope and the shared build.
  assert.equal(covered(requirement.lane('bura_cli'), 'packages/cli/src/cli.ts'), true);
  assert.equal(covered(requirement.lane('tornado_core'), 'packages/cli/src/cli.ts'), false);
  assert.equal(covered(requirement.evmScope('chain'), 'packages/chain/src/index.ts'), true);
  assert.equal(covered(requirement.evmScope('chain'), 'packages/cli/src/cli.ts'), false);
  assert.equal(covered(requirement.build, 'scripts/audit-dial-protocol.mjs'), true);
  assert.equal(covered(requirement.build, 'docs/ci-delta-policy.md'), false);
  // install and full need a full plan.
  for (const required of [requirement.install, requirement.full]) {
    assert.equal(covered(required, 'packages/cli/scripts/verify-node-sqlite-runtime.mjs'), true, required);
    assert.equal(covered(required, 'packages/cli/src/cli.ts'), false, required);
  }
  // Build output: a repository file needs full CI; a workspace file needs
  // the producer's lanes, less the browser suite for the deferred runtime; a
  // producer without a rule is met only by a full plan.
  const cli = requirement.buildOutput('packages/cli');
  assert.equal(covered(cli, 'scripts/copy-cli-runtime-assets.mjs'), true);
  assert.equal(covered(cli, 'scripts/devnet-publish-helpers.sh'), false);
  assert.equal(covered(cli, 'packages/storage/blazegraph-namespace-contract.cjs'), true);
  const withoutBrowser = { ...plan('packages/graph-viz/src/index.ts'), lanes: { ...plan('packages/graph-viz/src/index.ts').lanes, kosava_node_ui_e2e: false } };
  assert.equal(requirementCoveredByPlan(cli, withoutBrowser, 'packages/graph-viz/src/index.ts'), false);
  assert.equal(covered(requirement.buildOutput('devnet/_bootstrap'), 'packages/cli/src/cli.ts'), false);
  assert.equal(covered(requirement.buildOutput('devnet/_bootstrap'), 'package.json'), true);
  // Unknown kinds are rejected, not read as lanes.
  for (const text of ['bura-cli', 'evm:nope', 'build-output:', 'lane:bura_cli', '']) {
    assert.throws(() => parseRequirement(text), /unknown routing requirement/, text);
    assert.throws(() => requirementCoveredByPlan(text, plan('package.json'), 'package.json'), /unknown routing requirement/, text);
  }
  assert.throws(() => requirement.lane('bura-cli'), /unknown CI lane/);
  assert.throws(() => requirement.evmScope('nope'), /unknown EVM scope/);
  assert.throws(() => requirement.buildOutput(''), /names the workspace/);
});

test('what a workspace without a routing rule runs is held to full CI', () => {
  // The graph discovers an unmapped workspace's hooks and scripts like any
  // other; the policy decides what they need. Its install hook runs in every
  // job (full CI); its build's output is met only by full CI, since no rule
  // says who consumes it. Both named files here plan less, so both report.
  const unmapped = { name: '@example/unmapped', scripts: { postinstall: 'node ../../scripts/devnet-publish-helpers.sh', build: 'node ../../scripts/audit-dial-protocol.mjs' } };
  const workspaces = { manifests: new Map([['tools/unmapped', unmapped]]), workspaceByName: new Map([[unmapped.name, 'tools/unmapped']]) };
  const [build] = workflowExecution("jobs:\n  build:\n    if: needs.changes.outputs.run_node == 'true'\n    steps:\n      - run: pnpm install && turbo build\n", { workspaces, rootManifest: {} });
  const job = jobRequirement('ci.yml', 'build', "needs.changes.outputs.run_node == 'true'");
  const required = build.edges.filter(({ kind }) => kind === 'file').map(({ file, chain }) => [file, edgeRequirement(job, chain)]);
  assert.deepEqual(required, [
    ['scripts/devnet-publish-helpers.sh', 'install'],
    ['scripts/audit-dial-protocol.mjs', 'build-output:tools/unmapped'],
  ]);
  for (const [file, text] of required) {
    assert.equal(requirementCoveredByPlan(text, pullRequestPlan([change(file)]), file), false, `${text} ${file}`);
  }
});
