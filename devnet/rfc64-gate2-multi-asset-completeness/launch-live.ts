import { resolve } from 'node:path';

import { readCleanRepositoryHead } from '../rfc64-persistence-lifecycle/evidence.js';
import {
  buildGate2RuntimeManifestV1,
  installGate2RuntimeLaunchReceiptV1,
  runGate2CleanRuntimeBuildV1,
} from './runtime-provenance.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const sourceCommit = readCleanRepositoryHead(repoRoot);
runGate2CleanRuntimeBuildV1(repoRoot);
const headAfterBuild = readCleanRepositoryHead(repoRoot);
if (headAfterBuild !== sourceCommit) {
  throw new Error('Gate 2 source HEAD changed during the clean runtime build');
}
const manifest = buildGate2RuntimeManifestV1(repoRoot, sourceCommit);
installGate2RuntimeLaunchReceiptV1({ manifest, sourceCommit });
await import('./run.ts');
