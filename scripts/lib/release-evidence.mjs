// Release decisions bind existing receipts; they do not manufacture test results.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { relativeFile, hash } from './package-certification/bundle.mjs';
import { validateReleaseDecision, qualifyReleaseEvidence, hasNightly, selectedRuns } from './release-evidence-qualification.mjs';
export { HARNESS_PROFILE, HARNESS_STEPS, HARNESS_SCENARIOS } from './release-evidence-qualification.mjs';
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
    '--jq', '.workflow_runs[]'], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const attempts = new Map();
  for (const line of listing.trim().split('\n').filter(Boolean)) {
    const run = JSON.parse(line);
    attempts.set(`${run.id}/${run.run_attempt}`, run);
    for (let attempt = 1; attempt < run.run_attempt; attempt++) {
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
function artifactBytes(root, descriptor) {
  const file = relativeFile(root, descriptor.file);
  const bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), descriptor.sha256, `changed evidence: ${descriptor.file}`);
  return bytes;
}
function acquireEvidence({ decision, root, expected, readRun, readRunAttempts, readNightly, decisionSha256 }) {
  const history = readRunAttempts(expected.commit);
  const runs = new Map(history.map(run => [`${run.id}/${run.run_attempt}`, run]));
  const descriptors = [...selectedRuns(decision), ...decision.priorCiFailures];
  for (const descriptor of descriptors) {
    const key = `${descriptor.runId}/${descriptor.attempt}`;
    if (!runs.has(key)) runs.set(key, readRun(descriptor.runId, descriptor.attempt));
  }
  // Without a nightly run there is no receipt to read and no Actions artifact to download.
  const nightly = hasNightly(decision) ? JSON.parse(artifactBytes(root, decision.nightly.receipt).toString('utf8')) : null;
  const authenticatedNightlyDigest = hasNightly(decision) ? hash(readNightly(decision.nightly.runId, decision.nightly.attempt)) : null;
  const harnessReceipts = decision.harness.attempts.map(attempt => JSON.parse(artifactBytes(root, attempt.receipt).toString('utf8')));
  return { decision, expected, history, runs, nightly, authenticatedNightlyDigest, harnessReceipts, decisionSha256 };
}

export function prepareReleaseEvidence({ evidenceFile, expected, manifest, rootDir, readRun = githubRun,
  readNightly = githubNightlyReceipt, readRunAttempts = githubRunAttempts,
  readTree = commit => execFileSync('git', ['rev-parse', `${commit}^{tree}`], { cwd: rootDir, encoding: 'utf8' }).trim(),
}) {
  assert.ok(typeof evidenceFile === 'string' && evidenceFile, 'release decision file is required');
  const bytes = fs.readFileSync(evidenceFile), decision = JSON.parse(bytes.toString('utf8'));
  validateReleaseDecision(decision, { expected, manifest, tree: readTree(expected.commit) });
  const snapshot = acquireEvidence({ decision, root: path.dirname(evidenceFile), expected,
    readRun, readRunAttempts, readNightly, decisionSha256: hash(bytes) });
  const result = qualifyReleaseEvidence(snapshot);
  // This closure checks only local bytes captured by this qualification. It is
  // safe after OTP entry: all GitHub acquisition completed before the prompt.
  return { result, recheckLocalIntegrity() {
    assert.equal(hash(fs.readFileSync(evidenceFile)), snapshot.decisionSha256, 'release decision changed after qualification');
    if (hasNightly(decision)) artifactBytes(path.dirname(evidenceFile), decision.nightly.receipt);
    for (const attempt of decision.harness.attempts) artifactBytes(path.dirname(evidenceFile), attempt.receipt);
  } };
}
export function verifyReleaseEvidence(options) {
  return prepareReleaseEvidence(options).result;
}
