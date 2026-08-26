import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RFC64_RUNTIME_EVIDENCE_PROFILE_V1,
  buildExecutedRuntimeManifestV1,
  type ExecutedRuntimeManifestV1,
  type RuntimeEvidenceProfileV1,
  type RuntimeFileEvidenceV1,
} from './rfc64-runtime-provenance.mts';

const REPO_ROOT = realpathSync.native(resolve(import.meta.dirname, '..'));
const sourceCommitInput = process.env.DKG_RFC64_RUNTIME_SOURCE_COMMIT;
if (sourceCommitInput === undefined || !/^[0-9a-f]{40,64}$/u.test(sourceCommitInput)) {
  throw new Error('DKG_RFC64_RUNTIME_SOURCE_COMMIT is required by the runtime load hook');
}
const SOURCE_COMMIT: string = sourceCommitInput;

const RUNTIME_PATH = /^packages\/[^/]+\/dist\/.+\.(?:js|json|node|wasm)$/u;
const loaded = new Map<string, RuntimeFileEvidenceV1>();
let sealed = false;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    const url = result.url;
    if (!url.startsWith('file:')) return result;
    const absolutePath = realpathSync.native(fileURLToPath(url));
    const path = relative(REPO_ROOT, absolutePath).split(sep).join('/');
    if (!RUNTIME_PATH.test(path)) return result;
    if (sealed) throw new Error(`workspace runtime artifact resolved after provenance seal: ${path}`);
    const bytes = readFileSync(absolutePath);
    const entry = Object.freeze({
      byteLength: bytes.byteLength,
      path,
      sha256: `0x${createHash('sha256').update(bytes).digest('hex')}`,
    });
    const previous = loaded.get(path);
    if (
      previous !== undefined
      && (previous.byteLength !== entry.byteLength || previous.sha256 !== entry.sha256)
    ) {
      throw new Error(`workspace runtime artifact changed between module resolutions: ${path}`);
    }
    loaded.set(path, entry);
    return result;
  },
});

export function sealExecutedRuntimeManifestV1(
  profile: RuntimeEvidenceProfileV1 = RFC64_RUNTIME_EVIDENCE_PROFILE_V1,
): Readonly<ExecutedRuntimeManifestV1> {
  if (sealed) throw new Error('runtime loader manifest was already sealed');
  sealed = true;
  if (loaded.size < 1) throw new Error('runtime loader hook observed no workspace dist artifacts');
  return buildExecutedRuntimeManifestV1(SOURCE_COMMIT, [...loaded.values()], profile);
}
