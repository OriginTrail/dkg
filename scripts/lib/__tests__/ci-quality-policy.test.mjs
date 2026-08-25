import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildVitestJunitInvocation } from '../../ci/run-vitest-junit.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readRepositoryFile = (filePath) => fs.readFileSync(path.join(REPO_ROOT, filePath), 'utf8');

test('shared Vitest runner preserves package test entrypoints and owns JUnit options', () => {
  const invocation = buildVitestJunitInvocation([
    '--package-dir',
    'packages/chain',
    '--output',
    'test-results/chain-2.xml',
    '--',
    'test/example.test.ts',
  ]);

  assert.equal(invocation.args[0], '--dir');
  assert.equal(invocation.args[1], path.join(REPO_ROOT, 'packages/chain'));
  assert.deepEqual(invocation.args.slice(2), [
    'test',
    'test/example.test.ts',
    '--reporter=default',
    '--reporter=junit',
    '--outputFile.junit=test-results/chain-2.xml',
  ]);
  assert.throws(
    () => buildVitestJunitInvocation([
      '--package-dir', 'packages/chain', '--output', '../chain.xml',
    ]),
    /stay inside/,
  );
  assert.throws(
    () => buildVitestJunitInvocation([
      '--package-dir', 'packages/chain', '--output', 'test-results/chain.xml',
      '--', '--reporter=verbose',
    ]),
    /managed by the shared CI runner/,
  );
});

test('CI routes every JUnit lane through the shared runner and uploader', () => {
  const workflow = readRepositoryFile('.github/workflows/ci.yml');
  assert.equal(workflow.match(/run-vitest-junit\.mjs/g)?.length, 7);
  assert.equal(workflow.match(/uses: \.\/\.github\/actions\/upload-vitest-junit/g)?.length, 4);
  assert.doesNotMatch(workflow, /--reporter=junit/);

  for (const output of [
    'test-results/core.xml',
    'test-results/rdf-utils.xml',
    'test-results/storage.xml',
    'test-results/chain-${SHARD_ID}.xml',
    'test-results/publisher-${{ matrix.shard }}.xml',
    'test-results/agent-${{ matrix.shard }}.xml',
    'test-results/cli-${SHARD_ID}.xml',
  ]) {
    assert.ok(workflow.includes(output), `${output} must remain unique`);
  }

  const uploadAction = readRepositoryFile('.github/actions/upload-vitest-junit/action.yml');
  assert.match(uploadAction, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(uploadAction, /retention-days: 14/);
  assert.match(uploadAction, /if-no-files-found: ignore/);

  for (const packageDirectory of ['core', 'rdf-utils', 'storage', 'chain', 'publisher', 'agent', 'cli']) {
    const packageJson = JSON.parse(readRepositoryFile(`packages/${packageDirectory}/package.json`));
    assert.equal(packageJson.scripts.test, 'vitest run');
  }
});

test('coverage thresholds participate in Turbo hashes and run on affected pull requests', () => {
  const turbo = JSON.parse(readRepositoryFile('turbo.json'));
  assert.deepEqual(turbo.tasks['test:coverage'].inputs, [
    '$TURBO_DEFAULT$',
    '$TURBO_ROOT$/vitest.coverage.ts',
  ]);

  const workflow = readRepositoryFile('.github/workflows/node-coverage.yml');
  assert.match(workflow, /^  pull_request:\n    branches: \[main, testnet-canary\]$/m);
  for (const watchedPath of [
    'packages/query/**',
    'packages/okf/**',
    'packages/node-ui/**',
    'packages/network-sim/**',
    'vitest.coverage.ts',
    'turbo.json',
    'package.json',
    'pnpm-lock.yaml',
  ]) {
    assert.ok(workflow.includes(`- '${watchedPath}'`), `${watchedPath} must trigger coverage`);
  }
});

test('repository-wide lint uses a strict warning ceiling that rejects one new violation', (t) => {
  const packageJson = JSON.parse(readRepositoryFile('package.json'));
  assert.match(packageJson.scripts.lint, /^oxlint -c \.oxlintrc\.jsonc \. --quiet --max-warnings=\d+$/);
  assert.doesNotMatch(readRepositoryFile('.oxlintrc.jsonc'), /"[^"\n]+": "off"/);

  const probePath = path.join(REPO_ROOT, 'ci-lint-ratchet-probe.mjs');
  assert.equal(fs.existsSync(probePath), false, 'lint probe path must be unused');
  fs.writeFileSync(probePath, 'const newlyIntroducedLintDebt = 1;\n');
  t.after(() => fs.rmSync(probePath, { force: true }));

  const result = spawnSync('pnpm', ['lint'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'one new correctness warning must exceed the baseline');
});
