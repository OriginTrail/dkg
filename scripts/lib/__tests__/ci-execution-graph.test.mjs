// The CI execution graph (ci-execution-graph.mjs): which workspaces and
// package scripts a command reaches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { workflowExecution } from './ci-execution-graph.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';
import { laneSeeds } from './lane-entrypoints.mjs';

test('pnpm filter selectors resolve on the injected workspace graph alone', () => {
  // a depends on b, c on a; d stands apart. None of these names exists in the
  // repository, so its manifests cannot take part.
  const manifest = (name, dependencies = {}) => ({ name, dependencies, scripts: { build: 'tsc' } });
  const manifests = new Map([
    ['packages/a', manifest('fixture-a', { 'fixture-b': 'workspace:*' })],
    ['packages/b', manifest('fixture-b')],
    ['packages/c', manifest('fixture-c', { 'fixture-a': 'workspace:*' })],
    ['packages/d', manifest('fixture-d')],
  ]);
  const workspaces = { manifests, workspaceByName: new Map([...manifests].map(([directory, { name }]) => [name, directory])) };
  const built = (selector) => workflowExecution(`jobs:\n  bura-cli:\n    steps:\n      - run: pnpm --filter '${selector}' run build\n`, {
    workspaces,
    rootManifest: {},
  })[0].edges.filter(({ kind }) => kind === 'script').map(({ workspace }) => workspace).sort();
  assert.deepEqual(built('fixture-a...'), ['packages/a', 'packages/b']);
  assert.deepEqual(built('...fixture-b'), ['packages/a', 'packages/b', 'packages/c']);
  assert.deepEqual(built('!fixture-d'), ['packages/a', 'packages/b', 'packages/c']);
  assert.deepEqual(built('fixture-*'), ['packages/a', 'packages/b', 'packages/c', 'packages/d']);
});

test('a step runs in its working directory, its job default or its workflow default', () => {
  // GitHub runs a step in its working-directory, else the job's defaults.run,
  // else the workflow's; commands and paths resolve from there.
  const job = (step, defaults = '') => [
    'jobs:',
    '  bura-cli:',
    "    if: needs.changes.outputs.bura_cli == 'true'",
    defaults,
    '    steps:',
    `      - ${step}`,
  ].filter(Boolean).join('\n');
  const files = (source) => workflowExecution(source)[0].edges.filter(({ kind }) => kind === 'file').map(({ file }) => file);
  // The CLI's own build script is there only from packages/cli.
  const prerequisites = 'run: node scripts/build-prerequisites.mjs';
  const cli = ['packages/cli/scripts/build-prerequisites.mjs'];
  assert.deepEqual(files(job(`${prerequisites}\n        working-directory: packages/cli`)), cli);
  assert.deepEqual(files(job(prerequisites, '    defaults:\n      run:\n        working-directory: packages/cli')), cli);
  assert.deepEqual(files(`defaults:\n  run:\n    working-directory: packages/cli\n${job(prerequisites)}`), cli);
  assert.deepEqual(files(job(prerequisites)), [], 'the repository root has no scripts/build-prerequisites.mjs');
  const helpers = 'run: node ../../scripts/devnet-publish-helpers.sh';
  assert.deepEqual(files(job(`${helpers}\n        working-directory: packages/cli`)), ['scripts/devnet-publish-helpers.sh']);
  // The file carries the job's lane like any other the job runs.
  const seeds = laneSeeds({ workflows: [['ci.yml', job(`${helpers}\n        working-directory: packages/cli`)]], workspaceCode: false });
  assert.equal(seeds.get('scripts/devnet-publish-helpers.sh')?.has('bura_cli'), true);
  // A directory the graph cannot resolve statically fails instead of guessing.
  assert.throws(() => workflowExecution(job('run: pnpm test\n        working-directory: ${{ matrix.package }}')), /cannot resolve/);

  // The repository's solidity-coverage step runs evm-module's own
  // test:coverage from packages/evm-module, not the root turbo fan-out.
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const coverage = workflowExecution(ci).find(({ job: name }) => name === 'solidity-coverage');
  const scripts = coverage.edges.filter(({ kind }) => kind === 'script').map(({ workspace, script }) => `${workspace} ${script}`);
  assert.ok(scripts.includes('packages/evm-module test:coverage'));
  assert.equal(scripts.includes('. test:coverage'), false);
  assert.ok(coverage.edges.some(({ kind, file }) => kind === 'file' && file === 'scripts/check-evm-coverage.mjs'));
});
