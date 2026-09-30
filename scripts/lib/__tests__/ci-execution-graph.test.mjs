// The CI execution graph (ci-execution-graph.mjs): which workspaces and
// package scripts a command reaches.
import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowExecution } from './ci-execution-graph.mjs';

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
