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

interface DestinationResolutionState {
  followedLinks: number;
}

function missingDestination(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function tooManyLinks(path: string): Error {
  const error = new Error(`Too many symbolic links while resolving ${path}`) as NodeJS.ErrnoException;
  error.code = 'ELOOP';
  return error;
}

function symlinkTarget(absolute: string, target: string): string {
  return isAbsolute(target) ? target : resolve(dirname(absolute), target);
}

function resolveDestinationSync(
  path: string,
  io: SyncAtomicWriteResolutionIo,
  state: DestinationResolutionState,
): string {
  const absolute = resolve(path);
  let status: AtomicWriteDestinationStatus | undefined;
  try {
    status = io.lstat(absolute);
  } catch (error) {
    if (!missingDestination(error)) throw error;
  }
  if (status?.isSymbolicLink()) {
    if (state.followedLinks >= 40) throw tooManyLinks(path);
    state.followedLinks += 1;
    return resolveDestinationSync(symlinkTarget(absolute, io.readlink(absolute)), io, state);
  }
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : resolve(resolveDestinationSync(parent, io, state), basename(absolute));
}

async function resolveDestination(
  path: string,
  inspect: (path: string) => Promise<AtomicWriteDestinationStatus>,
  readTarget: (path: string) => Promise<string>,
  state: DestinationResolutionState,
): Promise<string> {
  const absolute = resolve(path);
  let status: AtomicWriteDestinationStatus | undefined;
  try {
    status = await inspect(absolute);
  } catch (error) {
    if (!missingDestination(error)) throw error;
  }
  if (status?.isSymbolicLink()) {
    if (state.followedLinks >= 40) throw tooManyLinks(path);
    state.followedLinks += 1;
    return resolveDestination(symlinkTarget(absolute, await readTarget(absolute)), inspect, readTarget, state);
  }
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : resolve(await resolveDestination(parent, inspect, readTarget, state), basename(absolute));
}

/** Synchronous adapter used when registering a process-local config owner. */
export function resolveAtomicWriteDestinationSync(
  path: string,
  io: SyncAtomicWriteResolutionIo = nodeSyncResolutionIo,
): string {
  return resolveDestinationSync(path, io, { followedLinks: 0 });
}

/** Async adapter used by leases and atomic publication, including custom I/O. */
export async function resolveAtomicWriteDestination(
  path: string,
  io: Pick<AtomicWriteIo, 'lstat' | 'readlink'> = nodeIo,
): Promise<string> {
  const inspect = io.lstat ?? lstat;
  const readTarget = io.readlink ?? readlink;
  return resolveDestination(path, inspect, readTarget, { followedLinks: 0 });
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
