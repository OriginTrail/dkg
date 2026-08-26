// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import type { LoadHookSync, ResolveHookSync } from 'node:module';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ExecutedRuntimeManifestForProfileV1,
  RuntimeEvidenceProfileV1,
  RuntimeEvidenceV1,
  RuntimeFileEvidenceV1,
} from './rfc64-runtime-provenance.mts';

const RUNTIME_PATH = /^packages\/[^/]+\/dist\/.+\.(?:js|json|node|wasm)$/u;

export interface RuntimeLoadEvidenceV1 {
  readonly resolve: ResolveHookSync;
  readonly load: LoadHookSync;
  readonly createSealer: <Profile extends RuntimeEvidenceProfileV1>(
    runtimeEvidence: RuntimeEvidenceV1<Profile>,
  ) => () => Readonly<ExecutedRuntimeManifestForProfileV1<Profile>>;
}

/**
 * Capture workspace runtime evidence from the exact source returned to Node.
 * Native addons are rejected before loading because Node exposes no source
 * snapshot that can be bound to execution by a synchronous load hook.
 */
export function createRuntimeLoadEvidenceV1(input: Readonly<{
  readonly repoRoot: string;
  readonly sourceCommit: string;
}>): RuntimeLoadEvidenceV1 {
  const repoRoot = realpathSync.native(input.repoRoot);
  const resolved = new Map<string, RuntimeFileEvidenceV1>();
  const loaded = new Map<string, RuntimeFileEvidenceV1>();
  let sealed = false;

  const resolveHook: ResolveHookSync = (specifier, context, nextResolve) => {
    const result = nextResolve(specifier, context);
    const artifact = runtimeArtifact(result.url);
    if (artifact === null) return result;
    if (sealed) {
      throw new Error(`workspace runtime artifact resolved after provenance seal: ${artifact.path}`);
    }
    if (artifact.path.endsWith('.node')) {
      throw new Error(
        `workspace native runtime artifact cannot be source-bound by the loader: ${artifact.path}`,
      );
    }
    const entry = fileEntry(artifact.path, readFileSync(artifact.absolutePath));
    const previous = resolved.get(artifact.path);
    if (previous !== undefined && !sameEntry(previous, entry)) {
      throw new Error(
        `workspace runtime artifact changed between module resolutions: ${artifact.path}`,
      );
    }
    resolved.set(artifact.path, entry);
    return result;
  };

  const loadHook: LoadHookSync = (url, context, _nextLoad) => {
    const artifact = runtimeArtifact(url);
    if (artifact === null) return _nextLoad(url, context);
    if (sealed) {
      throw new Error(`workspace runtime artifact loaded after provenance seal: ${artifact.path}`);
    }
    if (artifact.path.endsWith('.node')) {
      throw new Error(
        `workspace native runtime artifact cannot be source-bound by the loader: ${artifact.path}`,
      );
    }
    // Read once, then short-circuit the hook chain with that same snapshot.
    // This prevents downstream transformers and filesystem races from making
    // the evaluated bytes differ from the evidence entry.
    const bytes = readFileSync(artifact.absolutePath);
    const entry = fileEntry(artifact.path, bytes);
    const resolvedEntry = resolved.get(artifact.path);
    if (resolvedEntry !== undefined && !sameEntry(resolvedEntry, entry)) {
      throw new Error(
        `workspace runtime artifact changed between resolution and load: ${artifact.path}`,
      );
    }
    const previous = loaded.get(artifact.path);
    if (previous !== undefined && !sameEntry(previous, entry)) {
      throw new Error(`workspace runtime artifact changed between module loads: ${artifact.path}`);
    }
    loaded.set(artifact.path, entry);
    return {
      format: context.format ?? inferredFormat(artifact.path),
      shortCircuit: true,
      source: bytes,
    };
  };

  return Object.freeze({
    resolve: resolveHook,
    load: loadHook,
    createSealer: <Profile extends RuntimeEvidenceProfileV1>(
      runtimeEvidence: RuntimeEvidenceV1<Profile>,
    ) => () => {
      if (sealed) throw new Error('runtime loader manifest was already sealed');
      sealed = true;
      if (loaded.size < 1) {
        throw new Error('runtime loader hook observed no workspace dist artifacts');
      }
      return runtimeEvidence.buildExecutedRuntimeManifest(
        input.sourceCommit,
        [...loaded.values()],
      );
    },
  });

  function runtimeArtifact(url: string): Readonly<{
    absolutePath: string;
    path: string;
  }> | null {
    if (!url.startsWith('file:')) return null;
    const absolutePath = realpathSync.native(fileURLToPath(url));
    const path = relative(repoRoot, absolutePath).split(sep).join('/');
    return RUNTIME_PATH.test(path) ? Object.freeze({ absolutePath, path }) : null;
  }
}

function inferredFormat(path: string): string {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.wasm')) return 'wasm';
  return 'module';
}

function fileEntry(path: string, bytes: Uint8Array): Readonly<RuntimeFileEvidenceV1> {
  return Object.freeze({
    byteLength: bytes.byteLength,
    path,
    sha256: `0x${createHash('sha256').update(bytes).digest('hex')}`,
  });
}

function sameEntry(left: RuntimeFileEvidenceV1, right: RuntimeFileEvidenceV1): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}
