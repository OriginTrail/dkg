import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { canonicalize, type CanonicalValue } from './rfc64-gate2-multi-asset-completeness/src/canonical.ts';
import { validateFixedRuntimeProcessEvidenceV1 } from './rfc64-runtime-process-evidence.mts';

export const GATE2_RUNTIME_MANIFEST_SCHEMA_VERSION =
  'dkg-rfc64-gate2-runtime-manifest-v1' as const;
export const GATE2_RUNTIME_MANIFEST_DIGEST_DOMAIN =
  'dkg-rfc64-gate2-runtime-manifest-v1\n' as const;
export const GATE2_EXECUTED_RUNTIME_MANIFEST_SCHEMA_VERSION =
  'dkg-rfc64-gate2-executed-runtime-manifest-v1' as const;
export const GATE2_EXECUTED_RUNTIME_MANIFEST_DIGEST_DOMAIN =
  'dkg-rfc64-gate2-executed-runtime-manifest-v1\n' as const;
export const GATE2_RUNTIME_PROVENANCE_SCHEMA_VERSION =
  'dkg-rfc64-gate2-runtime-provenance-v1' as const;
export const GATE2_RUNTIME_PROVENANCE_DIGEST_DOMAIN =
  'dkg-rfc64-gate2-runtime-provenance-v1\n' as const;

export const GATE2_RUNTIME_PACKAGE_CLOSURE = Object.freeze([
  Object.freeze({ name: '@origintrail-official/dkg-agent', path: 'packages/agent/dist' }),
  Object.freeze({ name: '@origintrail-official/dkg-chain', path: 'packages/chain/dist' }),
  Object.freeze({ name: '@origintrail-official/dkg-core', path: 'packages/core/dist' }),
  Object.freeze({ name: '@origintrail-official/dkg-publisher', path: 'packages/publisher/dist' }),
  Object.freeze({ name: '@origintrail-official/dkg-query', path: 'packages/query/dist' }),
  Object.freeze({
    name: '@origintrail-official/dkg-random-sampling',
    path: 'packages/random-sampling/dist',
  }),
  Object.freeze({ name: '@origintrail-official/dkg-rdf-utils', path: 'packages/rdf-utils/dist' }),
  Object.freeze({ name: '@origintrail-official/dkg-storage', path: 'packages/storage/dist' }),
] as const);

export const GATE2_RUNTIME_CLEAN_ARGS = Object.freeze([
  '-r',
  '--filter',
  '@origintrail-official/dkg-agent...',
  '--filter',
  '!@origintrail-official/dkg-evm-module',
  'run',
  'clean',
] as const);

export const GATE2_RUNTIME_BUILD_ARGS = Object.freeze([
  '-r',
  '--filter',
  '@origintrail-official/dkg-agent...',
  '--filter',
  '!@origintrail-official/dkg-evm-module',
  'run',
  'build',
] as const);

const SOURCE_COMMIT = /^[0-9a-f]{40,64}$/u;
const DIGEST = /^0x[0-9a-f]{64}$/u;
const RUNTIME_FILE = /\.(?:js|json|node|wasm)$/u;
const MAX_RUNTIME_FILES = 4_096;
const MAX_RUNTIME_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_CLOSURE_BYTES = 512 * 1024 * 1024;

export interface Gate2RuntimeFileEvidenceV1 {
  readonly byteLength: number;
  readonly path: string;
  readonly sha256: string;
}

export interface Gate2RuntimeManifestV1 {
  readonly build: {
    readonly buildArgs: readonly string[];
    readonly cleanArgs: readonly string[];
    readonly command: 'pnpm';
  };
  readonly manifestDigest: string;
  readonly packageClosure: readonly {
    readonly name: string;
    readonly path: string;
  }[];
  readonly runtimeFiles: readonly Gate2RuntimeFileEvidenceV1[];
  readonly schemaVersion: typeof GATE2_RUNTIME_MANIFEST_SCHEMA_VERSION;
  readonly sourceCommit: string;
}

export interface Gate2RuntimeLaunchReceiptV1 {
  readonly manifest: Readonly<Gate2RuntimeManifestV1>;
  readonly sourceCommit: string;
}

export interface Gate2ExecutedRuntimeManifestV1 {
  readonly manifestDigest: string;
  readonly runtimeFiles: readonly Gate2RuntimeFileEvidenceV1[];
  readonly schemaVersion: typeof GATE2_EXECUTED_RUNTIME_MANIFEST_SCHEMA_VERSION;
  readonly sourceCommit: string;
}

export type Gate2RuntimeProcessIdV1 =
  | 'author'
  | 'receiverBeforeCrash'
  | 'receiverAfterRestart';

export interface Gate2RuntimeProcessEvidenceV1 {
  readonly id: Gate2RuntimeProcessIdV1;
  readonly loaded: Gate2ExecutedRuntimeManifestV1;
}

export interface Gate2RuntimeProvenanceV1 {
  readonly processes: readonly Gate2RuntimeProcessEvidenceV1[];
  readonly provenanceDigest: string;
  readonly schemaVersion: typeof GATE2_RUNTIME_PROVENANCE_SCHEMA_VERSION;
  readonly sourceBuild: Gate2RuntimeManifestV1;
}

export interface RuntimeProcessEvidenceV1<ProcessId extends string> {
  readonly id: ProcessId;
  readonly loaded: Gate2ExecutedRuntimeManifestV1;
}

export interface RuntimeProcessProvenanceV1<
  ProcessId extends string,
  Schema extends string,
> {
  readonly processes: readonly RuntimeProcessEvidenceV1<ProcessId>[];
  readonly schema: Schema;
  readonly sourceBuild: Gate2RuntimeManifestV1;
}

/** Scenario-neutral names for consumers outside the Gate 2 adapter. */
export type RuntimeManifestV1 = Gate2RuntimeManifestV1;
export type ExecutedRuntimeManifestV1 = Gate2ExecutedRuntimeManifestV1;
export const RFC64_RUNTIME_PACKAGE_CLOSURE_V1 = GATE2_RUNTIME_PACKAGE_CLOSURE;

let pendingLaunchReceipt: Readonly<Gate2RuntimeLaunchReceiptV1> | undefined;

/** Remove ignored outputs and rebuild the complete workspace runtime dependency closure. */
export function runGate2CleanRuntimeBuildV1(repoRootInput: string): void {
  const repoRoot = resolve(repoRootInput);
  for (const args of [GATE2_RUNTIME_CLEAN_ARGS, GATE2_RUNTIME_BUILD_ARGS]) {
    execFileSync('pnpm', [...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
  }
}

export const runCleanRuntimeBuildV1 = runGate2CleanRuntimeBuildV1;

/** Hash every executable/data artifact in the freshly built workspace package closure. */
export function buildGate2RuntimeManifestV1(
  repoRootInput: string,
  sourceCommit: string,
): Readonly<Gate2RuntimeManifestV1> {
  const repoRoot = resolve(repoRootInput);
  const entries: Gate2RuntimeFileEvidenceV1[] = [];
  for (const pkg of GATE2_RUNTIME_PACKAGE_CLOSURE) {
    collectRuntimeFiles(repoRoot, resolve(repoRoot, pkg.path), entries);
  }
  return buildGate2RuntimeManifestFromEntriesV1(sourceCommit, entries);
}

export const buildRuntimeManifestV1 = buildGate2RuntimeManifestV1;

/** Deterministic constructor exposed for adversarial manifest tests. */
export function buildGate2RuntimeManifestFromEntriesV1(
  sourceCommit: string,
  inputEntries: readonly Gate2RuntimeFileEvidenceV1[],
): Readonly<Gate2RuntimeManifestV1> {
  if (!SOURCE_COMMIT.test(sourceCommit)) throw new TypeError('runtime source commit is malformed');
  if (inputEntries.length < 1 || inputEntries.length > MAX_RUNTIME_FILES) {
    throw new RangeError('runtime manifest file count is outside the closed bound');
  }
  let totalBytes = 0;
  const paths = new Set<string>();
  const runtimeFiles = inputEntries.map((input) => {
    if (
      typeof input.path !== 'string'
      || input.path.length < 1
      || input.path.length > 4_096
      || input.path.startsWith('/')
      || input.path.split('/').includes('..')
      || !RUNTIME_FILE.test(input.path)
    ) {
      throw new TypeError('runtime manifest path is not a bounded relative runtime artifact');
    }
    if (paths.has(input.path)) throw new TypeError(`duplicate runtime manifest path: ${input.path}`);
    paths.add(input.path);
    if (
      !Number.isSafeInteger(input.byteLength)
      || input.byteLength < 0
      || input.byteLength > MAX_RUNTIME_FILE_BYTES
    ) {
      throw new RangeError(`runtime artifact byte length is invalid: ${input.path}`);
    }
    if (!DIGEST.test(input.sha256)) {
      throw new TypeError(`runtime artifact digest is invalid: ${input.path}`);
    }
    totalBytes += input.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RUNTIME_CLOSURE_BYTES) {
      throw new RangeError('runtime artifact closure exceeds the byte bound');
    }
    return Object.freeze({
      byteLength: input.byteLength,
      path: input.path,
      sha256: input.sha256,
    });
  }).sort((left, right) => compareText(left.path, right.path));
  const packageClosure = Object.freeze(GATE2_RUNTIME_PACKAGE_CLOSURE.map((pkg) =>
    Object.freeze({ name: pkg.name, path: pkg.path })));
  const build = Object.freeze({
    buildArgs: GATE2_RUNTIME_BUILD_ARGS,
    cleanArgs: GATE2_RUNTIME_CLEAN_ARGS,
    command: 'pnpm' as const,
  });
  const payload = Object.freeze({
    build,
    packageClosure,
    runtimeFiles: Object.freeze(runtimeFiles),
    schemaVersion: GATE2_RUNTIME_MANIFEST_SCHEMA_VERSION,
    sourceCommit,
  });
  const manifestDigest = sha256(
    GATE2_RUNTIME_MANIFEST_DIGEST_DOMAIN,
    canonicalize(payload as unknown as CanonicalValue),
  );
  return Object.freeze({ ...payload, manifestDigest });
}

export function assertGate2RuntimeManifestEqualV1(
  actual: Gate2RuntimeManifestV1,
  expected: Gate2RuntimeManifestV1,
): void {
  if (
    canonicalize(actual as unknown as CanonicalValue)
    !== canonicalize(expected as unknown as CanonicalValue)
  ) {
    throw new Error('Gate 2 runtime manifest differs from the clean source build');
  }
}

export const assertRuntimeManifestEqualV1 = assertGate2RuntimeManifestEqualV1;

/** Deterministic manifest of the exact workspace dist files observed by a child loader hook. */
export function buildGate2ExecutedRuntimeManifestV1(
  sourceCommit: string,
  inputEntries: readonly Gate2RuntimeFileEvidenceV1[],
): Readonly<Gate2ExecutedRuntimeManifestV1> {
  const validated = buildGate2RuntimeManifestFromEntriesV1(sourceCommit, inputEntries);
  const payload = Object.freeze({
    runtimeFiles: validated.runtimeFiles,
    schemaVersion: GATE2_EXECUTED_RUNTIME_MANIFEST_SCHEMA_VERSION,
    sourceCommit,
  });
  return Object.freeze({
    ...payload,
    manifestDigest: sha256(
      GATE2_EXECUTED_RUNTIME_MANIFEST_DIGEST_DOMAIN,
      canonicalize(payload as unknown as CanonicalValue),
    ),
  });
}

/** Fail closed unless every child-observed byte is present in the clean-build snapshot. */
export function assertGate2ExecutedRuntimeMatchesBuildV1(
  executed: Gate2ExecutedRuntimeManifestV1,
  cleanBuild: Gate2RuntimeManifestV1,
): void {
  const rebuilt = buildGate2ExecutedRuntimeManifestV1(
    executed.sourceCommit,
    executed.runtimeFiles,
  );
  if (canonicalize(rebuilt as unknown as CanonicalValue)
    !== canonicalize(executed as unknown as CanonicalValue)) {
    throw new Error('Gate 2 executed runtime manifest is not internally canonical');
  }
  if (executed.sourceCommit !== cleanBuild.sourceCommit) {
    throw new Error('Gate 2 executed runtime manifest names a different source commit');
  }
  const expectedByPath = new Map(cleanBuild.runtimeFiles.map((entry) => [entry.path, entry]));
  const allowedPrefixes = GATE2_RUNTIME_PACKAGE_CLOSURE.map((entry) => `${entry.path}/`);
  for (const entry of executed.runtimeFiles) {
    if (!allowedPrefixes.some((prefix) => entry.path.startsWith(prefix))) {
      throw new Error(`Gate 2 child loaded an undeclared workspace package: ${entry.path}`);
    }
    const expected = expectedByPath.get(entry.path);
    if (
      expected === undefined
      || expected.byteLength !== entry.byteLength
      || expected.sha256 !== entry.sha256
    ) {
      throw new Error(`Gate 2 child loaded bytes outside the clean-build snapshot: ${entry.path}`);
    }
  }
  for (const mandatory of [
    'packages/agent/dist/index.js',
    'packages/chain/dist/index.js',
    'packages/core/dist/index.js',
    'packages/storage/dist/index.js',
  ]) {
    if (!executed.runtimeFiles.some((entry) => entry.path === mandatory)) {
      throw new Error(`Gate 2 child did not load mandatory runtime entrypoint: ${mandatory}`);
    }
  }
}

/**
 * Build provenance for an arbitrary fixed process topology using the same
 * canonical clean-build and executed-runtime contracts as Gate 2.
 */
export function buildRuntimeProcessProvenanceV1<
  ProcessId extends string,
  Schema extends string,
>(input: {
  readonly expectedProcessIds: readonly ProcessId[];
  readonly processes: readonly RuntimeProcessEvidenceV1<ProcessId>[];
  readonly schema: Schema;
  readonly sourceBuild: Gate2RuntimeManifestV1;
}): Readonly<RuntimeProcessProvenanceV1<ProcessId, Schema>> {
  const canonicalSourceBuild = buildGate2RuntimeManifestFromEntriesV1(
    input.sourceBuild.sourceCommit,
    input.sourceBuild.runtimeFiles,
  );
  assertGate2RuntimeManifestEqualV1(input.sourceBuild, canonicalSourceBuild);
  const processes = validateFixedRuntimeProcessEvidenceV1({
    expectedProcessIds: input.expectedProcessIds,
    processes: input.processes,
    validateLoaded: (loaded) => {
      assertGate2ExecutedRuntimeMatchesBuildV1(loaded, canonicalSourceBuild);
    },
  });
  return Object.freeze({
    schema: input.schema,
    sourceBuild: canonicalSourceBuild,
    processes,
  });
}

/** Rebuild and byte-compare a persisted process-provenance object. */
export function assertRuntimeProcessProvenanceV1<
  ProcessId extends string,
  Schema extends string,
>(
  actual: RuntimeProcessProvenanceV1<ProcessId, Schema>,
  expected: {
    readonly processIds: readonly ProcessId[];
    readonly schema: Schema;
  },
): Readonly<RuntimeProcessProvenanceV1<ProcessId, Schema>> {
  const rebuilt = buildRuntimeProcessProvenanceV1({
    expectedProcessIds: expected.processIds,
    processes: actual.processes,
    schema: expected.schema,
    sourceBuild: actual.sourceBuild,
  });
  if (
    canonicalize(actual as unknown as CanonicalValue)
    !== canonicalize(rebuilt as unknown as CanonicalValue)
  ) {
    throw new Error('runtime process provenance is not internally canonical');
  }
  return rebuilt;
}

/** Validate parsed/persisted JSON before admitting it to the typed provenance model. */
export function assertPersistedRuntimeProcessProvenanceV1<
  ProcessId extends string,
  Schema extends string,
>(
  actual: unknown,
  expected: {
    readonly processIds: readonly ProcessId[];
    readonly schema: Schema;
  },
): Readonly<RuntimeProcessProvenanceV1<ProcessId, Schema>> {
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    throw new TypeError('persisted runtime process provenance must be an object');
  }
  const candidate = actual as Partial<RuntimeProcessProvenanceV1<ProcessId, Schema>>;
  if (
    candidate.schema !== expected.schema
    || !Array.isArray(candidate.processes)
    || typeof candidate.sourceBuild !== 'object'
    || candidate.sourceBuild === null
    || Array.isArray(candidate.sourceBuild)
  ) {
    throw new TypeError('persisted runtime process provenance has an invalid envelope');
  }
  return assertRuntimeProcessProvenanceV1(
    candidate as RuntimeProcessProvenanceV1<ProcessId, Schema>,
    expected,
  );
}

export function buildGate2RuntimeProvenanceV1(
  sourceBuild: Gate2RuntimeManifestV1,
  inputProcesses: readonly Gate2RuntimeProcessEvidenceV1[],
): Readonly<Gate2RuntimeProvenanceV1> {
  const expectedIds: readonly Gate2RuntimeProcessIdV1[] = Object.freeze([
    'author',
    'receiverBeforeCrash',
    'receiverAfterRestart',
  ]);
  const processes = validateFixedRuntimeProcessEvidenceV1({
    expectedProcessIds: expectedIds,
    processes: inputProcesses,
    validateLoaded: (loaded) => {
      assertGate2ExecutedRuntimeMatchesBuildV1(loaded, sourceBuild);
    },
  });
  const payload = Object.freeze({
    processes,
    schemaVersion: GATE2_RUNTIME_PROVENANCE_SCHEMA_VERSION,
    sourceBuild,
  });
  return Object.freeze({
    ...payload,
    provenanceDigest: sha256(
      GATE2_RUNTIME_PROVENANCE_DIGEST_DOMAIN,
      canonicalize(payload as unknown as CanonicalValue),
    ),
  });
}

export function installGate2RuntimeLaunchReceiptV1(
  receipt: Gate2RuntimeLaunchReceiptV1,
): void {
  if (pendingLaunchReceipt !== undefined) {
    throw new Error('Gate 2 runtime launch receipt is already installed');
  }
  if (receipt.manifest.sourceCommit !== receipt.sourceCommit) {
    throw new Error('Gate 2 runtime launch receipt does not bind its source commit');
  }
  pendingLaunchReceipt = Object.freeze({
    manifest: receipt.manifest,
    sourceCommit: receipt.sourceCommit,
  });
}

export function consumeGate2RuntimeLaunchReceiptV1(): Readonly<Gate2RuntimeLaunchReceiptV1> {
  const receipt = pendingLaunchReceipt;
  pendingLaunchReceipt = undefined;
  if (receipt === undefined) {
    throw new Error(
      'Gate 2 live harness requires its clean-build launcher; direct run.ts execution is forbidden',
    );
  }
  return receipt;
}

function collectRuntimeFiles(
  repoRoot: string,
  directory: string,
  entries: Gate2RuntimeFileEvidenceV1[],
): void {
  const children = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name));
  for (const child of children) {
    const absolutePath = resolve(directory, child.name);
    if (child.isSymbolicLink()) {
      throw new Error(`runtime artifact closure contains a symbolic link: ${absolutePath}`);
    }
    if (child.isDirectory()) {
      collectRuntimeFiles(repoRoot, absolutePath, entries);
      continue;
    }
    if (!child.isFile() || !RUNTIME_FILE.test(child.name)) continue;
    if (entries.length >= MAX_RUNTIME_FILES) {
      throw new RangeError('runtime artifact closure exceeds the file-count bound');
    }
    const bytes = readFileSync(absolutePath);
    if (bytes.byteLength > MAX_RUNTIME_FILE_BYTES) {
      throw new RangeError(`runtime artifact exceeds the per-file byte bound: ${absolutePath}`);
    }
    const path = relative(repoRoot, absolutePath).split(sep).join('/');
    if (path.startsWith('../') || path === '..') {
      throw new Error(`runtime artifact escaped the repository root: ${absolutePath}`);
    }
    entries.push(Object.freeze({
      byteLength: bytes.byteLength,
      path,
      sha256: `0x${createHash('sha256').update(bytes).digest('hex')}`,
    }));
  }
}

function sha256(domain: string, payload: string): string {
  return `0x${createHash('sha256').update(domain).update(payload).digest('hex')}`;
}

function compareText(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}
