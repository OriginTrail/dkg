import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readCleanRepositoryHead } from '../rfc64-persistence-lifecycle/evidence.js';
import { buildGate2RuntimeManifestV1 } from
  '../rfc64-runtime-provenance.mts';
import { verifyCp1PublicSwmParity } from './verifier.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const path = process.env.DKG_RFC64_CP1_ARTIFACT
  ?? join(import.meta.dirname, 'artifacts/cp1-public-swm-parity.json');
const testedHeadCommit = readCleanRepositoryHead(repoRoot);
const runtimeManifestDigest = buildGate2RuntimeManifestV1(
  repoRoot,
  testedHeadCommit,
).manifestDigest;
verifyCp1PublicSwmParity(JSON.parse(readFileSync(path, 'utf8')), {
  runtimeManifestDigest,
  testedHeadCommit,
});
process.stdout.write(`[rfc64-cp1] PASS ${path}\n`);
