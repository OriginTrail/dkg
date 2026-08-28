// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';

import { createRuntimeLoadEvidenceV1 } from './rfc64-runtime-load-evidence.mts';
import {
  RFC64_RUNTIME_EVIDENCE_V1,
  type ExecutedRuntimeManifestForProfileV1,
  type RuntimeEvidenceProfileV1,
  type RuntimeEvidenceV1,
} from './rfc64-runtime-provenance.mts';

const sourceCommitInput = process.env.DKG_RFC64_RUNTIME_SOURCE_COMMIT;
if (sourceCommitInput === undefined || !/^[0-9a-f]{40,64}$/u.test(sourceCommitInput)) {
  throw new Error('DKG_RFC64_RUNTIME_SOURCE_COMMIT is required by the runtime load hook');
}

const runtimeLoadEvidence = createRuntimeLoadEvidenceV1({
  repoRoot: realpathSync.native(resolve(import.meta.dirname, '..')),
  sourceCommit: sourceCommitInput,
});
registerHooks({
  load: runtimeLoadEvidence.load,
  resolve: runtimeLoadEvidence.resolve,
});

export function createExecutedRuntimeManifestSealerV1<
  Profile extends RuntimeEvidenceProfileV1,
>(
  runtimeEvidence: RuntimeEvidenceV1<Profile>,
): () => Readonly<ExecutedRuntimeManifestForProfileV1<Profile>> {
  return runtimeLoadEvidence.createSealer(runtimeEvidence);
}

export const sealExecutedRuntimeManifestV1 =
  createExecutedRuntimeManifestSealerV1(RFC64_RUNTIME_EVIDENCE_V1);
