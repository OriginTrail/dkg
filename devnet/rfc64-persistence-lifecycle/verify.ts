import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import {
  atomicWriteStableJson,
  readCleanRepositoryHead,
} from './evidence.js';
import {
  GATE0_RAW_SCHEMA_VERSION,
  GATE0_VERDICT_SCHEMA_VERSION,
  verifyGate0ArtifactBytes,
} from './verifier.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const DEFAULT_RAW_ARTIFACT = join(import.meta.dirname, 'artifacts/gate0-result.json');
const DEFAULT_VERDICT_ARTIFACT = join(import.meta.dirname, 'artifacts/gate0-verdict.json');

const rawArtifactPath = resolve(
  process.env.DKG_RFC64_GATE0_ARTIFACT ?? DEFAULT_RAW_ARTIFACT,
);
const verdictArtifactPath = resolve(
  process.env.DKG_RFC64_GATE0_VERDICT_ARTIFACT ?? DEFAULT_VERDICT_ARTIFACT,
);

const sourceCommit = readCleanRepositoryHead(REPO_ROOT);
const rawBytes = readStableRegularFile(rawArtifactPath);
const verified = verifyGate0ArtifactBytes(rawBytes, sourceCommit, process.platform);
const finalSourceCommit = readCleanRepositoryHead(REPO_ROOT);
if (finalSourceCommit !== sourceCommit) {
  throw new Error(
    `Repository HEAD changed during Gate 0 verification: ${sourceCommit} -> ${finalSourceCommit}`,
  );
}

const verdict = {
  schemaVersion: GATE0_VERDICT_SCHEMA_VERSION,
  verdict: 'pass',
  scope: 'OT-RFC-64 Gate 0 lifecycle evidence verifier',
  sourceCommit,
  rawArtifact: {
    schemaVersion: GATE0_RAW_SCHEMA_VERSION,
    sha256: verified.rawArtifactSha256,
  },
};
const verdictPublication = atomicWriteStableJson(verdictArtifactPath, verdict);
process.stdout.write(`[rfc64-gate0-verifier] raw artifact SHA-256: ${verified.rawArtifactSha256}\n`);
process.stdout.write(`[rfc64-gate0-verifier] verdict artifact: ${verdictArtifactPath}\n`);
process.stdout.write(`[rfc64-gate0-verifier] verdict SHA-256: ${verdictPublication.sha256}\n`);
process.stdout.write('PASS: Gate 0 lifecycle evidence verified\n');

function readStableRegularFile(path: string): Buffer {
  const parentTopology = lstatSync(dirname(path));
  if (parentTopology.isSymbolicLink() || !parentTopology.isDirectory()) {
    throw new Error(`Gate 0 artifact parent must be a non-symlink directory: ${dirname(path)}`);
  }
  const beforeTopology = lstatSync(path);
  if (beforeTopology.isSymbolicLink() || !beforeTopology.isFile()) {
    throw new Error(`Gate 0 artifact must be a non-symlink regular file: ${path}`);
  }
  if (process.platform !== 'win32' && (beforeTopology.mode & 0o777) !== 0o600) {
    throw new Error(`Gate 0 artifact must have mode 0600: ${path}`);
  }
  const beforeIdentity = statSync(path, { bigint: true });
  const bytes = readFileSync(path);
  const afterTopology = lstatSync(path);
  const afterIdentity = statSync(path, { bigint: true });
  if (
    afterTopology.isSymbolicLink()
    || !afterTopology.isFile()
    || beforeIdentity.dev !== afterIdentity.dev
    || beforeIdentity.ino !== afterIdentity.ino
    || beforeIdentity.size !== afterIdentity.size
    || BigInt(bytes.byteLength) !== afterIdentity.size
  ) {
    throw new Error(`Gate 0 artifact topology changed while it was read: ${path}`);
  }
  return bytes;
}
