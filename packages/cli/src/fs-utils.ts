import { randomUUID } from 'node:crypto';
import { lstat, readlink, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface AtomicWriteIo {
  writeFile(
    path: string,
    data: string,
    options?: { flag?: string; mode?: number },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink?(path: string): Promise<unknown>;
  lstat?(path: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink?(path: string): Promise<string>;
}

export interface AtomicWriteOptions {
  io?: AtomicWriteIo;
  writeOptions?: { flag?: string; mode?: number };
}

const nodeIo: AtomicWriteIo = { writeFile, rename, unlink, lstat, readlink };

/** Resolve a symlinked publication path without replacing the link itself. */
export async function resolveAtomicWriteDestination(
  path: string,
  io: Pick<AtomicWriteIo, 'lstat' | 'readlink'> = nodeIo,
): Promise<string> {
  const inspect = io.lstat ?? lstat;
  const readTarget = io.readlink ?? readlink;
  let destination = path;
  for (let depth = 0; depth < 40; depth += 1) {
    let status: Awaited<ReturnType<typeof lstat>>;
    try {
      status = await inspect(destination) as Awaited<ReturnType<typeof lstat>>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return destination;
      throw error;
    }
    if (!status.isSymbolicLink()) return destination;
    const target = await readTarget(destination);
    destination = isAbsolute(target) ? target : resolve(dirname(destination), target);
  }
  const error = new Error(`Too many symbolic links while resolving ${path}`) as NodeJS.ErrnoException;
  error.code = 'ELOOP';
  throw error;
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
