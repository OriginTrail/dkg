import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './release-evidence-fixture.mjs';
test('complete evidence binds package bytes, source, harness and authenticated nightly', t => {
  assert.equal(fixture(t).verify().outcome, 'PASS');
});
for (const [name, damage] of [
  ['stale commit', f => { f.decision.candidate.commit = 'f'.repeat(40); }],
  ['stale package set', f => { f.decision.candidate.packageSetDigest = 'f'.repeat(64); }],
  ['stale build inputs', f => { f.decision.candidate.sourceInputsDigest = 'f'.repeat(64); }],
  ['wrong tree', f => { f.decision.candidate.tree = 'f'.repeat(40); }],
  ['wrong harness', f => { f.decision.harness.commit = 'f'.repeat(40); }],
  ['wrong profile', f => { f.decision.harness.profile = 'focused'; }],
  ['incomplete harness', f => { f.state.status = 'interrupted'; }],
  ['empty attempts', f => { f.decision.harness.attempts = []; }],
  ['missing case', f => { delete f.state.steps['functional:six'].scenarios.recovery; }],
  ['missing step', f => { delete f.state.steps['overlap:share-publish']; }],
  ['unverified build', f => { f.state.steps['overlap:share-publish'].buildsVerified = false; }],
  ['bad process exit', f => { f.state.steps['overlap:share-publish'].exit = 1; }],
  ['matrix contradiction', f => { f.state.matrixGrade.failures = ['failure']; }],
  ['absent CI failure inventory', f => { delete f.decision.priorCiFailures; }],
  ['unauthenticated nightly', f => { f.options.readNightly = () => Buffer.from('{}'); }],
  ['missing browser shard', f => { f.nightly.browsers.pop(); }],
  ['unexecuted property trials', f => { f.nightly.campaigns[0].completedTrials = 0; }],
  ['skipped lifecycle', f => { f.nightly.browsers[0].tests[0].attempts[0].status = 'skipped'; }],
]) test(`release refuses ${name}`, t => {
  const f = fixture(t); damage(f);
  if (f.decision.harness.attempts.length) f.decision.harness.attempts[0].receipt = f.write('suite.json', f.state);
  f.decision.nightly.receipt = f.write('nightly.json', f.nightly);
  assert.throws(f.verify);
});
for (const [field, value] of [['status','in_progress'],['conclusion','failure'],['head_sha','wrong'],['path','.github/workflows/optional.yml'],['run_attempt',2],['repository',{ full_name: 'some/fork' }],['event','pull_request'],['event','merge_group']]) {
  test(`release refuses GitHub ${field} mismatch`, t => {
    const f = fixture(t), read = f.options.readRun;
    f.options.readRun = (...args) => ({ ...read(...args), [field]: value });
    assert.throws(f.verify);
  });
}
test('prior failed harness attempts remain blocked until a later full pass resolves them', t => {
  const f = fixture(t), failed = structuredClone(f.state); failed.steps['functional:six'].result = 'FAIL';
  const bad = { id: 'failed', receipt: f.write('failed.json', failed) };
  f.decision.harness.attempts.unshift(bad);
  assert.throws(f.verify, /classification/);
  bad.resolution = { classification: 'product', issue: 'https://github.com/OriginTrail/dkg/issues/3502', supersededBy: 'absent' };
  assert.throws(f.verify, /unresolved/);
  bad.resolution.supersededBy = 'first';
  assert.equal(f.verify().outcome, 'PASS');
  f.decision.harness.attempts.reverse();
  assert.throws(f.verify, /latest harness/);
});
test('changed evidence bytes are rejected even when the enclosing decision is valid', t => {
  const f = fixture(t); f.write('suite.json', {}); assert.throws(f.verify, /changed evidence/);
});


test('failed CI attempts cannot disappear from the decision inventory', t => {
  const f = fixture(t);
  f.options.readRunAttempts = () => [{ id: 121, run_attempt: 1, conclusion: 'failure' }];
  assert.throws(f.verify, /omitted failed CI attempt/);
});

test('CI failures need classification, ownership and a later selected successful attempt', t => {
  const f = fixture(t), read = f.options.readRun;
  const old = { ...read('121', 1), conclusion: 'cancelled', run_started_at: '2026-10-26T10:00:00Z' };
  f.options.readRunAttempts = () => [old];
  f.options.readRun = (id, attempt) => String(id) === '121' ? old
    : { ...read(id, attempt), run_started_at: '2026-10-26T11:00:00Z' };
  const failure = { runId: '121', attempt: 1, issue: 'https://github.com/OriginTrail/dkg/issues/3502',
    supersededBy: { runId: '123', attempt: 1 } };
  f.decision.priorCiFailures = [failure];
  assert.throws(f.verify, /classification/);
  failure.classification = 'environment';
  assert.equal(f.verify().outcome, 'PASS');
  failure.supersededBy.attempt = 2;
  assert.throws(f.verify, /unresolved CI failure/);
  failure.supersededBy.attempt = 1;
  old.run_started_at = '2026-10-26T12:00:00Z';
  assert.throws(f.verify, /replacement must follow failure/);
  old.run_started_at = 'invalid';
  assert.throws(f.verify, /replacement must follow failure/);
});

for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/ci.yml@main']) {
  test(`bare and ref-qualified workflow identity is accepted: ${workflow}`, t => {
    const f = fixture(t), read = f.options.readRun;
    f.options.readRun = (...args) => ({ ...read(...args), path: workflow, run_started_at: '2026-10-26T11:00:00Z' });
    f.options.readRunAttempts = () => [{ ...read('121', 1), path: workflow, conclusion: 'failure', run_started_at: '2026-10-26T10:00:00Z' }];
    f.decision.priorCiFailures = [{ runId: '121', attempt: 1, classification: 'test', issue: 'https://github.com/OriginTrail/dkg/issues/3502', supersededBy: f.decision.ci }];
    assert.equal(f.verify().outcome, 'PASS');
    f.options.readRunAttempts = () => [{ ...read('121', 1), path: '.github/workflows/other.yml@main', conclusion: 'failure' }];
    assert.throws(f.verify, /wrong prior workflow/);
    f.options.readRun = (...args) => ({ ...read(...args), path: '.github/workflows/other.yml@main' });
    assert.throws(f.verify, /wrong workflow/);
  });
}
test('each verification acquires missing attempts once and reuses history and selections', t => {
  const f = fixture(t), read = f.options.readRun, calls = [];
  f.decision.ci = { runId: '123', attempt: 1 };
  f.options.readRun = (id, attempt) => { calls.push(`${id}/${attempt}`); return read(id, attempt); };
  let histories = 0;
  f.options.readRunAttempts = () => { histories++; return []; };
  f.verify(); f.verify();
  assert.deepEqual(calls, ['123/1', '123/1']);
  assert.equal(histories, 2);
  f.options.readRunAttempts = () => [read('123', 1)];
  calls.length = 0; f.verify();
  assert.deepEqual(calls, []);
});
