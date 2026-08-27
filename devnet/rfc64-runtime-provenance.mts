// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { canonicalize, type CanonicalValue } from './rfc64-runtime-canonical.mts';
import { validateFixedRuntimeProcessEvidenceV1 } from './rfc64-runtime-process-evidence.mts';

export const RUNTIME_MANIFEST_SCHEMA_VERSION =
  'dkg-rfc64-runtime-manifest-v1' as const;
export const RUNTIME_MANIFEST_DIGEST_DOMAIN =
  'dkg-rfc64-runtime-manifest-v1\n' as const;
export const EXECUTED_RUNTIME_MANIFEST_SCHEMA_VERSION =
  'dkg-rfc64-executed-runtime-manifest-v1' as const;
export const EXECUTED_RUNTIME_MANIFEST_DIGEST_DOMAIN =
  'dkg-rfc64-executed-runtime-manifest-v1\n' as const;

export const RUNTIME_PACKAGE_CLOSURE = Object.freeze([
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

export const RUNTIME_CLEAN_ARGS = Object.freeze([
  '-r',
  '--filter',
  '@origintrail-official/dkg-agent...',
  '--filter',
  '!@origintrail-official/dkg-evm-module',
  'run',
  'clean',
] as const);

export const RUNTIME_BUILD_ARGS = Object.freeze([
  '-r',
  '--filter',
  '@origintrail-official/dkg-agent...',
  '--filter',
  '!@origintrail-official/dkg-evm-module',
  'run',
  'build',
] as const);

export interface RuntimeEvidenceProfileV1<
  ManifestSchema extends string = string,
  ExecutedManifestSchema extends string = string,
> {
  readonly buildArgs: readonly string[];
  readonly cleanArgs: readonly string[];
  readonly executedManifestDigestDomain: string;
  readonly executedManifestSchemaVersion: ExecutedManifestSchema;
  readonly mandatoryEntrypoints: readonly string[];
  readonly manifestDigestDomain: string;
  readonly manifestSchemaVersion: ManifestSchema;
  readonly packageClosure: readonly {
    readonly name: string;
    readonly path: string;
  }[];
}

export const RFC64_RUNTIME_EVIDENCE_PROFILE_V1 = Object.freeze({
    buildArgs: RUNTIME_BUILD_ARGS,
    cleanArgs: RUNTIME_CLEAN_ARGS,
    executedManifestDigestDomain: EXECUTED_RUNTIME_MANIFEST_DIGEST_DOMAIN,
    executedManifestSchemaVersion: EXECUTED_RUNTIME_MANIFEST_SCHEMA_VERSION,
    mandatoryEntrypoints: Object.freeze([
      'packages/agent/dist/index.js',
      'packages/chain/dist/index.js',
      'packages/core/dist/index.js',
      'packages/storage/dist/index.js',
    ]),
    manifestDigestDomain: RUNTIME_MANIFEST_DIGEST_DOMAIN,
    manifestSchemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    packageClosure: RUNTIME_PACKAGE_CLOSURE,
  } as const satisfies RuntimeEvidenceProfileV1);

const SOURCE_COMMIT = /^[0-9a-f]{40,64}$/u;
const DIGEST = /^0x[0-9a-f]{64}$/u;
const RUNTIME_FILE = /\.(?:js|json|node|wasm)$/u;
const MAX_RUNTIME_FILES = 4_096;
const MAX_RUNTIME_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_CLOSURE_BYTES = 512 * 1024 * 1024;

export interface RuntimeFileEvidenceV1 {
  readonly byteLength: number;
  readonly path: string;
  readonly sha256: string;
}

export interface RuntimeManifestV1<SchemaVersion extends string = string> {
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
  readonly runtimeFiles: readonly RuntimeFileEvidenceV1[];
  readonly schemaVersion: SchemaVersion;
  readonly sourceCommit: string;
}

export interface ExecutedRuntimeManifestV1<SchemaVersion extends string = string> {
  readonly manifestDigest: string;
  readonly runtimeFiles: readonly RuntimeFileEvidenceV1[];
  readonly schemaVersion: SchemaVersion;
  readonly sourceCommit: string;
}

export interface RuntimeProcessEvidenceV1<ProcessId extends string> {
  readonly id: ProcessId;
  readonly loaded: ExecutedRuntimeManifestV1;
}

export type RuntimeManifestForProfileV1<Profile extends RuntimeEvidenceProfileV1> =
  RuntimeManifestV1<Profile['manifestSchemaVersion']>;

export type ExecutedRuntimeManifestForProfileV1<Profile extends RuntimeEvidenceProfileV1> =
  ExecutedRuntimeManifestV1<Profile['executedManifestSchemaVersion']>;

export interface RuntimeEvidenceV1<Profile extends RuntimeEvidenceProfileV1> {
  readonly profile: Readonly<Profile>;
  readonly runCleanRuntimeBuild: (repoRoot: string) => void;
  readonly buildRuntimeManifest: (
    repoRoot: string,
    sourceCommit: string,
  ) => Readonly<RuntimeManifestForProfileV1<Profile>>;
  readonly buildRuntimeManifestFromEntries: (
    sourceCommit: string,
    entries: readonly RuntimeFileEvidenceV1[],
  ) => Readonly<RuntimeManifestForProfileV1<Profile>>;
  readonly buildExecutedRuntimeManifest: (
    sourceCommit: string,
    entries: readonly RuntimeFileEvidenceV1[],
  ) => Readonly<ExecutedRuntimeManifestForProfileV1<Profile>>;
  readonly assertExecutedRuntimeMatchesBuild: (
    executed: ExecutedRuntimeManifestForProfileV1<Profile>,
    cleanBuild: RuntimeManifestForProfileV1<Profile>,
  ) => void;
}

/** Bind every manifest operation to one schema/domain profile. */
export function createRuntimeEvidenceV1<const Profile extends RuntimeEvidenceProfileV1>(
  profile: Readonly<Profile>,
): Readonly<RuntimeEvidenceV1<Profile>> {
  return Object.freeze({
    profile,
    runCleanRuntimeBuild: (repoRoot: string) => {
      runCleanRuntimeBuildForProfileV1(repoRoot, profile);
    },
    buildRuntimeManifest: (repoRoot: string, sourceCommit: string) =>
      buildRuntimeManifestForProfileV1(repoRoot, sourceCommit, profile),
    buildRuntimeManifestFromEntries: (
      sourceCommit: string,
      entries: readonly RuntimeFileEvidenceV1[],
    ) => buildRuntimeManifestFromEntriesForProfileV1(sourceCommit, entries, profile),
    buildExecutedRuntimeManifest: (
      sourceCommit: string,
      entries: readonly RuntimeFileEvidenceV1[],
    ) => buildExecutedRuntimeManifestForProfileV1(sourceCommit, entries, profile),
    assertExecutedRuntimeMatchesBuild: (
      executed: ExecutedRuntimeManifestForProfileV1<Profile>,
      cleanBuild: RuntimeManifestForProfileV1<Profile>,
    ) => assertExecutedRuntimeMatchesBuildForProfileV1(executed, cleanBuild, profile),
  });
}

export const RFC64_RUNTIME_EVIDENCE_V1 = createRuntimeEvidenceV1(
  RFC64_RUNTIME_EVIDENCE_PROFILE_V1,
);

export interface RuntimeProcessProvenanceV1<
  ProcessId extends string,
  Schema extends string,
> {
  readonly processes: readonly RuntimeProcessEvidenceV1<ProcessId>[];
  readonly schema: Schema;
  readonly sourceBuild: RuntimeManifestV1;
}

export const RFC64_RUNTIME_PACKAGE_CLOSURE_V1 = RUNTIME_PACKAGE_CLOSURE;

/** Remove ignored outputs and rebuild the complete workspace runtime dependency closure. */
export function runCleanRuntimeBuildV1(
  repoRootInput: string,
): void {
  RFC64_RUNTIME_EVIDENCE_V1.runCleanRuntimeBuild(repoRootInput);
}

function runCleanRuntimeBuildForProfileV1(
  repoRootInput: string,
  profile: RuntimeEvidenceProfileV1,
): void {
  const repoRoot = resolve(repoRootInput);
  for (const args of [profile.cleanArgs, profile.buildArgs]) {
    execFileSync('pnpm', [...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
  }
}

/** Hash every executable/data artifact in the freshly built workspace package closure. */
export function buildRuntimeManifestV1(
  repoRootInput: string,
  sourceCommit: string,
): Readonly<RuntimeManifestForProfileV1<typeof RFC64_RUNTIME_EVIDENCE_PROFILE_V1>> {
  return RFC64_RUNTIME_EVIDENCE_V1.buildRuntimeManifest(repoRootInput, sourceCommit);
}

function buildRuntimeManifestForProfileV1<Profile extends RuntimeEvidenceProfileV1>(
  repoRootInput: string,
  sourceCommit: string,
  profile: Readonly<Profile>,
): Readonly<RuntimeManifestForProfileV1<Profile>> {
  const repoRoot = realpathSync.native(resolve(repoRootInput));
  const entries: RuntimeFileEvidenceV1[] = [];
  for (const pkg of profile.packageClosure) {
    const closureRoot = resolve(repoRoot, pkg.path);
    if (lstatSync(closureRoot).isSymbolicLink()) {
      throw new Error(`runtime artifact closure root is a symbolic link: ${pkg.path}`);
    }
    if (realpathSync.native(closureRoot) !== closureRoot) {
      throw new Error(`runtime artifact closure root resolves through a symbolic link: ${pkg.path}`);
    }
    collectRuntimeFiles(repoRoot, closureRoot, entries);
  }
  return buildRuntimeManifestFromEntriesForProfileV1(sourceCommit, entries, profile);
}

/** Deterministic constructor exposed for adversarial manifest tests. */
export function buildRuntimeManifestFromEntriesV1(
  sourceCommit: string,
  inputEntries: readonly RuntimeFileEvidenceV1[],
): Readonly<RuntimeManifestForProfileV1<typeof RFC64_RUNTIME_EVIDENCE_PROFILE_V1>> {
  return RFC64_RUNTIME_EVIDENCE_V1.buildRuntimeManifestFromEntries(
    sourceCommit,
    inputEntries,
  );
}

function buildRuntimeManifestFromEntriesForProfileV1<Profile extends RuntimeEvidenceProfileV1>(
  sourceCommit: string,
  inputEntries: readonly RuntimeFileEvidenceV1[],
  profile: Readonly<Profile>,
): Readonly<RuntimeManifestForProfileV1<Profile>> {
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
  const packageClosure = Object.freeze(profile.packageClosure.map((pkg) =>
    Object.freeze({ name: pkg.name, path: pkg.path })));
  const build = Object.freeze({
    buildArgs: Object.freeze([...profile.buildArgs]),
    cleanArgs: Object.freeze([...profile.cleanArgs]),
    command: 'pnpm' as const,
  });
  const payload = Object.freeze({
    build,
    packageClosure,
    runtimeFiles: Object.freeze(runtimeFiles),
    schemaVersion: profile.manifestSchemaVersion,
    sourceCommit,
  });
  const manifestDigest = sha256(
    profile.manifestDigestDomain,
    canonicalize(payload as unknown as CanonicalValue),
  );
  return Object.freeze({ ...payload, manifestDigest });
}

export function assertRuntimeManifestEqualV1(
  actual: RuntimeManifestV1,
  expected: RuntimeManifestV1,
): void {
  if (
    canonicalize(actual as unknown as CanonicalValue)
    !== canonicalize(expected as unknown as CanonicalValue)
  ) {
    throw new Error('runtime manifest differs from the clean source build');
  }
}

/** Deterministic manifest of the exact workspace dist files observed by a child loader hook. */
export function buildExecutedRuntimeManifestV1(
  sourceCommit: string,
  inputEntries: readonly RuntimeFileEvidenceV1[],
): Readonly<ExecutedRuntimeManifestForProfileV1<typeof RFC64_RUNTIME_EVIDENCE_PROFILE_V1>> {
  return RFC64_RUNTIME_EVIDENCE_V1.buildExecutedRuntimeManifest(sourceCommit, inputEntries);
}

function buildExecutedRuntimeManifestForProfileV1<Profile extends RuntimeEvidenceProfileV1>(
  sourceCommit: string,
  inputEntries: readonly RuntimeFileEvidenceV1[],
  profile: Readonly<Profile>,
): Readonly<ExecutedRuntimeManifestForProfileV1<Profile>> {
  const validated = buildRuntimeManifestFromEntriesForProfileV1(
    sourceCommit,
    inputEntries,
    profile,
  );
  const payload = Object.freeze({
    runtimeFiles: validated.runtimeFiles,
    schemaVersion: profile.executedManifestSchemaVersion,
    sourceCommit,
  });
  return Object.freeze({
    ...payload,
    manifestDigest: sha256(
      profile.executedManifestDigestDomain,
      canonicalize(payload as unknown as CanonicalValue),
    ),
  });
}

/** Fail closed unless every child-observed byte is present in the clean-build snapshot. */
export function assertExecutedRuntimeMatchesBuildV1(
  executed: ExecutedRuntimeManifestForProfileV1<typeof RFC64_RUNTIME_EVIDENCE_PROFILE_V1>,
  cleanBuild: RuntimeManifestForProfileV1<typeof RFC64_RUNTIME_EVIDENCE_PROFILE_V1>,
): void {
  assertExecutedRuntimeMatchesBuildForProfileV1(
    executed,
    cleanBuild,
    RFC64_RUNTIME_EVIDENCE_PROFILE_V1,
  );
}

function assertExecutedRuntimeMatchesBuildForProfileV1<
  Profile extends RuntimeEvidenceProfileV1,
>(
  executed: ExecutedRuntimeManifestForProfileV1<Profile>,
  cleanBuild: RuntimeManifestForProfileV1<Profile>,
  profile: Readonly<Profile>,
): void {
  const rebuilt = buildExecutedRuntimeManifestForProfileV1(
    executed.sourceCommit,
    executed.runtimeFiles,
    profile,
  );
  if (canonicalize(rebuilt as unknown as CanonicalValue)
    !== canonicalize(executed as unknown as CanonicalValue)) {
    throw new Error('executed runtime manifest is not internally canonical');
  }
  if (executed.sourceCommit !== cleanBuild.sourceCommit) {
    throw new Error('executed runtime manifest names a different source commit');
  }
  const expectedByPath = new Map(cleanBuild.runtimeFiles.map((entry) => [entry.path, entry]));
  const allowedPrefixes = profile.packageClosure.map((entry) => `${entry.path}/`);
  for (const entry of executed.runtimeFiles) {
    if (!allowedPrefixes.some((prefix) => entry.path.startsWith(prefix))) {
      throw new Error(`runtime child loaded an undeclared workspace package: ${entry.path}`);
    }
    const expected = expectedByPath.get(entry.path);
    if (
      expected === undefined
      || expected.byteLength !== entry.byteLength
      || expected.sha256 !== entry.sha256
    ) {
      throw new Error(`runtime child loaded bytes outside the clean-build snapshot: ${entry.path}`);
    }
  }
  for (const mandatory of profile.mandatoryEntrypoints) {
    if (!executed.runtimeFiles.some((entry) => entry.path === mandatory)) {
      throw new Error(`runtime child did not load mandatory runtime entrypoint: ${mandatory}`);
    }
  }
}

/**
 * Build provenance for an arbitrary fixed process topology using the same
 * canonical clean-build and executed-runtime contracts.
 */
export function buildRuntimeProcessProvenanceV1<
  ProcessId extends string,
  Schema extends string,
>(input: {
  readonly expectedProcessIds: readonly ProcessId[];
  readonly processes: readonly RuntimeProcessEvidenceV1<ProcessId>[];
  readonly profile?: RuntimeEvidenceProfileV1;
  readonly schema: Schema;
  readonly sourceBuild: RuntimeManifestV1;
}): Readonly<RuntimeProcessProvenanceV1<ProcessId, Schema>> {
  const profile = input.profile ?? RFC64_RUNTIME_EVIDENCE_PROFILE_V1;
  const canonicalSourceBuild = buildRuntimeManifestFromEntriesForProfileV1(
    input.sourceBuild.sourceCommit,
    input.sourceBuild.runtimeFiles,
    profile,
  );
  assertRuntimeManifestEqualV1(input.sourceBuild, canonicalSourceBuild);
  const processes = validateFixedRuntimeProcessEvidenceV1({
    expectedProcessIds: input.expectedProcessIds,
    processes: input.processes,
    validateLoaded: (loaded) => {
      assertExecutedRuntimeMatchesBuildForProfileV1(loaded, canonicalSourceBuild, profile);
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
    readonly profile?: RuntimeEvidenceProfileV1;
    readonly schema: Schema;
  },
): Readonly<RuntimeProcessProvenanceV1<ProcessId, Schema>> {
  const rebuilt = buildRuntimeProcessProvenanceV1({
    expectedProcessIds: expected.processIds,
    processes: actual.processes,
    profile: expected.profile,
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
    readonly profile?: RuntimeEvidenceProfileV1;
    readonly schema: Schema;
  },
): Readonly<RuntimeProcessProvenanceV1<ProcessId, Schema>> {
  const record = parsePlainRecord(actual, 'persisted runtime process provenance');
  const schema = parseStringField(record, 'schema', 'persisted runtime process provenance');
  if (schema !== expected.schema) {
    throw new TypeError('persisted runtime process provenance has an invalid schema');
  }
  const processValues = parseArrayField(
    record,
    'processes',
    'persisted runtime process provenance',
  );
  const processes = processValues.map((value, index) => {
    const processRecord = parsePlainRecord(value, `runtime process ${index}`);
    const id = parseStringField(processRecord, 'id', `runtime process ${index}`);
    const expectedId = expected.processIds[index];
    if (expectedId === undefined || id !== expectedId) {
      throw new TypeError(`runtime process ${index} has an invalid id`);
    }
    return Object.freeze({
      id: expectedId,
      loaded: parseExecutedRuntimeManifestV1(
        readDataField(processRecord, 'loaded', `runtime process ${index}`),
        `runtime process ${index} loaded manifest`,
      ),
    });
  });
  const parsed = Object.freeze({
    processes: Object.freeze(processes),
    schema: expected.schema,
    sourceBuild: parseRuntimeManifestV1(
      readDataField(record, 'sourceBuild', 'persisted runtime process provenance'),
      'runtime source manifest',
    ),
  });
  const rebuilt = assertRuntimeProcessProvenanceV1(parsed, expected);
  if (
    canonicalize(actual as CanonicalValue)
    !== canonicalize(rebuilt as unknown as CanonicalValue)
  ) {
    throw new TypeError('persisted runtime process provenance is not canonical');
  }
  return rebuilt;
}

export function parseRuntimeManifestV1(
  value: unknown,
  label = 'runtime manifest',
): Readonly<RuntimeManifestV1> {
  const record = parsePlainRecord(value, label);
  const buildRecord = parsePlainRecord(readDataField(record, 'build', label), `${label} build`);
  return Object.freeze({
    build: Object.freeze({
      buildArgs: Object.freeze(parseStringArrayField(buildRecord, 'buildArgs', `${label} build`)),
      cleanArgs: Object.freeze(parseStringArrayField(buildRecord, 'cleanArgs', `${label} build`)),
      command: parseLiteralField(buildRecord, 'command', 'pnpm', `${label} build`),
    }),
    manifestDigest: parseStringField(record, 'manifestDigest', label),
    packageClosure: Object.freeze(parseArrayField(record, 'packageClosure', label).map(
      (entry, index) => {
        const packageRecord = parsePlainRecord(entry, `${label} package ${index}`);
        return Object.freeze({
          name: parseStringField(packageRecord, 'name', `${label} package ${index}`),
          path: parseStringField(packageRecord, 'path', `${label} package ${index}`),
        });
      },
    )),
    runtimeFiles: Object.freeze(parseArrayField(record, 'runtimeFiles', label).map(
      (entry, index) => parseRuntimeFileEvidenceV1(entry, `${label} file ${index}`),
    )),
    schemaVersion: parseStringField(record, 'schemaVersion', label),
    sourceCommit: parseStringField(record, 'sourceCommit', label),
  });
}

export function parseExecutedRuntimeManifestV1(
  value: unknown,
  label = 'executed runtime manifest',
): Readonly<ExecutedRuntimeManifestV1> {
  const record = parsePlainRecord(value, label);
  return Object.freeze({
    manifestDigest: parseStringField(record, 'manifestDigest', label),
    runtimeFiles: Object.freeze(parseArrayField(record, 'runtimeFiles', label).map(
      (entry, index) => parseRuntimeFileEvidenceV1(entry, `${label} file ${index}`),
    )),
    schemaVersion: parseStringField(record, 'schemaVersion', label),
    sourceCommit: parseStringField(record, 'sourceCommit', label),
  });
}

function parseRuntimeFileEvidenceV1(
  value: unknown,
  label: string,
): Readonly<RuntimeFileEvidenceV1> {
  const record = parsePlainRecord(value, label);
  return Object.freeze({
    byteLength: parseSafeIntegerField(record, 'byteLength', label),
    path: parseStringField(record, 'path', label),
    sha256: parseStringField(record, 'sha256', label),
  });
}

function parsePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function readDataField(record: Record<string, unknown>, field: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (
    descriptor === undefined
    || !descriptor.enumerable
    || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    throw new TypeError(`${label} is missing data field ${field}`);
  }
  return descriptor.value;
}

function parseStringField(record: Record<string, unknown>, field: string, label: string): string {
  const value = readDataField(record, field, label);
  if (typeof value !== 'string') throw new TypeError(`${label}.${field} must be a string`);
  return value;
}

function parseSafeIntegerField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): number {
  const value = readDataField(record, field, label);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label}.${field} must be a safe integer`);
  return value as number;
}

function parseArrayField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): unknown[] {
  const value = readDataField(record, field, label);
  if (!Array.isArray(value)) throw new TypeError(`${label}.${field} must be an array`);
  return value;
}

function parseStringArrayField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string[] {
  return parseArrayField(record, field, label).map((value, index) => {
    if (typeof value !== 'string') {
      throw new TypeError(`${label}.${field}[${index}] must be a string`);
    }
    return value;
  });
}

function parseLiteralField<Literal extends string>(
  record: Record<string, unknown>,
  field: string,
  literal: Literal,
  label: string,
): Literal {
  if (readDataField(record, field, label) !== literal) {
    throw new TypeError(`${label}.${field} must be ${literal}`);
  }
  return literal;
}

function collectRuntimeFiles(
  repoRoot: string,
  directory: string,
  entries: RuntimeFileEvidenceV1[],
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
