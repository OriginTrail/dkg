import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { hash } from '../package-certification/bundle.mjs';
import { summarizeNightlyProfile, LIFECYCLE_FILE, LIFECYCLE_TESTS, LIFT_TEST } from '../../ci/nightly-profile-results.mjs';
import { verifyReleaseEvidence } from '../release-evidence.mjs';
// Deliberately independent from the verifier's membership constants.
const steps = ['matrix:unregistered-00','matrix:unregistered-01','matrix:unregistered-10','matrix:unregistered-11',
  'matrix:registered-00','matrix:registered-01','matrix:registered-10','matrix:registered-11','functional:six','overlap:share-publish'];
const scenarios = ['convergence','recovery','concurrency','attestation','public-p2p-join','private-unregistered-recovery','literals','member-writes'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-evidence-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = { commit: 'a'.repeat(40), version: '10.0.27', sourceInputsDigest: 'd'.repeat(64) };
  const manifest = { packageSetDigest: 'e'.repeat(64) };
  const harnessCommit = 'b'.repeat(40), tree = 'c'.repeat(40);
  const profile = { schemaVersion: 1, profile: 'nightly-equivalent', subject: expected.commit, runId: '123', attempt: '1', seed: 13, requestedTrials: 1000, managedLocal: true };
  const nightly = summarizeNightlyProfile({ profile,
    needs: Object.fromEntries(['changes','tornado-publisher','kosava-node-ui-e2e'].map(job => [job, { result: 'success' }])),
    browsers: Array.from({ length: 7 }, (_, i) => ({ shard: i + 1, runtime: profile,
      tests: (i === 0 ? LIFECYCLE_TESTS : ['other']).map(title => ({ title, identity: title, file: i === 0 ? LIFECYCLE_FILE : 'other.spec.ts', project: 'real-node', expectedStatus: 'passed', attempts: [{ status: 'passed' }] })) })),
    campaigns: [{ ...profile, identity: LIFT_TEST, status: 'passed', completedTrials: 1000, interrupted: false, numSkips: 0, durationMs: 1 }],
  });
  const state = { status: 'complete', dkgCommit: expected.commit, harnessCommit, requiredSteps: steps,
    steps: Object.fromEntries(steps.map(step => [step, { result: 'PASS', exit: 0, runId: step, buildsVerified: true, dkgCommit: expected.commit, harnessCommit }])), matrixGrade: { result: 'PASS' } };
  state.steps['functional:six'].scenarios = Object.fromEntries(scenarios.map(name => [name, { outcome: 'PASS' }]));
  const write = (file, value) => { const bytes = JSON.stringify(value); fs.writeFileSync(path.join(root, file), bytes); return { file, sha256: hash(bytes) }; };
  const decision = { schemaVersion: 1, candidate: { ...expected, tree, packageSetDigest: manifest.packageSetDigest },
    ci: { runId: '122', attempt: 1 }, nightly: { runId: '123', attempt: 1, receipt: write('nightly.json', nightly) },
    harness: { commit: harnessCommit, profile: 'local-release-v1', attempts: [{ id: 'first', receipt: write('suite.json', state) }] }, priorCiFailures: [] };
  const options = { expected, manifest, readRunAttempts: () => [], readTree: () => tree,
    readRun: (id, attempt) => ({ id: Number(id), run_attempt: attempt, head_sha: expected.commit,
      repository: { full_name: 'OriginTrail/dkg' }, path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', event: 'workflow_dispatch' }),
    readNightly: () => Buffer.from(JSON.stringify(nightly)), evidenceFile: path.join(root, 'decision.json') };
  const verify = () => { write('decision.json', decision); return verifyReleaseEvidence(options); };
  return { decision, state, nightly, options, write, verify };
}
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
for (const [field, value] of [['status','in_progress'],['conclusion','failure'],['head_sha','wrong'],['path','.github/workflows/optional.yml'],['run_attempt',2],['repository',{ full_name: 'some/fork' }]]) {
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
