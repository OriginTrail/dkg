import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { prepareReleaseEvidence } from '../release-evidence.mjs';
import { fixture } from './release-evidence-fixture.mjs';
test('complete evidence binds package bytes, source, harness and authenticated nightly', t => {
  const result = fixture(t).verify();
  assert.equal(result.outcome, 'PASS');
  assert.deepEqual(result.nightly, { runId: '123', attempt: 1 });
});
for (const nightly of [undefined, null]) {
  test(`a decision without a nightly run qualifies on CI and the harness: ${nightly}`, t => {
    const f = fixture(t);
    f.decision.nightly = nightly;
    f.options.readNightly = () => assert.fail('no nightly artifact to download');
    const result = f.verify();
    assert.equal(result.outcome, 'PASS');
    assert.equal(result.nightly, null);
  });
}
test('without a nightly run, a failed CI attempt is resolved only by the selected CI run', t => {
  const f = fixture(t), read = f.options.readRun;
  delete f.decision.nightly;
  const old = { ...read('121', 1), conclusion: 'failure', run_started_at: '2026-10-26T10:00:00Z' };
  f.options.readRunAttempts = () => [old];
  f.options.readRun = (id, attempt) => String(id) === '121' ? old
    : { ...read(id, attempt), run_started_at: '2026-10-26T11:00:00Z' };
  const failure = { runId: '121', attempt: 1, classification: 'test',
    issue: 'https://github.com/OriginTrail/dkg/issues/3502', supersededBy: { runId: '123', attempt: 1 } };
  f.decision.priorCiFailures = [failure];
  assert.throws(f.verify, /unresolved CI failure/);
  failure.supersededBy = { runId: '122', attempt: 1 };
  assert.equal(f.verify().outcome, 'PASS');
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
for (const [selected, withNightly] of [['ci', true], ['nightly', true], ['ci', false]]) for (const [field, value, reason] of [
  ['id', 999, /wrong run ID/],
  ['status', 'in_progress', /run is incomplete/], ['conclusion', 'failure', /run did not succeed/],
  ['head_sha', 'wrong', /different commit/], ['path', '.github/workflows/optional.yml', /wrong workflow/],
  ['run_attempt', 2, /wrong run attempt/], ['repository', { full_name: 'some/fork' }, /wrong run repository/],
  ['event', 'pull_request', /candidate directly/], ['event', 'merge_group', /candidate directly/],
]) {
  test(`release independently refuses ${selected} ${field} mismatch${withNightly ? '' : ' without a nightly run'}: ${String(value)}`, t => {
    const f = fixture(t), read = f.options.readRun;
    if (!withNightly) delete f.decision.nightly;
    f.options.readRun = (id, attempt) => ({ ...read(id, attempt),
      ...(String(id) === f.decision[selected].runId ? { [field]: value } : {}),
    });
    assert.throws(f.verify, reason);
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
    assert.throws(f.verify, /wrong workflow/);
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

test('rejected harness attempts retain the attempt ID and the failed invariant', t => {
  for (const [damage, reason] of [
    [state => { state.steps['overlap:share-publish'].buildsVerified = false; }, /unverified node builds: overlap:share-publish/],
    [state => { delete state.steps['functional:six'].scenarios.recovery; }, /missing\/failed scenario: recovery/],
  ]) {
    const f = fixture(t); damage(f.state);
    f.decision.harness.attempts[0].receipt = f.write('suite.json', f.state);
    assert.throws(f.verify, error => {
      assert.match(error.message, /latest harness attempt first/); assert.match(error.message, reason); return true;
    });
  }
});

test('unresolved earlier harness evidence retains its original rejection', t => {
  const f = fixture(t), failed = structuredClone(f.state);
  failed.steps['overlap:share-publish'].buildsVerified = false;
  f.decision.harness.attempts.unshift({ id: 'earlier', receipt: f.write('earlier.json', failed) });
  assert.throws(f.verify, /harness attempt earlier: unverified node builds: overlap:share-publish/);
});
test('malformed harness receipt retains a validation diagnostic', t => {
  const f = fixture(t);
  f.decision.harness.attempts[0].receipt = f.write('suite.json', null);
  assert.throws(f.verify, /latest harness attempt first did not qualify: harness receipt must be an object/);
});

for (const conclusion of ['startup_failure', 'action_required']) {
  test(`CI ${conclusion} must be inventoried and can be resolved`, t => {
    const f = fixture(t), read = f.options.readRun;
    f.options.readRunAttempts = () => [{ ...read('121', 1), conclusion, run_started_at: '2026-10-26T10:00:00Z' }];
    f.options.readRun = (...args) => ({ ...read(...args), run_started_at: '2026-10-26T11:00:00Z' });
    assert.throws(f.verify, /omitted failed CI attempt: 121\/1/);
    f.decision.priorCiFailures = [{ runId: '121', attempt: 1, classification: 'environment',
      issue: 'https://github.com/OriginTrail/dkg/issues/3502', supersededBy: f.decision.ci }];
    assert.equal(f.verify().outcome, 'PASS');
  });
}
for (const [field, reason] of [['dkgCommit', /step tested a different product/], ['harnessCommit', /step used a different harness/]]) {
  test(`child step ${field} cannot disagree with a valid suite identity`, t => {
    const f = fixture(t);
    f.state.steps['overlap:share-publish'][field] = 'f'.repeat(40);
    f.decision.harness.attempts[0].receipt = f.write('suite.json', f.state);
    assert.throws(f.verify, reason);
  });
}

test('qualification parses the same artifact bytes that passed the digest check', t => {
  const f = fixture(t), passing = Buffer.from(JSON.stringify(f.nightly));
  f.nightly.status = 'failed';
  const failed = Buffer.from(JSON.stringify(f.nightly));
  f.decision.nightly.receipt = f.write('nightly.json', f.nightly);
  f.options.readNightly = () => failed;
  const read = fs.readFileSync, artifact = path.join(path.dirname(f.options.evidenceFile), 'nightly.json');
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...options) => {
    if (String(file) === artifact && ++reads > 1) {
      return options[0] === 'utf8' ? passing.toString('utf8') : passing;
    }
    return read(file, ...options);
  });
  assert.throws(f.verify, /nightly receipt did not pass/);
  assert.equal(reads, 1);
});

for (const [name, damage] of [
  ['missing ci', d => { delete d.ci; }],
  ['null ci', d => { d.ci = null; }],
  ['bad run ID', d => { d.ci.runId = '../other'; }],
  ['bad attempt', d => { d.ci.attempt = 0; }],
  ['unsafe attempt', d => { d.ci.attempt = Number.MAX_SAFE_INTEGER + 1; }],
  ['non-object nightly', d => { d.nightly = 'none'; }],
  ['nightly without a run ID', d => { delete d.nightly.runId; }],
  ['missing nightly receipt', d => { delete d.nightly.receipt; }],
  ['unsafe receipt path', d => { d.nightly.receipt.file = '../outside.json'; }],
  ['bad receipt hash', d => { d.nightly.receipt.sha256 = 'bad'; }],
  ['non-string receipt hash', d => { d.nightly.receipt.sha256 = 12; }],
  ['missing harness', d => { delete d.harness; }],
  ['non-array attempts', d => { d.harness.attempts = {}; }],
  ['null attempt', d => { d.harness.attempts = [null]; }],
  ['missing attempt receipt', d => { delete d.harness.attempts[0].receipt; }],
  ['non-array failures', d => { d.priorCiFailures = {}; }],
  ['null failed run', d => { d.priorCiFailures = [null]; }],
]) test(`malformed decision fails before remote acquisition: ${name}`, t => {
  const f = fixture(t); damage(f.decision);
  let calls = 0;
  for (const key of ['readRun', 'readRunAttempts', 'readNightly']) f.options[key] = () => { calls++; assert.fail('remote acquisition'); };
  assert.throws(f.verify, { name: 'AssertionError' });
  assert.equal(calls, 0);
});
for (const file of ['decision.json', 'nightly.json', 'suite.json']) {
  test(`local integrity check rejects changed ${file} without remote acquisition`, t => {
    const f = fixture(t); f.verify();
    let calls = 0;
    for (const key of ['readRun', 'readRunAttempts', 'readNightly']) {
      const original = f.options[key];
      f.options[key] = (...args) => { calls++; return original(...args); };
    }
    const prepared = prepareReleaseEvidence(f.options);
    assert.equal(prepared.result.outcome, 'PASS');
    calls = 0; prepared.recheckLocalIntegrity(); assert.equal(calls, 0);
    f.write(file, {});
    assert.throws(prepared.recheckLocalIntegrity, /changed/);
    assert.equal(calls, 0);
  });
}
test('without a nightly run the local integrity check still covers the decision and harness receipts', t => {
  const f = fixture(t);
  delete f.decision.nightly;
  f.verify();
  const prepared = prepareReleaseEvidence(f.options);
  prepared.recheckLocalIntegrity();
  f.write('suite.json', {});
  assert.throws(prepared.recheckLocalIntegrity, /changed evidence: suite\.json/);
});
