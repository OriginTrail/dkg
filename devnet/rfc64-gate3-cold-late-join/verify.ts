import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import {
  atomicWriteStableJson,
  sha256Hex,
  stableJson,
} from './raw-evidence.js';
import { verifyGate3 } from './verdict.js';

/**
 * RFC-64 Gate 3 verifier entrypoint (FIXTURES-ONLY).
 *
 * Reads the generated raw evidence, REQUIRES it to be the exact canonical
 * stable JSON encoding (rejecting tampered / re-serialized input), runs the
 * fail-closed contract verifier, atomically writes the verdict, prints
 * VERDICT_SHA256 and the status, and exits non-zero when the fixture does not
 * satisfy the contract.
 */

const DEFAULT_RAW_ARTIFACT = join(import.meta.dirname, 'artifacts/raw-evidence.json');
const DEFAULT_VERDICT_ARTIFACT = join(import.meta.dirname, 'artifacts/verdict.json');

const rawArtifactPath = process.env.DKG_RFC64_GATE3_RAW_ARTIFACT ?? DEFAULT_RAW_ARTIFACT;
const verdictArtifactPath =
  process.env.DKG_RFC64_GATE3_VERDICT_ARTIFACT ?? DEFAULT_VERDICT_ARTIFACT;

const rawBytes = readStableRegularFile(rawArtifactPath);
let parsed: unknown;
try {
  parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)) as unknown;
} catch (cause) {
  throw new Error('Gate 3 raw evidence is not valid UTF-8 JSON', { cause });
}
if (Buffer.from(stableJson(parsed)).equals(rawBytes) === false) {
  throw new Error('Gate 3 raw evidence is not the exact canonical stable JSON encoding');
}

const verdict = verifyGate3(parsed);
const publication = atomicWriteStableJson(verdictArtifactPath, verdict);

process.stdout.write(`RAW_SHA256=${sha256Hex(rawBytes)}\n`);
process.stdout.write(`VERDICT_SHA256=${publication.sha256}\n`);
process.stdout.write(`VERDICT_STATUS=${verdict.status}\n`);
process.stdout.write(
  `[rfc64-gate3-verifier] productBoundary=${verdict.productBoundary} gateEvaluation=${verdict.gateEvaluation}\n`,
);
process.stdout.write(`[rfc64-gate3-verifier] verdict artifact: ${verdictArtifactPath}\n`);
process.stdout.write(
  '[rfc64-gate3-verifier] fixtures-only: "contract-satisfied" means the fixture matches the contract, NOT that the product passed Gate 3\n',
);

if (verdict.status !== 'contract-satisfied') {
  for (const violation of verdict.violations) {
    process.stderr.write(`[rfc64-gate3-verifier] violation ${violation.id}: ${violation.detail}\n`);
  }
  process.exitCode = 1;
}

function readStableRegularFile(path: string): Buffer {
  const parentTopology = lstatSync(dirname(path));
  if (parentTopology.isSymbolicLink() || !parentTopology.isDirectory()) {
    throw new Error(`Gate 3 artifact parent must be a non-symlink directory: ${dirname(path)}`);
  }
  const beforeTopology = lstatSync(path);
  if (beforeTopology.isSymbolicLink() || !beforeTopology.isFile()) {
    throw new Error(`Gate 3 artifact must be a non-symlink regular file: ${path}`);
  }
  if (process.platform !== 'win32' && (beforeTopology.mode & 0o777) !== 0o600) {
    throw new Error(`Gate 3 artifact must have mode 0600: ${path}`);
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
    throw new Error(`Gate 3 artifact topology changed while it was read: ${path}`);
  }
  return bytes;
}
