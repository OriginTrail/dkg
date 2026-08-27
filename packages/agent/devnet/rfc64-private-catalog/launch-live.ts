import { resolve } from 'node:path';

import { runRfc64PrivateGateFromCleanBuildV1 } from './clean-launch.ts';
import { sanitizeGateFailureV1 } from './gate-artifact.mjs';
import {
  executeRfc64PrivateReleaseGateV1,
  RFC64_PRIVATE_GATE_ARTIFACT_PATH,
} from './run.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');

try {
  const artifact = await runRfc64PrivateGateFromCleanBuildV1({
    artifactPath: RFC64_PRIVATE_GATE_ARTIFACT_PATH,
    execute: executeRfc64PrivateReleaseGateV1,
    repoRoot,
  });
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(
    `RFC-64 private Releases 1-3 four-process gate: ${artifact.status}\n`,
  );
} catch (error) {
  const failure = sanitizeGateFailureV1(error);
  process.stderr.write(
    `RFC-64 private release gate failed (${failure.failureClass})\n`,
  );
  process.exitCode = 1;
}
