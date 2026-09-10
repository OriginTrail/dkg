import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';

export interface AtomicWriteIo {
  writeFile(
    path: string,
    data: string,
    options?: { flag?: string; mode?: number },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink?(path: string): Promise<unknown>;
}

export interface AtomicWriteOptions {
  io?: AtomicWriteIo;
  writeOptions?: { flag?: string; mode?: number };
}

const nodeIo: AtomicWriteIo = { writeFile, rename, unlink };

/** Publish a complete file through one shared temp-write/rename primitive. */
export async function writeFileAtomic(
  path: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const io = options.io ?? nodeIo;
  const staged = `${path}.tmp.${process.pid}.${Date.now().toString(36)}.${randomUUID()}`;
  try {
    await io.writeFile(staged, data, options.writeOptions);
    await io.rename(staged, path);
  } catch (error) {
    try { await io.unlink?.(staged); } catch { /* best-effort cleanup */ }
    throw error;
  }
}
