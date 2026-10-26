// Release decisions bind existing receipts; they do not manufacture test results.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileIdentity, readJson, relativeFile, hash } from './package-certification/bundle.mjs';
import { summarizeNightlyProfile } from '../ci/nightly-profile-results.mjs';
export const HARNESS_PROFILE = 'local-release-v1';
export const HARNESS_STEPS = Object.freeze([
  'matrix:unregistered-00', 'matrix:unregistered-01', 'matrix:unregistered-10', 'matrix:unregistered-11',
  'matrix:registered-00', 'matrix:registered-01', 'matrix:registered-10', 'matrix:registered-11',
  'functional:six', 'overlap:share-publish',
]);
export const HARNESS_SCENARIOS = Object.freeze(['convergence', 'recovery', 'concurrency', 'attestation',
  'public-p2p-join', 'private-unregistered-recovery', 'literals', 'member-writes']);
export function githubRun(runId, attempt) {
  assert.match(String(runId), /^[1-9]\d*$/);
  assert.ok(Number.isInteger(attempt) && attempt > 0, 'invalid run attempt');
  return JSON.parse(execFileSync('gh', ['api', `repos/OriginTrail/dkg/actions/runs/${runId}/attempts/${attempt}`],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }));
}
export function githubRunAttempts(commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const listing = execFileSync('gh', ['api', '--paginate', '-X', 'GET',
    'repos/OriginTrail/dkg/actions/workflows/ci.yml/runs', '-f', `head_sha=${commit}`, '-f', 'per_page=100',
    '--jq', '.workflow_runs[] | {id, run_attempt}'], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const attempts = new Map();
  for (const line of listing.trim().split('\n').filter(Boolean)) {
    const run = JSON.parse(line);
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      const key = `${run.id}/${attempt}`;
      if (!attempts.has(key)) attempts.set(key, githubRun(run.id, attempt));
    }
  }
  return [...attempts.values()];
}
export function githubNightlyReceipt(runId, attempt) {
  const current = JSON.parse(execFileSync('gh', ['api', `repos/OriginTrail/dkg/actions/runs/${runId}`], { encoding: 'utf8', timeout: 30000 }));
  assert.equal(current.run_attempt, attempt, 'only the latest nightly attempt artifact is eligible');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-nightly-evidence-'));
  try {
    execFileSync('gh', ['run', 'download', String(runId), '--repo', 'OriginTrail/dkg', '--name', 'nightly-profile-summary', '--dir', dir], { timeout: 120000, stdio: 'pipe' });
    return fs.readFileSync(path.join(dir, 'nightly-profile-summary.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function validateRunIdentity(actual, descriptor, commit) {
  assert.equal(String(actual.id), String(descriptor.runId), 'wrong run ID');
  assert.equal(actual.run_attempt, descriptor.attempt, 'wrong run attempt');
  assert.equal(actual.repository?.full_name, 'OriginTrail/dkg', 'wrong run repository');
  assert.match(actual.path ?? '', /^\.github\/workflows\/ci\.yml(?:@.+)?$/, 'wrong workflow');
  assert.equal(actual.head_sha, commit, 'run tested a different commit');
}
function successfulRun(descriptor, commit, readRun) {
  const actual = readRun(descriptor.runId, descriptor.attempt);
  validateRunIdentity(actual, descriptor, commit);
  // PR API head_sha identifies the branch even when checkout tests a synthetic
  // merge. Only direct-subject runs can certify the prepared candidate here.
  assert.ok(['push', 'workflow_dispatch', 'schedule'].includes(actual.event), 'CI must test the candidate directly, not a PR merge');
  assert.equal(actual.status, 'completed', 'run is incomplete');
  assert.equal(actual.conclusion, 'success', 'run did not succeed');
  return actual;
}
function artifact(root, descriptor) {
  assert.match(descriptor?.sha256 ?? '', /^[a-f0-9]{64}$/, 'missing artifact digest');
  const file = relativeFile(root, descriptor.file);
  assert.equal(fileIdentity(file).sha256, descriptor.sha256, `changed evidence: ${descriptor.file}`);
  return readJson(file);
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
export function verifyReleaseEvidence({ evidenceFile, expected, manifest, rootDir, readRun = githubRun, readNightly = githubNightlyReceipt, readRunAttempts = githubRunAttempts,
  readTree = commit => execFileSync('git', ['rev-parse', `${commit}^{tree}`], { cwd: rootDir, encoding: 'utf8' }).trim(),
}) {
  assert.ok(typeof evidenceFile === 'string' && evidenceFile, 'release decision file is required');
  const decision = readJson(evidenceFile), root = path.dirname(evidenceFile);
  assert.equal(decision.schemaVersion, 1, 'release decision schema');
  assert.deepEqual(decision.candidate, { commit: expected.commit, tree: readTree(expected.commit), version: expected.version,
    sourceInputsDigest: expected.sourceInputsDigest, packageSetDigest: manifest.packageSetDigest }, 'stale candidate/package identity');
  assert.match(decision.harness?.commit ?? '', /^[a-f0-9]{40}$/, 'full harness commit required');
  assert.equal(decision.harness.profile, HARNESS_PROFILE, 'wrong harness profile');
  // Snapshot acquisition belongs to this invocation only. The pre-publication
  // verification gets fresh history, including reruns that arrived since review.
  const history = readRunAttempts(expected.commit);
  const runs = new Map(history.map(run => [`${run.id}/${run.run_attempt}`, run]));
  const getRun = (id, attempt) => {
    const key = `${id}/${attempt}`;
    if (!runs.has(key)) runs.set(key, readRun(id, attempt));
    return runs.get(key);
  };
  successfulRun(decision.ci, expected.commit, getRun);
  const nightlyRun = successfulRun(decision.nightly, expected.commit, getRun);
  assert.ok(['workflow_dispatch', 'schedule'].includes(nightlyRun.event), 'nightly must be a full dispatched or scheduled run');
  const nightly = artifact(root, decision.nightly.receipt);
  assert.equal(hash(readNightly(decision.nightly.runId, decision.nightly.attempt)), decision.nightly.receipt.sha256, 'nightly receipt differs from authenticated Actions artifact');
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
  // Every recorded attempt is retained. A superseding attempt must be later,
  // complete, and bound to the same candidate and harness; classification alone
  // cannot dismiss a failed run. This is not a claim of exhaustive external history.
  assert.ok(Array.isArray(decision.harness.attempts) && decision.harness.attempts.length, 'missing harness attempts');
  const ids = new Set();
  const attempts = decision.harness.attempts.map(attempt => {
    assert.ok(typeof attempt.id === 'string' && attempt.id && !ids.has(attempt.id), 'missing/duplicate attempt');
    ids.add(attempt.id);
    const state = artifact(root, attempt.receipt);
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
  assert.ok(Array.isArray(decision.priorCiFailures), 'prior CI failure inventory is required (may be empty)');
  const historicalFailures = history.filter(run => ['failure', 'cancelled', 'timed_out'].includes(run.conclusion));
  for (const run of historicalFailures) assert.ok(decision.priorCiFailures.some(row => String(row.runId) === String(run.id)
    && row.attempt === run.run_attempt), `omitted failed CI attempt: ${run.id}/${run.run_attempt}`);
  assert.equal(new Set(decision.priorCiFailures.map(row => `${row.runId}/${row.attempt}`)).size, decision.priorCiFailures.length, 'duplicate prior CI failure');
  for (const failure of decision.priorCiFailures) {
    const actual = getRun(failure.runId, failure.attempt);
    validateRunIdentity(actual, failure, expected.commit);
    assert.ok(['failure', 'cancelled', 'timed_out'].includes(actual.conclusion), 'prior failure is not a failed run');
    assert.ok(['product', 'test', 'environment', 'unknown'].includes(failure.classification), 'CI failure lacks classification');
    assert.match(failure.issue ?? '', /^https:\/\/github\.com\/OriginTrail\/dkg\/issues\/\d+$/, 'CI failure needs an owning issue');
    const replacement = [decision.ci, decision.nightly].find(row => String(row.runId) === String(failure.supersededBy?.runId)
      && row.attempt === failure.supersededBy?.attempt);
    assert.ok(replacement, 'unresolved CI failure');
    const next = getRun(replacement.runId, replacement.attempt);
    assert.ok(Date.parse(next.run_started_at) > Date.parse(actual.run_started_at), 'replacement must follow failure');
  }
  return { outcome: 'PASS', candidate: decision.candidate, harness: { commit: decision.harness.commit, profile: HARNESS_PROFILE },
    decisionSha256: fileIdentity(evidenceFile).sha256 };
}
