import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';

export interface AtomicArtifactWriteResult {
  readonly sha256: string;
  readonly durability:
    | 'posix-file-fsync-rename-directory-fsync-v1'
    | 'windows-file-fsync-rename-topology-validated-v1';
}

interface DirectoryIdentity {
  readonly realPath: string;
  readonly device: string;
  readonly inode: string;
}

export function readCleanRepositoryHead(repoRootInput: string): string {
  const repoRoot = resolve(repoRootInput);
  const discoveredRoot = git(repoRoot, ['rev-parse', '--show-toplevel']);
  if (realpathSync.native(discoveredRoot) !== realpathSync.native(repoRoot)) {
    throw new Error(
      `Gate 0 repository root mismatch: expected ${repoRoot}, git reported ${discoveredRoot}`,
    );
  }
  const status = git(repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=no',
    '--ignore-submodules=untracked',
  ]);
  if (status !== '') {
    throw new Error(
      `Gate 0 refuses to spawn with tracked source changes:\n${status}`,
    );
  }
  const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[0-9a-f]{40,64}$/u.test(head)) {
    throw new Error(`Git returned an invalid repository HEAD: ${JSON.stringify(head)}`);
  }
  return head;
}

export interface StableJsonOptions {
  readonly format?: 'pretty' | 'compact';
  readonly trailingLf?: boolean;
  readonly numbers?: 'finite' | 'safe-integer';
}

export function stableJson(value: unknown, options: StableJsonOptions = {}): string {
  const normalized = normalizePlainJsonValue(
    value,
    '$',
    new WeakSet<object>(),
    options.numbers ?? 'finite',
  );
  const encoded = JSON.stringify(
    normalized,
    null,
    options.format === 'compact' ? undefined : 2,
  );
  return options.trailingLf === false ? encoded : `${encoded}\n`;
}

export function atomicWriteStableJson(
  artifactPathInput: string,
  value: unknown,
): AtomicArtifactWriteResult {
  return atomicWriteExactBytes(
    artifactPathInput,
    Buffer.from(stableJson(value), 'utf8'),
  );
}

/** Atomically publish caller-canonicalized artifact bytes without re-encoding them. */
export function atomicWriteExactBytes(
  artifactPathInput: string,
  bytesInput: Uint8Array,
): AtomicArtifactWriteResult {
  const artifactPath = resolve(artifactPathInput);
  const parentPath = dirname(artifactPath);
  mkdirSync(parentPath, { recursive: true, mode: 0o700 });
  const parentIdentity = inspectDirectory(parentPath, 'artifact parent directory');
  assertReplaceableArtifactTarget(artifactPath);

  const bytes = Buffer.from(bytesInput);
  const intendedSha256 = sha256(bytes);
  const tempPath = resolve(
    parentPath,
    `.${basename(artifactPath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let fileDescriptor: number | null = null;
  let renamed = false;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    fileDescriptor = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    fchmodSync(fileDescriptor, 0o600);
    writeAll(fileDescriptor, bytes);
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = null;

    assertSameDirectory(parentPath, parentIdentity);
    assertRegularOwnerOnlyFile(tempPath, 'artifact sibling temp file');
    assertReplaceableArtifactTarget(artifactPath);
    renameSync(tempPath, artifactPath);
    renamed = true;

    assertSameDirectory(parentPath, parentIdentity);
    assertRegularOwnerOnlyFile(artifactPath, 'published artifact');
    const durability = fsyncArtifactParent(parentPath);
    assertSameDirectory(parentPath, parentIdentity);

    const publishedBytes = readFileSync(artifactPath);
    const publishedSha256 = sha256(publishedBytes);
    if (!publishedBytes.equals(bytes) || publishedSha256 !== intendedSha256) {
      throw new Error('Published Gate 0 artifact bytes did not match the fsynced temp file');
    }
    return { sha256: publishedSha256, durability };
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
    if (!renamed) rmSync(tempPath, { force: true });
  }
}

function git(repoRoot: string, args: readonly string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause) {
    throw new Error(`Git repository inspection failed: git ${args.join(' ')}`, { cause });
  }
}

function normalizePlainJsonValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  numbers: NonNullable<StableJsonOptions['numbers']>,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)
      || (numbers === 'safe-integer' && !Number.isSafeInteger(value))) {
      throw new TypeError(`${path} contains a non-lossless JSON number`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} contains unsupported ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${path} repeats or cycles an object reference`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${path} is not a plain array`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new TypeError(`${path} has a symbol-keyed array property`);
    }
    const expectedKeys = new Set<string>(['length']);
    for (let index = 0; index < value.length; index += 1) {
      expectedKeys.add(String(index));
    }
    if (
      ownKeys.length !== expectedKeys.size
      || ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))
    ) {
      throw new TypeError(`${path} is sparse or has non-index array properties`);
    }
    return value.map((_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}[${index}] is not an enumerable data property`);
      }
      return normalizePlainJsonValue(descriptor.value, `${path}[${index}]`, seen, numbers);
    });
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} is not a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${path} has a symbol-keyed object property`);
  }
  const entries = ownKeys
    .map((key): readonly [string, unknown] => {
      if (typeof key !== 'string') throw new TypeError(`${path} has an invalid key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}.${key} is not an enumerable data property`);
      }
      return [key, normalizePlainJsonValue(descriptor.value, `${path}.${key}`, seen, numbers)];
    })
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Object.fromEntries(entries);
}

function inspectDirectory(path: string, label: string): DirectoryIdentity {
  const topology = lstatSync(path);
  if (topology.isSymbolicLink() || !topology.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory: ${path}`);
  }
  const identity = statSync(path, { bigint: true });
  return {
    realPath: realpathSync.native(path),
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
  };
}

function assertSameDirectory(path: string, expected: DirectoryIdentity): void {
  const actual = inspectDirectory(path, 'artifact parent directory');
  if (
    actual.realPath !== expected.realPath
    || actual.device !== expected.device
    || actual.inode !== expected.inode
  ) {
    throw new Error(`Artifact parent directory topology changed during publication: ${path}`);
  }
}

function assertReplaceableArtifactTarget(path: string): void {
  try {
    const topology = lstatSync(path);
    if (topology.isSymbolicLink() || !topology.isFile()) {
      throw new Error(`Artifact target must be absent or a non-symlink regular file: ${path}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

function assertRegularOwnerOnlyFile(path: string, label: string): void {
  const topology = lstatSync(path);
  if (topology.isSymbolicLink() || !topology.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file: ${path}`);
  }
  if (process.platform !== 'win32' && (topology.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must have mode 0600: ${path}`);
  }
}

function writeAll(fileDescriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      fileDescriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (written <= 0) throw new Error('Artifact sibling temp write made no progress');
    offset += written;
  }
}

function fsyncArtifactParent(
  parentPath: string,
): AtomicArtifactWriteResult['durability'] {
  if (process.platform === 'win32') {
    return 'windows-file-fsync-rename-topology-validated-v1';
  }
  const directoryDescriptor = openSync(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
  return 'posix-file-fsync-rename-directory-fsync-v1';
}

function sha256(bytes: Uint8Array): string {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
