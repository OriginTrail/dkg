import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  RFC64_SECURE_DIRECTORY_MODE_V1,
  RFC64_SECURE_FILE_MODE_V1,
  applyRfc64OwnerOnlyPermissionsV1,
  assertRfc64FilesystemOwnerV1,
  assertRfc64OwnerOnlyPermissionsV1,
  fsyncRfc64DirectoryV1,
  rfc64RegularFileFsyncOpenFlagsV1,
  rfc64RegularFileReadOpenFlagsV1,
  type Rfc64FilesystemEntryKindV1,
} from './secure-filesystem-policy-v1.js';

type Rfc64ExistingAccessV1 = 'owner' | 'owner-only';

interface Rfc64ExistingDirectoryPolicyV1 {
  readonly access: Rfc64ExistingAccessV1;
}

interface Rfc64SecureAccessPolicyV1 extends Rfc64ExistingDirectoryPolicyV1 {
  readonly entryKind: Rfc64FilesystemEntryKindV1;
}

export type Rfc64DurableFileErrorCodeV1 =
  | 'input'
  | 'unsafe-path'
  | 'corrupt'
  | 'io'
  | 'durability';

export class Rfc64DurableFileErrorV1 extends Error {
  constructor(
    readonly code: Rfc64DurableFileErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'Rfc64DurableFileErrorV1';
  }
}

type Rfc64DurableFilePublishBoundaryV1 =
  | 'temp-written'
  | 'temp-mode-secured'
  | 'temp-fsynced'
  | 'published-no-replace'
  | 'temp-unlinked'
  | 'parent-fsynced'
  | 'existing-fsynced'
  | 'existing-parent-fsynced';

export type Rfc64DurableFileBoundaryV1<TKind extends string = string> =
  | 'directory.created'
  | 'directory.mode-secured'
  | 'directory.self-fsynced'
  | 'directory.parent-fsynced'
  | `${TKind}.${Rfc64DurableFilePublishBoundaryV1}`;

export interface Rfc64DurableFileLifecycleV1<TKind extends string = string> {
  readonly boundary: (
    boundary: Rfc64DurableFileBoundaryV1<TKind>,
  ) => void | Promise<void>;
}

export interface Rfc64DurableFileStoreV1<TKind extends string> {
  putExactBytes(input: PutRfc64ExactBytesInputV1<TKind>): Promise<void>;
  readOptionalBoundedBytes(
    input: ReadRfc64OptionalBoundedBytesInputV1,
  ): Promise<Uint8Array | null>;
}

export function createRfc64DurableFileStoreV1<TKind extends string>(
  containmentRoot: string,
  lifecycle: Rfc64DurableFileLifecycleV1<TKind>,
): Rfc64DurableFileStoreV1<TKind> {
  return Object.freeze({
    putExactBytes: (input: PutRfc64ExactBytesInputV1<TKind>) =>
      putRfc64ExactBytesV1({ ...input, containmentRoot, lifecycle }),
    readOptionalBoundedBytes: (input: ReadRfc64OptionalBoundedBytesInputV1) =>
      readRfc64OptionalBoundedBytesV1({ ...input, containmentRoot }),
  });
}

export async function assertRfc64ExistingDirectoryV1(
  path: string,
  label: string,
  policy: Rfc64ExistingDirectoryPolicyV1,
): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      fail('unsafe-path', `${label} must be a non-symlink directory`);
    }
    await assertSecureAccess(
      path,
      RFC64_SECURE_DIRECTORY_MODE_V1,
      { entryKind: 'directory', access: policy.access },
      label,
    );
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('io', `failed to inspect ${label}`, cause);
  }
}

export async function ensureRfc64SecureDirectoryTreeV1<TKind extends string>(
  target: string,
  containmentRoot: string,
  lifecycle: Rfc64DurableFileLifecycleV1<TKind>,
  containmentRootAccess: Rfc64ExistingAccessV1 = 'owner',
): Promise<void> {
  await walkRfc64ContainedDirectoryTreeV1(
    target,
    containmentRoot,
    containmentRootAccess,
    async (current) => {
      let created = false;
      try {
        await mkdir(current, { mode: RFC64_SECURE_DIRECTORY_MODE_V1 });
        created = true;
        await lifecycle.boundary('directory.created');
      } catch (cause) {
        if (!isNodeError(cause, 'EEXIST')) {
          fail('io', `failed to create durable store directory ${current}`, cause);
        }
      }
      if (created) {
        await chmodSecure(current, RFC64_SECURE_DIRECTORY_MODE_V1, 'directory');
        await lifecycle.boundary('directory.mode-secured');
        await fsyncDirectory(current);
        await lifecycle.boundary('directory.self-fsynced');
        await fsyncDirectory(dirname(current));
        await lifecycle.boundary('directory.parent-fsynced');
      }
    },
  );
}

export interface PutRfc64ExactBytesInputV1<TKind extends string> {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly maxBytes: number;
  readonly label: string;
  readonly kind: TKind;
}

interface InternalPutRfc64ExactBytesInputV1<TKind extends string>
  extends PutRfc64ExactBytesInputV1<TKind> {
  readonly containmentRoot: string;
  readonly lifecycle: Rfc64DurableFileLifecycleV1<TKind>;
}

async function putRfc64ExactBytesV1<TKind extends string>(
  input: InternalPutRfc64ExactBytesInputV1<TKind>,
): Promise<void> {
  const { containmentRoot, relativePath, bytes, maxBytes, label, lifecycle } = input;
  const targetPath = resolveContainedFileTarget(containmentRoot, relativePath);
  assertByteBounds(bytes, maxBytes, label);
  await ensureRfc64SecureDirectoryTreeV1(
    dirname(targetPath),
    containmentRoot,
    lifecycle,
    'owner-only',
  );
  const resolvedInput = { ...input, targetPath };
  if (await reconcileRfc64ExistingImmutableV1(resolvedInput)) return;
  const tempPath = await writeRfc64SecureTempFileV1(resolvedInput);
  await publishRfc64NoReplaceV1(resolvedInput, tempPath);
}

interface ResolvedPutRfc64ExactBytesInputV1<TKind extends string>
  extends InternalPutRfc64ExactBytesInputV1<TKind> {
  readonly targetPath: string;
}

async function reconcileRfc64ExistingImmutableV1<TKind extends string>(
  input: ResolvedPutRfc64ExactBytesInputV1<TKind>,
): Promise<boolean> {
  const { containmentRoot, relativePath, bytes, maxBytes, label } = input;
  const existing = await readRfc64OptionalBoundedBytesV1({
    containmentRoot,
    relativePath,
    maxBytes,
    label,
  });
  if (existing === null) return false;
  if (!bytesEqual(existing, bytes)) {
    fail('corrupt', `${label} bytes differ for the same immutable key`);
  }
  await completeRfc64ExistingFileDurabilityV1(input);
  return true;
}

async function completeRfc64ExistingFileDurabilityV1<TKind extends string>(
  input: ResolvedPutRfc64ExactBytesInputV1<TKind>,
): Promise<void> {
  const { targetPath, label, kind, lifecycle } = input;
  // A prior attempt can fail after no-replace publication but before the
  // parent-directory barrier. Re-establish both barriers before retry succeeds.
  await fsyncRegularFile(targetPath, label);
  await lifecycle.boundary(`${kind}.existing-fsynced`);
  await fsyncDirectory(dirname(targetPath));
  await lifecycle.boundary(`${kind}.existing-parent-fsynced`);
}

async function writeRfc64SecureTempFileV1<TKind extends string>(
  input: ResolvedPutRfc64ExactBytesInputV1<TKind>,
): Promise<string> {
  const { targetPath, bytes, label, kind, lifecycle } = input;
  const suffix = randomBytes(16).toString('hex');
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${suffix}.tmp`);
  let complete = false;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, 'wx', RFC64_SECURE_FILE_MODE_V1);
    await handle.writeFile(bytes);
    await lifecycle.boundary(`${kind}.temp-written`);
    await chmodSecure(tempPath, RFC64_SECURE_FILE_MODE_V1, `${label} temp file`);
    await lifecycle.boundary(`${kind}.temp-mode-secured`);
    await handle.sync();
    await lifecycle.boundary(`${kind}.temp-fsynced`);
    await handle.close();
    handle = null;
    complete = true;
    return tempPath;
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    return fail('durability', `failed to write durable ${label} temp bytes`, cause);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (!complete) await unlink(tempPath).catch(() => undefined);
  }
}

async function publishRfc64NoReplaceV1<TKind extends string>(
  input: ResolvedPutRfc64ExactBytesInputV1<TKind>,
  tempPath: string,
): Promise<void> {
  const { targetPath, label, kind, lifecycle } = input;
  let tempPresent = true;
  try {
    try {
      // Hard-link publication creates the immutable key atomically and fails
      // with EEXIST instead of replacing a target won by another writer.
      await link(tempPath, targetPath);
    } catch (cause) {
      if (!isNodeError(cause, 'EEXIST')) throw cause;
      await unlink(tempPath);
      tempPresent = false;
      if (!await reconcileRfc64ExistingImmutableV1(input)) {
        fail('durability', `${label} disappeared after a no-replace publish conflict`);
      }
      return;
    }
    await lifecycle.boundary(`${kind}.published-no-replace`);
    await unlink(tempPath);
    tempPresent = false;
    await lifecycle.boundary(`${kind}.temp-unlinked`);
    await fsyncDirectory(dirname(targetPath));
    await lifecycle.boundary(`${kind}.parent-fsynced`);
    await assertExistingRegularFile(
      targetPath,
      `${label} cache file`,
      { access: 'owner-only' },
    );
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('durability', `failed to publish durable ${label} bytes`, cause);
  } finally {
    if (tempPresent) await unlink(tempPath).catch(() => undefined);
  }
}

export interface ReadRfc64OptionalBoundedBytesInputV1 {
  readonly relativePath: string;
  readonly maxBytes: number;
  readonly label: string;
}

interface InternalReadRfc64OptionalBoundedBytesInputV1
  extends ReadRfc64OptionalBoundedBytesInputV1 {
  readonly containmentRoot: string;
}

async function readRfc64OptionalBoundedBytesV1(
  input: InternalReadRfc64OptionalBoundedBytesInputV1,
): Promise<Uint8Array | null> {
  const { containmentRoot, relativePath, maxBytes, label } = input;
  const path = resolveContainedFileTarget(containmentRoot, relativePath);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail('input', `${label} maximum byte length must be a positive safe integer`);
  }
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail('unsafe-path', `${label} must be a regular non-symlink file`);
    }
  } catch (cause) {
    if (isNodeError(cause, 'ENOENT')) return null;
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('io', `failed to inspect ${label}`, cause);
  }

  await assertRfc64ExistingSecureDirectoryTreeV1(dirname(path), containmentRoot);

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, rfc64RegularFileReadOpenFlagsV1());
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
      fail('corrupt', `${label} is outside its bounded regular-file shape`);
    }
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        fail('corrupt', `${label} was truncated during its bounded read`);
      }
      offset += read.bytesRead;
    }
    const extra = new Uint8Array(1);
    const tail = await handle.read(extra, 0, 1, offset);
    if (tail.bytesRead !== 0) {
      fail('corrupt', `${label} grew during its bounded read`);
    }
    await assertSecureAccess(
      path,
      RFC64_SECURE_FILE_MODE_V1,
      { entryKind: 'file', access: 'owner-only' },
      label,
    );
    return bytes;
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('io', `failed to read ${label}`, cause);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
  return fail('io', `failed to complete bounded read of ${label}`);
}

async function assertRfc64ExistingSecureDirectoryTreeV1(
  target: string,
  containmentRoot: string,
): Promise<void> {
  await walkRfc64ContainedDirectoryTreeV1(
    target,
    containmentRoot,
    'owner-only',
  );
}

async function walkRfc64ContainedDirectoryTreeV1(
  target: string,
  containmentRoot: string,
  containmentRootAccess: Rfc64ExistingAccessV1,
  prepareComponent?: (path: string) => Promise<void>,
): Promise<void> {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(containmentRoot);
  const relativeTarget = relative(resolvedRoot, resolvedTarget);
  if (
    relativeTarget === '..'
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)
  ) {
    fail('unsafe-path', 'durable directory escaped its containment root');
  }
  await assertRfc64ExistingDirectoryV1(
    resolvedRoot,
    'durable store containment root',
    {
      access: relativeTarget.length === 0
        ? 'owner-only'
        : containmentRootAccess,
    },
  );
  let current = resolvedRoot;
  for (const component of relativeTarget.split(sep).filter(Boolean)) {
    current = join(current, component);
    await prepareComponent?.(current);
    await assertRfc64ExistingDirectoryV1(
      current,
      'durable store directory',
      { access: 'owner-only' },
    );
  }
}

async function assertExistingRegularFile(
  path: string,
  label: string,
  policy: Rfc64ExistingDirectoryPolicyV1,
): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail('unsafe-path', `${label} must be a regular non-symlink file`);
    }
    await assertSecureAccess(
      path,
      RFC64_SECURE_FILE_MODE_V1,
      { entryKind: 'file', access: policy.access },
      label,
    );
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('io', `failed to inspect ${label}`, cause);
  }
}

async function chmodSecure(path: string, mode: number, label: string): Promise<void> {
  try {
    const entry = await lstat(path);
    await applyRfc64OwnerOnlyPermissionsV1(path, mode, {
      entryKind: entry.isDirectory() ? 'directory' : 'file',
    });
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('unsafe-path', `failed to secure ${label}`, cause);
  }
}

async function assertSecureAccess(
  path: string,
  mode: number,
  policy: Rfc64SecureAccessPolicyV1,
  label: string,
): Promise<void> {
  try {
    if (policy.access === 'owner-only') {
      await assertRfc64OwnerOnlyPermissionsV1(path, mode, {
        entryKind: policy.entryKind,
      });
    } else {
      await assertRfc64FilesystemOwnerV1(path);
    }
  } catch (cause) {
    fail(
      'unsafe-path',
      `${label} does not satisfy the ${policy.access} ${policy.entryKind} access policy`,
      cause,
    );
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  try {
    await fsyncRfc64DirectoryV1(path);
  } catch (cause) {
    fail('durability', `failed to fsync directory ${path}`, cause);
  }
}

async function fsyncRegularFile(path: string, label: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, rfc64RegularFileFsyncOpenFlagsV1());
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail('unsafe-path', `${label} fsync target is not a regular file`);
    }
    await assertSecureAccess(
      path,
      RFC64_SECURE_FILE_MODE_V1,
      { entryKind: 'file', access: 'owner-only' },
      label,
    );
    await handle.sync();
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('durability', `failed to fsync ${label}`, cause);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

function assertByteBounds(bytes: Uint8Array, maxBytes: number, label: string): void {
  if (!(bytes instanceof Uint8Array)) {
    fail('input', `${label} bytes must be a Uint8Array`);
  }
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < 1
    || bytes.byteLength < 1
    || bytes.byteLength > maxBytes
  ) {
    fail('input', `${label} bytes are outside the configured immutable bounds`);
  }
}

function resolveContainedFileTarget(containmentRoot: string, relativePath: string): string {
  if (
    typeof containmentRoot !== 'string'
    || containmentRoot.length === 0
    || typeof relativePath !== 'string'
    || relativePath.length === 0
    || isAbsolute(relativePath)
  ) {
    fail('input', 'durable file target requires one root and a non-empty relative path');
  }
  const resolvedRoot = resolve(containmentRoot);
  const targetPath = resolve(resolvedRoot, relativePath);
  const relativeTarget = relative(resolvedRoot, targetPath);
  if (
    relativeTarget.length === 0
    || relativeTarget === '..'
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)
  ) {
    fail('unsafe-path', 'durable file target escaped its containment root');
  }
  return targetPath;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    different |= left[index] ^ right[index];
  }
  return different === 0;
}

function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error
    && 'code' in cause
    && (cause as NodeJS.ErrnoException).code === code;
}

function fail(
  code: Rfc64DurableFileErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64DurableFileErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
