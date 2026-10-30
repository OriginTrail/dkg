// Pure qualification of one acquired candidate-evidence snapshot.
import assert from 'node:assert/strict';
import { summarizeNightlyProfile } from '../ci/nightly-profile-results.mjs';
export const HARNESS_PROFILE = 'local-release-v1';
export const HARNESS_STEPS = Object.freeze([
  'matrix:unregistered-00', 'matrix:unregistered-01', 'matrix:unregistered-10', 'matrix:unregistered-11',
  'matrix:registered-00', 'matrix:registered-01', 'matrix:registered-10', 'matrix:registered-11',
  'functional:six', 'overlap:share-publish',
]);
export const HARNESS_SCENARIOS = Object.freeze(['convergence', 'recovery', 'concurrency', 'attestation',
  'public-p2p-join', 'private-unregistered-recovery', 'literals', 'member-writes']);
function validateRunIdentity(actual, descriptor, commit) {
  assert.equal(String(actual.id), String(descriptor.runId), 'wrong run ID');
  assert.equal(actual.run_attempt, descriptor.attempt, 'wrong run attempt');
  assert.equal(actual.repository?.full_name, 'OriginTrail/dkg', 'wrong run repository');
  assert.match(actual.path ?? '', /^\.github\/workflows\/ci\.yml(?:@.+)?$/, 'wrong workflow');
  assert.equal(actual.head_sha, commit, 'run tested a different commit');
}
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);
const isFailedRun = run => FAILURE_CONCLUSIONS.has(run.conclusion);
function successfulRun(descriptor, commit, runs) {
  const actual = runs.get(`${descriptor.runId}/${descriptor.attempt}`);
  validateRunIdentity(actual, descriptor, commit);
  // PR API head_sha identifies the branch even when checkout tests a synthetic
  // merge. Only direct-subject runs can certify the prepared candidate here.
  assert.ok(['push', 'workflow_dispatch', 'schedule'].includes(actual.event), 'CI must test the candidate directly, not a PR merge');
  assert.equal(actual.status, 'completed', 'run is incomplete');
  assert.equal(actual.conclusion, 'success', 'run did not succeed');
  return actual;
}
function verifyHarness(state, candidate, harness) {
  assert.ok(state && typeof state === 'object' && !Array.isArray(state), 'harness receipt must be an object');
  assert.equal(state.status, 'complete', 'harness incomplete');
  assert.equal(state.dkgCommit, candidate.commit, 'harness tested a different product');
  assert.equal(state.harnessCommit, harness.commit, 'wrong harness commit');
  assert.deepEqual(state.requiredSteps, HARNESS_STEPS, 'missing/changed required harness step');
  assert.equal(state.matrixGrade?.result, 'PASS', 'matrix did not pass');
  assert.ok(!state.matrixGrade?.failures?.length && !state.matrixGrade?.missing?.length, 'matrix contradicts PASS');
  for (const step of HARNESS_STEPS) {
    const row = state.steps?.[step];
    assert.equal(row?.result, 'PASS', `required harness step failed: ${step}`);
    assert.equal(row.exit, 0, `harness process failed: ${step}`);
    assert.ok(typeof row.runId === 'string' && row.runId, `missing harness run identity: ${step}`);
    assert.equal(row.buildsVerified, true, `unverified node builds: ${step}`);
    assert.equal(row.dkgCommit, candidate.commit, 'step tested a different product');
    assert.equal(row.harnessCommit, harness.commit, 'step used a different harness');
    assert.ok(!row.failures?.length && !row.missing?.length, `contradictory harness result: ${step}`);
  }
  for (const name of HARNESS_SCENARIOS) assert.equal(state.steps['functional:six'].scenarios?.[name]?.outcome,
    'PASS', `missing/failed scenario: ${name}`);
}
function object(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}
function runDescriptor(value, label) {
  object(value, label);
  assert.ok((typeof value.runId === 'string' && /^[1-9]\d*$/.test(value.runId))
    || (Number.isSafeInteger(value.runId) && value.runId > 0), `${label} requires a positive run ID`);
  assert.ok(Number.isSafeInteger(value.attempt) && value.attempt > 0, `${label} requires a positive run attempt`);
}
function receiptDescriptor(value, label) {
  object(value, label);
  assert.ok(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), `${label} requires an artifact digest`);
  assert.ok(typeof value.file === 'string' && value.file && !value.file.includes('\\')
    && !value.file.startsWith('/') && value.file.split('/').every(part => part && part !== '.' && part !== '..'),
  `${label} requires a safe relative artifact path`);
}
// A full nightly run is optional evidence; a decision that names one names it completely.
export const hasNightly = decision => decision.nightly !== undefined && decision.nightly !== null;
export const selectedRuns = decision => hasNightly(decision) ? [decision.ci, decision.nightly] : [decision.ci];
function validateDecisionShape(decision) {
  object(decision, 'release decision');
  runDescriptor(decision.ci, 'ci');
  if (hasNightly(decision)) {
    runDescriptor(decision.nightly, 'nightly');
    receiptDescriptor(decision.nightly.receipt, 'nightly receipt');
  }
  object(decision.harness, 'harness');
  assert.ok(Array.isArray(decision.harness.attempts) && decision.harness.attempts.length, 'missing harness attempts');
  const ids = new Set();
  for (const attempt of decision.harness.attempts) {
    object(attempt, 'harness attempt');
    assert.ok(typeof attempt.id === 'string' && attempt.id && !ids.has(attempt.id), 'missing/duplicate attempt');
    ids.add(attempt.id);
    receiptDescriptor(attempt.receipt, 'harness receipt');
    if (attempt.resolution !== undefined) {
      object(attempt.resolution, 'harness resolution');
      for (const field of ['classification', 'issue', 'supersededBy'])
        assert.ok(typeof attempt.resolution[field] === 'string' && attempt.resolution[field], `missing harness resolution ${field}`);
    }
  }
  assert.ok(Array.isArray(decision.priorCiFailures), 'prior CI failure inventory is required (may be empty)');
  for (const failure of decision.priorCiFailures) {
    runDescriptor(failure, 'prior CI failure');
    assert.ok(typeof failure.classification === 'string', 'CI failure lacks classification');
    assert.ok(typeof failure.issue === 'string', 'CI failure needs an owning issue');
    runDescriptor(failure.supersededBy, 'replacement CI');
  }
  assert.equal(new Set(decision.priorCiFailures.map(row => `${row.runId}/${row.attempt}`)).size,
    decision.priorCiFailures.length, 'duplicate prior CI failure');
}
export function validateReleaseDecision(decision, { expected, manifest, tree }) {
  validateDecisionShape(decision);
  assert.equal(decision.schemaVersion, 1, 'release decision schema');
  assert.deepEqual(decision.candidate, { commit: expected.commit, tree: tree, version: expected.version,
    sourceInputsDigest: expected.sourceInputsDigest, packageSetDigest: manifest.packageSetDigest }, 'stale candidate/package identity');
  assert.ok(typeof decision.harness.commit === 'string' && /^[a-f0-9]{40}$/.test(decision.harness.commit), 'full harness commit required');
  assert.equal(decision.harness.profile, HARNESS_PROFILE, 'wrong harness profile');
}
function qualifyNightly({ decision, expected, runs, nightly, authenticatedNightlyDigest }) {
  const nightlyRun = successfulRun(decision.nightly, expected.commit, runs);
  assert.ok(['workflow_dispatch', 'schedule'].includes(nightlyRun.event), 'nightly must be a full dispatched or scheduled run');
  assert.equal(authenticatedNightlyDigest, decision.nightly.receipt.sha256, 'nightly receipt differs from authenticated Actions artifact');
  assert.equal(nightly.profile, 'nightly-equivalent', 'ordinary CI cannot certify nightly');
  assert.equal(nightly.subject, expected.commit, 'nightly receipt subject mismatch');
  assert.equal(nightly.runId, String(decision.nightly.runId), 'nightly receipt run mismatch');
  assert.equal(String(nightly.attempt), String(decision.nightly.attempt), 'nightly receipt attempt mismatch');
  assert.equal(nightly.status, 'passed', 'nightly receipt did not pass');
  assert.deepEqual(nightly.errors, [], 'nightly receipt has errors');
  const recalculated = summarizeNightlyProfile({ profile: nightly,
    needs: Object.fromEntries(Object.entries(nightly.jobs).map(([job, result]) => [job, { result }])),
    browsers: nightly.browsers, campaigns: nightly.campaigns });
  assert.equal(recalculated.status, 'passed', `nightly evidence incomplete: ${recalculated.errors.join('; ')}`);
}
function qualifyHarnessHistory({ decision, harnessReceipts }) {
  // Every recorded attempt is retained. A superseding attempt must be later,
  // complete, and bound to the same candidate and harness; classification alone
  // cannot dismiss a failed run. This is not a claim of exhaustive external history.
  const attempts = decision.harness.attempts.map((attempt, index) => {
    const state = harnessReceipts[index];
    let validationError = null;
    try { verifyHarness(state, decision.candidate, decision.harness); } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      validationError = error;
    }
    return { ...attempt, state, passed: validationError === null, validationError };
  });
  const latest = attempts.at(-1);
  assert.ok(latest.passed, `latest harness attempt ${latest.id} did not qualify: ${latest.validationError?.message}`);
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (attempt.passed) continue;
    const resolution = attempt.resolution;
    const rejection = `harness attempt ${attempt.id}: ${attempt.validationError.message}`;
    assert.ok(['product', 'test', 'environment', 'unknown'].includes(resolution?.classification), `${rejection}; failure lacks classification`);
    assert.match(resolution?.issue ?? '', /^https:\/\/github\.com\/OriginTrail\/(dkg|dkg-blackbox-harness)\/issues\/\d+$/, `${rejection}; failure needs an owning issue`);
    assert.ok(attempts.slice(i + 1).some(row => row.id === resolution.supersededBy && row.passed), `unresolved required failure ${attempt.id}: ${attempt.validationError.message}`);
  }
}
function qualifyCiHistory({ decision, expected, runs, history }) {
  const historicalFailures = history.filter(isFailedRun);
  for (const run of historicalFailures) assert.ok(decision.priorCiFailures.some(row => String(row.runId) === String(run.id)
    && row.attempt === run.run_attempt), `omitted failed CI attempt: ${run.id}/${run.run_attempt}`);
  for (const failure of decision.priorCiFailures) {
    const actual = runs.get(`${failure.runId}/${failure.attempt}`);
    validateRunIdentity(actual, failure, expected.commit);
    assert.ok(isFailedRun(actual), 'prior failure is not a failed run');
    assert.ok(['product', 'test', 'environment', 'unknown'].includes(failure.classification), 'CI failure lacks classification');
    assert.match(failure.issue ?? '', /^https:\/\/github\.com\/OriginTrail\/dkg\/issues\/\d+$/, 'CI failure needs an owning issue');
    const replacement = selectedRuns(decision).find(row => String(row.runId) === String(failure.supersededBy?.runId)
      && row.attempt === failure.supersededBy?.attempt);
    assert.ok(replacement, 'unresolved CI failure');
    const next = runs.get(`${replacement.runId}/${replacement.attempt}`);
    assert.ok(Date.parse(next.run_started_at) > Date.parse(actual.run_started_at), 'replacement must follow failure');
  }
}
export function qualifyReleaseEvidence(snapshot) {
  const { decision } = snapshot;
  successfulRun(decision.ci, snapshot.expected.commit, snapshot.runs);
  if (hasNightly(decision)) qualifyNightly(snapshot);
  qualifyHarnessHistory(snapshot);
  qualifyCiHistory(snapshot);
  return { outcome: 'PASS', candidate: decision.candidate,
    nightly: hasNightly(decision) ? { runId: String(decision.nightly.runId), attempt: decision.nightly.attempt } : null,
    harness: { commit: decision.harness.commit, profile: HARNESS_PROFILE },
    decisionSha256: snapshot.decisionSha256 };
}
