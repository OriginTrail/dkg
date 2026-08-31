import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  runVitestJunit,
} from '../../ci/run-vitest-junit.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readRepositoryFile = (filePath) => fs.readFileSync(path.join(REPO_ROOT, filePath), 'utf8');
const parseRepositoryYaml = (filePath) => parseYaml(readRepositoryFile(filePath));

const JUNIT_UPLOAD_PATTERN = 'packages/*/test-results/*.xml';

function validateJunitUploadCoverage(workflow) {
  const uploadsByJob = new Map();
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    const runnerSteps = (job.steps ?? []).filter(
      (step) => typeof step?.run === 'string' && step.run.includes('run-vitest-junit.mjs'),
    );
    const uploads = (job.steps ?? []).filter(
      (step) => step?.uses === './.github/actions/upload-vitest-junit',
    );
    if (runnerSteps.length === 0) {
      if (uploads.length > 0) throw new Error(`${jobName} uploads JUnit without running the shared runner`);
      continue;
    }
    if (uploads.length !== 1) {
      throw new Error(`${jobName} must define exactly one Vitest JUnit upload step`);
    }
    for (const step of runnerSteps) assert.doesNotMatch(step.run, /--reporter=junit/);
    uploadsByJob.set(jobName, uploads);
  }

  return uploadsByJob;
}

test('shared Vitest runner derives sharded and unsharded package reports', () => {
  const sharded = buildVitestJunitInvocation([
    '--lane', 'chain', '--shard', '2', '--', 'test/example.test.ts',
  ]);
  assert.deepEqual(sharded.args.slice(2), [
    'exec',
    'vitest',
    'run',
    'test/example.test.ts',
    '--reporter=default',
    '--reporter=junit',
    '--outputFile.junit=test-results/chain-2.xml',
  ]);
  assert.equal(sharded.output, 'test-results/chain-2.xml');

  const unsharded = buildVitestJunitInvocation(['--lane', 'core']);
  assert.deepEqual(unsharded.args.slice(2), [
    'exec',
    'vitest',
    'run',
    '--reporter=default',
    '--reporter=junit',
    '--outputFile.junit=test-results/core.xml',
  ]);
  assert.equal(unsharded.output, 'test-results/core.xml');
  assert.throws(
    () => buildVitestJunitInvocation(['--lane', 'chain', '--shard', 'two']),
    /--shard must be numeric/,
  );
  assert.throws(
    () => buildVitestJunitInvocation(['--lane', '../core']),
    /package directory name/,
  );
  assert.throws(
    () => buildVitestJunitInvocation(['--lane', 'does-not-exist']),
    /package\.json does not exist/,
  );
  assert.throws(
    () => buildVitestJunitInvocation([
      '--lane', 'core', '--', '--reporter=verbose',
    ]),
    /managed by the shared CI runner/,
  );

  const nonVitestScript = buildVitestJunitInvocation(['--lane', 'core'], {
    readPackageJson: () => ({
      scripts: { test: 'node scripts/test.mjs' },
      devDependencies: { vitest: '^4.0.18' },
    }),
  });
  assert.deepEqual(nonVitestScript.args.slice(2, 5), ['exec', 'vitest', 'run'],
    'the CI runner owns Vitest and must not invoke an opaque package test script');
  assert.throws(
    () => buildVitestJunitInvocation(['--lane', 'core'], {
      readPackageJson: () => ({ scripts: { test: 'node scripts/test.mjs' } }),
    }),
    /must declare Vitest as a devDependency/,
  );
});

test('every shared JUnit runner job uploads convention-derived reports', () => {
  const workflow = parseRepositoryYaml('.github/workflows/ci.yml');
  const uploadsByJob = validateJunitUploadCoverage(workflow);
  assert.equal(uploadsByJob.size, 4);
  for (const [, [step]] of uploadsByJob) {
    assert.equal(step.if, 'always()');
    assert.equal(typeof step.with?.['artifact-name'], 'string');
    assert.deepEqual(Object.keys(step.with), ['artifact-name']);
  }

  const mismatchedWorkflow = structuredClone(workflow);
  mismatchedWorkflow.jobs['tornado-publisher'].steps = mismatchedWorkflow.jobs[
    'tornado-publisher'
  ].steps.filter(
    (step) => step?.uses !== './.github/actions/upload-vitest-junit',
  );
  assert.throws(
    () => validateJunitUploadCoverage(mismatchedWorkflow),
    /tornado-publisher must define exactly one Vitest JUnit upload step/,
  );

  const uploadAction = parseRepositoryYaml('.github/actions/upload-vitest-junit/action.yml');
  assert.equal(uploadAction.runs.using, 'composite');
  assert.equal(uploadAction.runs.steps.length, 1);
  const [upload] = uploadAction.runs.steps;
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.deepEqual(upload.with, {
    name: '${{ inputs.artifact-name }}',
    path: JUNIT_UPLOAD_PATTERN,
    'retention-days': 14,
    'if-no-files-found': 'ignore',
  });
  for (const report of [
    'packages/example/test-results/example.xml',
    'packages/example/test-results/example-1.xml',
  ]) {
    assert.equal(path.posix.matchesGlob(report, upload.with.path), true);
  }
});

test('shared JUnit runner creates reports and propagates child failures', (t) => {
  const reportPath = path.join(REPO_ROOT, 'packages/rdf-utils/test-results/rdf-utils.xml');
  t.after(() => fs.rmSync(reportPath, { force: true }));

  const passed = runVitestJunit([
    '--lane', 'rdf-utils', '--', 'test/rdf-literal.test.ts',
  ]);
  assert.equal(passed, 0);
  assert.match(fs.readFileSync(reportPath, 'utf8'), /<testsuites[^>]*tests="19"/);

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

test('Oxlint baseline fingerprints accepted diagnostics and fails closed on runner errors', () => {
  const known = {
    code: 'eslint(no-unused-vars)',
    filename: 'packages/a/src/a.ts',
    severity: 'warning',
    message: "Identifier 'knownValue' is declared but never used.",
    sourceText: 'const knownValue = 1;',
    labels: [{
      label: "'knownValue' is declared here",
      span: { offset: 6, length: 10, line: 1, column: 7 },
    }],
  };
  const baseline = baselineFromDiagnostics([known]);
  assert.equal(compareOxlintBaseline({ diagnostics: [known], baseline }).ok, true);
  assert.equal(compareOxlintBaseline({
    diagnostics: [{
      ...known,
      sourceText: '\n\nconst knownValue = 1;',
      labels: [{
        ...known.labels[0],
        span: { offset: 8, length: 10, line: 3, column: 7 },
      }],
    }],
    baseline,
  }).ok, true, 'unrelated line movement must preserve an accepted diagnostic fingerprint');

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
    message: known.message,
    evidence: [{ label: "'knownValue' is declared here", source: 'knownValue' }],
    current: 1,
    allowed: 0,
  });
  const replacement = {
    ...known,
    message: "Identifier 'replacement' is declared but never used.",
    sourceText: 'const replacement = 1;',
    labels: [{
      label: "'replacement' is declared here",
      span: { offset: 6, length: 11, line: 1, column: 7 },
    }],
  };
  const replaced = compareOxlintBaseline({ diagnostics: [replacement], baseline });
  assert.equal(replaced.ok, false,
    'a same-rule warning replacement in the same file must not consume old baseline capacity');
  assert.equal(replaced.regressions[0].message, replacement.message);
  assert.equal(replaced.reductions[0].message, known.message);

  const generated = baselineFromDiagnostics([
    known,
    known,
    {
      ...known,
      code: 'unicorn(prefer-string-starts-ends-with)',
      filename: 'packages/b.ts',
    },
  ]);
  assert.equal(generated.version, 2);
  assert.deepEqual(Object.values(generated.rules['eslint(no-unused-vars)'][
    'packages/a/src/a.ts'
  ]), [2]);
  assert.deepEqual(Object.values(generated.rules['unicorn(prefer-string-starts-ends-with)'][
    'packages/b.ts'
  ]), [1]);
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

test('CI keeps one explicit repository lint gate', () => {
  const workflow = parseRepositoryYaml('.github/workflows/ci.yml');
  const lintSteps = Object.values(workflow.jobs).flatMap((job) => (
    (job.steps ?? []).filter((step) => step?.run === 'pnpm lint')
  ));
  assert.deepEqual(lintSteps.map((step) => step.name), [
    'Lint source and repository tooling',
  ]);
});
