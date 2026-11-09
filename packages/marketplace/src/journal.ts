// SPDX-License-Identifier: Apache-2.0

/**
 * An append-only store of JSON lines, read back a chunk at a time and folded by
 * its reader: the seller's ledger and the buyer's receipts and nonce counters.
 * An append is on disk (fsync) before it returns, so what it records survives a
 * crash right after. A torn last line, from a crash during an append, is
 * skipped, and the next append starts a line of its own. Its owner may replace
 * it whole, to prune it, keeping appends out meanwhile.
 *
 * Also the whole-file write the marketplace's other files use: aside, on disk,
 * then renamed over the file; and setting aside a file that cannot be used.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** How much of a journal a read takes at a time: a long journal is never one string. */
const READ_CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

export class Journal<T> {
  constructor(readonly file: string) {}

  async append(entry: T): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const handle = await open(this.file, 'a+', 0o600);
    try {
      const line = `${JSON.stringify(entry)}\n`;
      // After a torn last line the entry starts a line of its own, or the next read would lose it with the torn one.
      await handle.appendFile((await endsTorn(handle)) ? `\n${line}` : line);
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  /** Replace its lines with `entries`: written beside it, on disk, then renamed over it, so a crash leaves the old or the new. */
  async replace(entries: readonly T[]): Promise<void> {
    await writeDurably(this.file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }

  /** Its entries, in order; a line that does not parse is skipped. */
  async read(): Promise<T[]> {
    let handle: FileHandle;
    try {
      handle = await open(this.file, 'r');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
    const entries: T[] = [];
    const take = (line: string): void => {
      if (!line) return;
      try {
        entries.push(JSON.parse(line) as T);
      } catch {
        // A torn line: the append it belonged to never returned.
      }
    };
    try {
      const decoder = new StringDecoder('utf8');
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      let rest = '';
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        const lines = (rest + decoder.write(chunk.subarray(0, bytesRead))).split('\n');
        rest = lines.pop()!;
        for (const line of lines) take(line);
      }
      take(rest + decoder.end());
    } finally {
      await handle.close();
    }
    return entries;
  }
}

/** Whether the file ends in a line with no newline: what a crash during an append leaves. */
async function endsTorn(handle: FileHandle): Promise<boolean> {
  const { size } = await handle.stat();
  if (size === 0) return false;
  const last = Buffer.alloc(1);
  await handle.read(last, 0, 1, size - 1);
  return last[0] !== NEWLINE;
}

/**
 * Write `text` as the whole of `file`, mode 0600: beside it, on disk (fsync),
 * then renamed over it, and the rename synced, so a crash or a power loss
 * leaves the old file or the new one, never an empty one.
 */
export async function writeDurably(file: string, text: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const aside = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await open(aside, 'w', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(aside, file);
  } catch (err) {
    await rm(aside, { force: true }).catch(() => undefined);
    throw err;
  }
  await syncDirectory(dir);
}

/**
 * Keep a file that could not be used beside it, named for when: moved, or
 * copied when its owner goes on using it. Returns where the copy is.
 */
export async function setAside(file: string, how: 'move' | 'copy' = 'move'): Promise<string> {
  const aside = `${file}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;
  if (how === 'copy') await copyFile(file, aside);
  else await rename(file, aside);
  await syncDirectory(dirname(file));
  return aside;
}

/** The rename in `dir` on disk too, where the platform opens a directory. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // A platform that cannot open a directory keeps the rename as its file system does.
  }
}

/** Run `fn` after every call queued under the same key before it, so two never overlap. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const before = this.tails.get(key) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }
}
