import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './release-evidence-fixture.mjs';
import { installGithubFixture } from './github-evidence-fixture.mjs';

function githubFixture(t) {
  const f = fixture(t), read = f.options.readRun;
  const run = (id, attempt, conclusion = 'success') => ({ ...read(id, attempt), conclusion,
    path: '.github/workflows/ci.yml@main', run_started_at: `2026-10-26T${conclusion === 'success' ? '11' : '10'}:00:00Z` });
  const config = { latestAttempt: 1, nightlyBytes: JSON.stringify(f.nightly),
    pages: [[{ id: 122, run_attempt: 1 }], [{ id: 123, run_attempt: 1 }, { id: 121, run_attempt: 2 }]],
    runs: { '122/1': run(122, 1), '123/1': run(123, 1), '121/1': run(121, 1, 'failure'), '121/2': run(121, 2) } };
  const gh = installGithubFixture(path.join(path.dirname(f.options.evidenceFile), 'bin'), config);
  delete f.options.readRun; delete f.options.readRunAttempts; delete f.options.readNightly;
  const verify = () => {
    gh.update(config);
    const previous = process.env.PATH;
    try { process.env.PATH = gh.env.PATH; return f.verify(); }
    finally { process.env.PATH = previous; }
  };
  const resolveFailure = () => f.decision.priorCiFailures.push({ runId: '121', attempt: 1,
    classification: 'test', issue: 'https://github.com/OriginTrail/dkg/issues/3502', supersededBy: f.decision.ci });
  return { ...f, config, gh, verify, resolveFailure };
}
test('default GitHub acquisition discovers failures on later pages', t => {
  const f = githubFixture(t);
  f.config.pages[1][1].run_attempt = 1;
  assert.throws(f.verify, /omitted failed CI attempt: 121\/1/);
});
test('default GitHub acquisition enumerates failed prior rerun attempts', t => {
  const f = githubFixture(t);
  f.config.pages = [f.config.pages.flat()];
  assert.throws(f.verify, /omitted failed CI attempt: 121\/1/);
});
test('default GitHub acquisition accepts exact artifact bytes and reads each attempt once', t => {
  const f = githubFixture(t); f.resolveFailure();
  // The selected nightly also satisfies CI; history contains a duplicate row.
  f.decision.ci = { runId: '123', attempt: 1 };
  f.decision.priorCiFailures[0].supersededBy = f.decision.ci;
  f.config.pages[1].push({ id: 123, run_attempt: 1 });
  assert.equal(f.verify().outcome, 'PASS');
  const calls = fs.readFileSync(f.gh.calls, 'utf8').trim().split('\n').map(JSON.parse);
  const attempts = calls.filter(args => args[0] === 'api' && args[1]?.includes('/attempts/')).map(args => args[1]);
  assert.equal(attempts.length, 4);
  assert.equal(new Set(attempts).size, 4);
  assert.ok(calls.some(args => args.includes('--paginate')));
});
test('default GitHub acquisition rejects superseded nightly artifacts', t => {
  const f = githubFixture(t); f.resolveFailure(); f.config.latestAttempt = 2;
  assert.throws(f.verify, /only the latest nightly attempt/);
  assert.ok(!fs.readFileSync(f.gh.calls, 'utf8').includes('download'));
});
test('default GitHub acquisition rejects byte changes even for semantically identical artifacts', t => {
  const f = githubFixture(t); f.resolveFailure(); f.config.nightlyBytes += '\n';
  assert.throws(f.verify, /differs from authenticated Actions artifact/);
});
