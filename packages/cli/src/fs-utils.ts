import { randomUUID } from 'node:crypto';
import { lstatSync, readlinkSync } from 'node:fs';
import { lstat, readlink, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

export interface AtomicWriteDestinationStatus {
  isSymbolicLink(): boolean;
}

export interface AtomicWriteResolutionIo {
  lstat(path: string): Promise<AtomicWriteDestinationStatus>;
  readlink(path: string): Promise<string>;
}

export interface SyncAtomicWriteResolutionIo {
  lstat(path: string): AtomicWriteDestinationStatus;
  readlink(path: string): string;
}

export interface AtomicWriteIo {
  writeFile(
    path: string,
    data: string,
    options?: { flag?: string; mode?: number },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink?(path: string): Promise<unknown>;
  lstat?(path: string): Promise<AtomicWriteDestinationStatus>;
  readlink?(path: string): Promise<string>;
}

export interface AtomicWriteOptions {
  io?: AtomicWriteIo;
  writeOptions?: { flag?: string; mode?: number };
}

const nodeIo: AtomicWriteIo = { writeFile, rename, unlink, lstat, readlink };
const nodeSyncResolutionIo: SyncAtomicWriteResolutionIo = {
  lstat: lstatSync,
  readlink: path => readlinkSync(path, 'utf8'),
};

type DestinationResolutionRequest =
  | { readonly kind: 'lstat'; readonly path: string }
  | { readonly kind: 'readlink'; readonly path: string };

interface DestinationResolutionState {
  followedLinks: number;
}

/**
 * The single config-destination algorithm. Sync registration and async I/O
 * drive this same resolver so ownership, locking, backup, and publication use
 * identical identities for final/parent symlinks and nonexistent targets.
 */
function* destinationResolver(
  path: string,
  state: DestinationResolutionState,
): Generator<DestinationResolutionRequest, string, AtomicWriteDestinationStatus | string | undefined> {
  const absolute = resolve(path);
  const status = yield { kind: 'lstat', path: absolute };
  if (status !== undefined && typeof status !== 'string' && status.isSymbolicLink()) {
    if (state.followedLinks >= 40) {
      const error = new Error(`Too many symbolic links while resolving ${path}`) as NodeJS.ErrnoException;
      error.code = 'ELOOP';
      throw error;
    }
    state.followedLinks += 1;
    const target = yield { kind: 'readlink', path: absolute };
    if (typeof target !== 'string') throw new Error(`Invalid symbolic link target for ${absolute}`);
    return yield* destinationResolver(
      isAbsolute(target) ? target : resolve(dirname(absolute), target),
      state,
    );
  }

  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return resolve(yield* destinationResolver(parent, state), basename(absolute));
}

function missingDestination(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Synchronous adapter used when registering a process-local config owner. */
export function resolveAtomicWriteDestinationSync(
  path: string,
  io: SyncAtomicWriteResolutionIo = nodeSyncResolutionIo,
): string {
  const resolver = destinationResolver(path, { followedLinks: 0 });
  let step = resolver.next();
  while (!step.done) {
    const request = step.value;
    try {
      if (request.kind === 'readlink') {
        step = resolver.next(io.readlink(request.path));
      } else {
        try {
          step = resolver.next(io.lstat(request.path));
        } catch (error) {
          if (!missingDestination(error)) throw error;
          step = resolver.next(undefined);
        }
      }
    } catch (error) {
      step = resolver.throw(error);
    }
  }
  return step.value;
}

/** Async adapter used by leases and atomic publication, including custom I/O. */
export async function resolveAtomicWriteDestination(
  path: string,
  io: Pick<AtomicWriteIo, 'lstat' | 'readlink'> = nodeIo,
): Promise<string> {
  const inspect = io.lstat ?? lstat;
  const readTarget = io.readlink ?? readlink;
  const resolver = destinationResolver(path, { followedLinks: 0 });
  let step = resolver.next();
  while (!step.done) {
    const request = step.value;
    try {
      if (request.kind === 'readlink') {
        step = resolver.next(await readTarget(request.path));
      } else {
        try {
          step = resolver.next(await inspect(request.path));
        } catch (error) {
          if (!missingDestination(error)) throw error;
          step = resolver.next(undefined);
        }
      }
    } catch (error) {
      step = resolver.throw(error);
    }
  }
  return step.value;
}

/** Publish a complete file through one shared temp-write/rename primitive. */
export async function writeFileAtomic(
  path: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const io = options.io ?? nodeIo;
  const destination = await resolveAtomicWriteDestination(path, io);
  const staged = `${destination}.tmp.${process.pid}.${Date.now().toString(36)}.${randomUUID()}`;
  try {
    await io.writeFile(staged, data, options.writeOptions);
    await io.rename(staged, destination);
  } catch (error) {
    try { await io.unlink?.(staged); } catch { /* best-effort cleanup */ }
    throw error;
  }
}
