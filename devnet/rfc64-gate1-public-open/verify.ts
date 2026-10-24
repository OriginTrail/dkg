import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  atomicWriteStableJson,
  readCleanRepositoryHead,
} from '../rfc64-persistence-lifecycle/evidence.js';
import { GATE1_VERDICT_SCHEMA_VERSION } from './model.js';
import { verifyGate1ArtifactBytes } from './verifier.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const artifactPath = process.env.DKG_RFC64_GATE1_ARTIFACT
  ?? join(import.meta.dirname, 'artifacts/gate1-result.json');
const verdictPath = process.env.DKG_RFC64_GATE1_VERDICT_ARTIFACT
  ?? join(import.meta.dirname, 'artifacts/gate1-verdict.json');
const expectedHead = readCleanRepositoryHead(REPO_ROOT);
const verified = verifyGate1ArtifactBytes(readFileSync(artifactPath), expectedHead);
const publication = atomicWriteStableJson(verdictPath, {
  rawArtifactSha256: verified.rawArtifactSha256,
  schemaVersion: GATE1_VERDICT_SCHEMA_VERSION,
  scope: 'production-gate1-public-open',
  sourceCommit: verified.sourceCommit,
  status: 'PASS',
});
process.stdout.write(
  `[rfc64-gate1-harness] PASS verdict=${verdictPath} sha256=${publication.sha256}\n`,
);
