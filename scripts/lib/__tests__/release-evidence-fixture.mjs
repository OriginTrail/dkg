import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hash } from '../package-certification/bundle.mjs';
import { summarizeNightlyProfile, LIFECYCLE_FILE, LIFECYCLE_TESTS, LIFT_TEST } from '../../ci/nightly-profile-results.mjs';
import { verifyReleaseEvidence } from '../release-evidence.mjs';
// Deliberately independent from the verifier's membership constants.
const steps = ['matrix:unregistered-00','matrix:unregistered-01','matrix:unregistered-10','matrix:unregistered-11',
  'matrix:registered-00','matrix:registered-01','matrix:registered-10','matrix:registered-11','functional:six','overlap:share-publish'];
const scenarios = ['convergence','recovery','concurrency','attestation','public-p2p-join','private-unregistered-recovery','literals','member-writes'];
export function fixture(t, { expected = { commit: 'a'.repeat(40), version: '10.0.27', sourceInputsDigest: 'd'.repeat(64) },
  manifest = { packageSetDigest: 'e'.repeat(64) }, tree = 'c'.repeat(40) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-evidence-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const harnessCommit = 'b'.repeat(40);
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
