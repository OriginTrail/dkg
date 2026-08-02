import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { buildGate2RuntimeManifestV1 } from
  '../rfc64-gate2-multi-asset-completeness/runtime-provenance.ts';

const repoRoot = resolve(process.argv[2] ?? '.');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const manifest = buildGate2RuntimeManifestV1(repoRoot, sourceCommit);
process.stdout.write(`${JSON.stringify({
  sourceCommit,
  runtimeManifestDigest: manifest.manifestDigest,
})}\n`);

