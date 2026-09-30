// The routing guard's policy (lane-entrypoints.mjs): which package scripts CI
// runs, and what a change to what they run must select.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { workflowExecution } from './ci-execution-graph.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';
import { edgeRequirement, jobRequirement } from './lane-entrypoints.mjs';

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
