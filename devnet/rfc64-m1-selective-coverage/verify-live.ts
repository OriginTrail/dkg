import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readCleanRepositoryHead } from '../rfc64-persistence-lifecycle/evidence.ts';
import { buildGate2RuntimeManifestV1 } from
  '../rfc64-gate2-multi-asset-completeness/runtime-provenance.ts';
import { readExpectedSelectiveCoverageProvenance } from './operator-input.ts';
import { verifySelectiveCoverage } from './verifier.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const trustAnchorPath = resolve(requiredEnvironment('DKG_RFC64_M1_TRUST_ANCHOR_FILE'));
const artifactPath = resolve(
  process.env['DKG_RFC64_M1_ARTIFACT']
    ?? resolve(import.meta.dirname, 'artifacts/selective-coverage-evidence.json'),
);
const expected = readExpectedSelectiveCoverageProvenance(trustAnchorPath);
const sourceCommit = readCleanRepositoryHead(repoRoot);
if (sourceCommit !== expected.testedHeadCommit) {
  throw new Error('M1 trust anchor names a different checked-out source commit');
}
const runtimeManifest = buildGate2RuntimeManifestV1(repoRoot, sourceCommit);
if (runtimeManifest.manifestDigest !== expected.runtimeManifestDigest) {
  throw new Error('M1 trust anchor names a different built runtime manifest');
}
const evidence = JSON.parse(readFileSync(artifactPath, 'utf8'));
const verdict = verifySelectiveCoverage(evidence, expected);
if (!verdict.pass) {
  throw new Error(`M1 evidence rejected: ${verdict.rejectReasons.join('; ')}`);
}
process.stdout.write(`[rfc64-m1] VERIFIED ${artifactPath}\n`);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
