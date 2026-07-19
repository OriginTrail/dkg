import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  RFC64_SECURE_DIRECTORY_MODE_V1,
  RFC64_SECURE_FILE_MODE_V1,
  fsyncRfc64DirectoryV1,
  rfc64CurrentUserOwnsUidV1,
  rfc64PosixModeMatchesV1,
  rfc64RegularFileFsyncOpenFlagsV1,
  rfc64RegularFileReadOpenFlagsV1,
  rfc64UsesWindowsFilesystemPolicyV1,
} from './secure-filesystem-policy-v1.js';

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
  | 'renamed'
  | 'parent-fsynced'
  | 'existing-fsynced'
  | 'existing-parent-fsynced';

export type Rfc64DurableFileBoundaryV1<TKind extends string = string> =
  | 'directory.created'
  | 'directory.mode-secured'
  | 'directory.self-fsynced'
  | 'directory.parent-fsynced'
  | `${TKind}.${Rfc64DurableFilePublishBoundaryV1}`;

export interface Rfc64DurableFileIoV1<TKind extends string = string> {
  readonly boundary: (boundary: Rfc64DurableFileBoundaryV1<TKind>) => void;
  readonly randomSuffix: () => string;
}

export async function assertRfc64ExistingDirectoryV1(
  path: string,
  label: string,
  requireSecureMode: boolean,
): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      fail('unsafe-path', `${label} must be a non-symlink directory`);
    }
    assertOwner(entry.uid, label);
    if (
      requireSecureMode
      && !rfc64PosixModeMatchesV1(entry.mode, RFC64_SECURE_DIRECTORY_MODE_V1)
    ) {
      fail('unsafe-path', `${label} must have owner-only mode 0700`);
    }
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('io', `failed to inspect ${label}`, cause);
  }
}

export async function ensureRfc64SecureDirectoryTreeV1<TKind extends string>(
  target: string,
  containmentRoot: string,
  io: Rfc64DurableFileIoV1<TKind>,
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

  if (relativeTarget.length === 0) {
    await assertRfc64ExistingDirectoryV1(
      resolvedTarget,
      'durable store directory',
      true,
    );
    return;
  }
  await assertRfc64ExistingDirectoryV1(
    resolvedRoot,
    'durable store containment root',
    false,
  );
  let current = resolvedRoot;
  for (const component of relativeTarget.split(sep).filter(Boolean)) {
    current = join(current, component);
    let created = false;
    try {
      await mkdir(current, { mode: RFC64_SECURE_DIRECTORY_MODE_V1 });
      created = true;
      io.boundary('directory.created');
    } catch (cause) {
      if (!isNodeError(cause, 'EEXIST')) {
        fail('io', `failed to create durable store directory ${current}`, cause);
      }
    }
    if (created) {
      await chmodSecure(current, RFC64_SECURE_DIRECTORY_MODE_V1, 'directory');
      io.boundary('directory.mode-secured');
      await fsyncDirectory(current);
      io.boundary('directory.self-fsynced');
      await fsyncDirectory(dirname(current));
      io.boundary('directory.parent-fsynced');
    }
    await assertRfc64ExistingDirectoryV1(current, 'durable store directory', true);
  }
}

export interface PutRfc64ExactBytesInputV1<TKind extends string> {
  readonly targetPath: string;
  readonly bytes: Uint8Array;
  readonly maxBytes: number;
  readonly label: string;
  readonly kind: TKind;
  readonly io: Rfc64DurableFileIoV1<TKind>;
}

export async function putRfc64ExactBytesV1<TKind extends string>(
  input: PutRfc64ExactBytesInputV1<TKind>,
): Promise<void> {
  const { targetPath, bytes, maxBytes, label, kind, io } = input;
  assertByteBounds(bytes, maxBytes, label);
  const existing = await readRfc64OptionalBoundedBytesV1(targetPath, maxBytes, label);
  if (existing !== null) {
    if (!bytesEqual(existing, bytes)) {
      fail('corrupt', `${label} bytes differ for the same immutable key`);
    }
    // A prior attempt can fail after rename but before the parent-directory
    // barrier. Re-establish both barriers before an idempotent retry succeeds.
    await fsyncRegularFile(targetPath, label);
    io.boundary(`${kind}.existing-fsynced`);
    await fsyncDirectory(dirname(targetPath));
    io.boundary(`${kind}.existing-parent-fsynced`);
    return;
  }

  const suffix = io.randomSuffix();
  if (!/^[0-9a-f]{32}$/u.test(suffix)) {
    fail('input', 'durable file random suffix must be 16 lowercase hex bytes');
  }
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${suffix}.tmp`);
  let createdTemp = false;
  let renamed = false;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, 'wx', RFC64_SECURE_FILE_MODE_V1);
    createdTemp = true;
    await handle.writeFile(bytes);
    io.boundary(`${kind}.temp-written`);
    await chmodSecure(tempPath, RFC64_SECURE_FILE_MODE_V1, `${label} temp file`);
    io.boundary(`${kind}.temp-mode-secured`);
    await handle.sync();
    io.boundary(`${kind}.temp-fsynced`);
    await handle.close();
    handle = null;
    await rename(tempPath, targetPath);
    renamed = true;
    io.boundary(`${kind}.renamed`);
    await fsyncDirectory(dirname(targetPath));
    io.boundary(`${kind}.parent-fsynced`);
    await assertExistingRegularFile(targetPath, `${label} cache file`, true);
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('durability', `failed to durably stage ${label} bytes`, cause);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (createdTemp && !renamed) await unlink(tempPath).catch(() => undefined);
  }
}

export async function readRfc64OptionalBoundedBytesV1(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Uint8Array | null> {
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
    assertOwner(stat.uid, label);
    if (!rfc64PosixModeMatchesV1(stat.mode, RFC64_SECURE_FILE_MODE_V1)) {
      fail('unsafe-path', `${label} must have owner-only mode 0600`);
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('io', `failed to read ${label}`, cause);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
  return fail('io', `failed to complete bounded read of ${label}`);
}

async function assertExistingRegularFile(
  path: string,
  label: string,
  requireSecureMode: boolean,
): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail('unsafe-path', `${label} must be a regular non-symlink file`);
    }
    assertOwner(entry.uid, label);
    if (
      requireSecureMode
      && !rfc64PosixModeMatchesV1(entry.mode, RFC64_SECURE_FILE_MODE_V1)
    ) {
      fail('unsafe-path', `${label} must have owner-only mode 0600`);
    }
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('io', `failed to inspect ${label}`, cause);
  }
}

async function chmodSecure(path: string, mode: number, label: string): Promise<void> {
  try {
    if (!rfc64UsesWindowsFilesystemPolicyV1()) await chmod(path, mode);
    const entry = await lstat(path);
    assertOwner(entry.uid, label);
    if (!rfc64PosixModeMatchesV1(entry.mode, mode)) {
      throw new Error(
        `${label} mode is ${(entry.mode & 0o777).toString(8)}, expected ${mode.toString(8)}`,
      );
    }
  } catch (cause) {
    if (cause instanceof Rfc64DurableFileErrorV1) throw cause;
    fail('unsafe-path', `failed to secure ${label}`, cause);
  }
}

function assertOwner(uid: number, label: string): void {
  if (!rfc64CurrentUserOwnsUidV1(uid)) {
    fail('unsafe-path', `${label} is not owned by the current process user`);
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
    assertOwner(stat.uid, label);
    if (!rfc64PosixModeMatchesV1(stat.mode, RFC64_SECURE_FILE_MODE_V1)) {
      fail('unsafe-path', `${label} fsync target must have owner-only mode 0600`);
    }
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
