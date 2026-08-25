import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  baselineFromDiagnostics,
  compareOxlintBaseline,
  executeOxlint,
  runOxlintBaseline,
} from '../../ci/check-oxlint-baseline.mjs';
import {
  buildVitestJunitInvocation,
  loadVitestJunitLanes,
  runVitestJunit,
} from '../../ci/run-vitest-junit.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readRepositoryFile = (filePath) => fs.readFileSync(path.join(REPO_ROOT, filePath), 'utf8');
const parseRepositoryYaml = (filePath) => parseYaml(readRepositoryFile(filePath));

test('shared Vitest runner uses package-owned test contracts', () => {
  const invocation = buildVitestJunitInvocation([
    '--lane', 'chain', '--shard', '2', '--', 'test/example.test.ts',
  ]);
  assert.deepEqual(invocation.args.slice(2), [
    'test',
    'test/example.test.ts',
    '--reporter=default',
    '--reporter=junit',
    '--outputFile.junit=test-results/chain-2.xml',
  ]);
  assert.throws(
    () => buildVitestJunitInvocation(['--lane', 'chain']),
    /requires a numeric --shard/,
  );
  assert.throws(
    () => buildVitestJunitInvocation([
      '--lane', 'core', '--', '--reporter=verbose',
    ]),
    /managed by the shared CI runner/,
  );

  for (const lane of Object.values(loadVitestJunitLanes())) {
    const packageJson = JSON.parse(readRepositoryFile(`${lane.packageDir}/package.json`));
    assert.equal(typeof packageJson.scripts.test, 'string');
    assert.equal(packageJson.scripts['test:ci'], undefined);
  }
});

test('JUnit workflow and upload policy match the semantic lane manifest', () => {
  const workflow = parseRepositoryYaml('.github/workflows/ci.yml');
  const lanes = loadVitestJunitLanes();
  const observedLanes = new Map();
  const uploadSteps = [];

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step?.uses === './.github/actions/upload-vitest-junit') uploadSteps.push(step);
      if (typeof step?.run !== 'string' || !step.run.includes('run-vitest-junit.mjs')) continue;
      for (const match of step.run.matchAll(/--lane\s+([a-z0-9-]+)/g)) {
        assert.equal(observedLanes.has(match[1]), false, `${match[1]} must be invoked once`);
        observedLanes.set(match[1], jobName);
      }
      assert.doesNotMatch(step.run, /--reporter=junit/);
    }
  }

  assert.deepEqual([...observedLanes.keys()].sort(), Object.keys(lanes).sort());
  for (const [laneName, lane] of Object.entries(lanes)) {
    assert.equal(observedLanes.get(laneName), lane.ciJob);
  }
  assert.equal(uploadSteps.length, 4);
  for (const step of uploadSteps) {
    assert.equal(step.if, 'always()');
    assert.equal(typeof step.with?.['artifact-name'], 'string');
    assert.equal(typeof step.with?.['report-path'], 'string');
  }

  const uploadAction = parseRepositoryYaml('.github/actions/upload-vitest-junit/action.yml');
  assert.equal(uploadAction.runs.using, 'composite');
  assert.equal(uploadAction.runs.steps.length, 1);
  const [upload] = uploadAction.runs.steps;
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.deepEqual(upload.with, {
    name: '${{ inputs.artifact-name }}',
    path: '${{ inputs.report-path }}',
    'retention-days': 14,
    'if-no-files-found': 'ignore',
  });
  assert.equal(
    new Set(Object.values(lanes).map((lane) => lane.output)).size,
    Object.keys(lanes).length,
    'JUnit outputs must be unique',
  );
});

test('shared JUnit runner creates reports and propagates child failures', (t) => {
  const reportPath = path.join(REPO_ROOT, 'packages/rdf-utils/test-results/rdf-utils.xml');
  t.after(() => fs.rmSync(reportPath, { force: true }));

  const passed = runVitestJunit([
    '--lane', 'rdf-utils', '--', 'test/rdf-literal.test.ts',
  ]);
  assert.equal(passed, 0);
  assert.match(fs.readFileSync(reportPath, 'utf8'), /<testsuites[^>]*tests="13"/);

  const failed = runVitestJunit([
    '--lane', 'rdf-utils', '--', 'test/does-not-exist.test.ts',
  ]);
  assert.notEqual(failed, 0, 'a failing package test must remain CI-gating');

  assert.equal(runVitestJunit(['--lane', 'rdf-utils'], {
    spawnProcess: () => ({ status: 0, signal: null }),
  }), 1, 'a successful child without JUnit XML must fail closed');
  assert.equal(runVitestJunit(['--lane', 'rdf-utils'], {
    spawnProcess: () => ({ status: null, signal: 'SIGTERM' }),
  }), 1);
  assert.equal(runVitestJunit(['--lane', 'rdf-utils'], {
    spawnProcess: () => ({ status: null, signal: null, error: new Error('spawn ENOENT') }),
  }), 2);
});

test('coverage workflow keeps the four fixed ratchets direct and CI-gating', () => {
  const packages = [
    { name: '@origintrail-official/dkg-query', path: 'packages/query' },
    { name: '@origintrail-official/dkg-okf', path: 'packages/okf' },
    { name: '@origintrail-official/dkg-node-ui', path: 'packages/node-ui' },
    { name: '@origintrail-official/dkg-network-sim', path: 'packages/network-sim' },
  ];
  const workflow = parseRepositoryYaml('.github/workflows/node-coverage.yml');
  const pullRequestPaths = new Set(workflow.on.pull_request.paths);
  for (const entry of packages) {
    assert.equal(pullRequestPaths.has(`${entry.path}/**`), true, `${entry.path} must trigger coverage`);
  }

  const coverageJob = workflow.jobs['node-coverage'];
  const runStep = coverageJob.steps.find((step) => step?.name === 'Run hermetic coverage ratchets');
  assert.match(runStep.run, /^pnpm exec turbo test:coverage/);
  assert.deepEqual(
    [...runStep.run.matchAll(/--filter='([^']+)'/g)].map((match) => match[1]),
    packages.map((entry) => entry.name),
  );
  assert.match(runStep.run, /--concurrency=1/);
  assert.match(runStep.run, /--continue=always/);
  assert.equal(runStep['continue-on-error'], undefined, 'Turbo threshold failures must gate the job');
  assert.doesNotMatch(runStep.run, /\|\|\s*true/);

  const uploadStep = coverageJob.steps.find((step) => step?.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(uploadStep.if, 'always()');
  assert.deepEqual(
    uploadStep.with.path.split('\n').map((entry) => entry.trim()).filter(Boolean),
    packages.map((entry) => `${entry.path}/coverage/`),
  );
  assert.equal(uploadStep.with['retention-days'], 14);

  const turbo = JSON.parse(readRepositoryFile('turbo.json'));
  assert.deepEqual(turbo.tasks['test:coverage'].inputs, [
    '$TURBO_DEFAULT$',
    '$TURBO_ROOT$/vitest.coverage.ts',
  ]);
});

test('Oxlint baseline is scoped by rule/path and fails closed on runner errors', () => {
  const baseline = {
    version: 1,
    rules: { 'eslint(no-unused-vars)': { 'packages/a/src/a.ts': 1 } },
  };
  const known = {
    code: 'eslint(no-unused-vars)',
    filename: 'packages/a/src/a.ts',
    severity: 'warning',
  };
  assert.equal(compareOxlintBaseline({ diagnostics: [known], baseline }).ok, true);

  const reduced = compareOxlintBaseline({ diagnostics: [], baseline });
  assert.equal(reduced.ok, true, 'removing known debt must not break lint');
  assert.equal(reduced.reductions.length, 1);

  const newPath = compareOxlintBaseline({
    diagnostics: [known, { ...known, filename: 'packages/b/src/new.ts' }],
    baseline,
  });
  assert.equal(newPath.ok, false);
  assert.deepEqual(newPath.regressions[0], {
    rule: 'eslint(no-unused-vars)',
    path: 'packages/b/src/new.ts',
    current: 1,
    allowed: 0,
  });
  const generated = baselineFromDiagnostics([
    known,
    known,
    { ...known, code: 'unicorn(prefer-string-starts-ends-with)', filename: 'packages/b.ts' },
  ]);
  assert.deepEqual(generated.rules, {
    'eslint(no-unused-vars)': { 'packages/a/src/a.ts': 2 },
    'unicorn(prefer-string-starts-ends-with)': { 'packages/b.ts': 1 },
  });
  const roundTripped = JSON.parse(JSON.stringify(generated));
  assert.equal(compareOxlintBaseline({
    diagnostics: [known, known, {
      ...known,
      code: 'unicorn(prefer-string-starts-ends-with)',
      filename: 'packages/b.ts',
    }],
    baseline: roundTripped,
  }).ok, true, 'deterministic nested baseline must survive JSON round-trip');
  assert.equal(runOxlintBaseline([], {
    spawnProcess: () => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify({ diagnostics: [{
        ...known,
        filename: 'scripts/ci/new-lint-debt.mjs',
      }] }),
    }),
  }), 1, 'the real lint entrypoint must reject a warning outside the checked-in baseline');

  assert.throws(
    () => executeOxlint(() => ({ status: null, signal: null, error: new Error('spawn ENOENT') })),
    /spawn ENOENT/,
  );
  assert.throws(
    () => executeOxlint(() => ({ status: null, signal: 'SIGTERM' })),
    /terminated by SIGTERM/,
  );
  assert.throws(
    () => executeOxlint(() => ({
      status: 42,
      signal: null,
      stdout: JSON.stringify({ diagnostics: [] }),
    })),
    /status 42 without error diagnostics/,
  );
});

test('checked-in Oxlint baseline passes in the current repository', () => {
  const result = spawnSync('pnpm', ['lint'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Oxlint rule\/path baseline passed|baseline entries? (?:is|are) now reducible/);
});
