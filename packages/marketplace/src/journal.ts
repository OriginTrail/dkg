// SPDX-License-Identifier: Apache-2.0

/**
 * An append-only store of JSON lines, read whole and folded by its reader:
 * the seller's ledger and the buyer's receipts and nonce counters. An append
 * is on disk (fsync) before it returns, so what it records survives a crash
 * right after. A torn last line, from a crash during an append, is skipped.
 * Its owner may replace it whole, to prune it, keeping appends out meanwhile.
 */
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export class Journal<T> {
  constructor(readonly file: string) {}

  async append(entry: T): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const handle = await open(this.file, 'a', 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(entry)}\n`);
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  /** Replace its lines with `entries`: written beside it, on disk, then renamed over it, so a crash leaves the old or the new. */
  async replace(entries: readonly T[]): Promise<void> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true });
    const next = `${this.file}.next`;
    const handle = await open(next, 'w', 0o600);
    try {
      await handle.writeFile(entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(next, this.file);
    await syncDirectory(dir);
  }

  async read(): Promise<T[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
    const entries: T[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as T);
      } catch {
        // A torn line: the append it belonged to never returned.
      }
    }
    return entries;
  }
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
