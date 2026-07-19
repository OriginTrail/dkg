import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  atomicWriteStableJson,
  readCleanRepositoryHead,
} from '../rfc64-persistence-lifecycle/evidence.js';
import {
  buildGate2PassVerdict,
  verifyGate2ArtifactBytes,
} from './live-verifier.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const artifactPath = process.env.DKG_RFC64_GATE2_ARTIFACT
  ?? join(import.meta.dirname, 'artifacts/gate2-result.json');
const verdictPath = process.env.DKG_RFC64_GATE2_VERDICT_ARTIFACT
  ?? join(import.meta.dirname, 'artifacts/gate2-verdict.json');
const expectedHead = readCleanRepositoryHead(REPO_ROOT);
const verified = verifyGate2ArtifactBytes(readFileSync(artifactPath), expectedHead);
const publication = atomicWriteStableJson(verdictPath, buildGate2PassVerdict(verified));
process.stdout.write(
  `[rfc64-gate2-harness] PASS verdict=${verdictPath} sha256=${publication.sha256}\n`,
);
