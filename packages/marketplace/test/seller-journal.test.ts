// SPDX-License-Identifier: Apache-2.0
/**
 * The journal and the whole-file write the marketplace's files share: a
 * journal whose last line a crash tore keeps the next append, a long one is
 * read a chunk at a time, and a file written whole is on disk before it is
 * renamed over the old one, as the buyer store writes its files.
 */
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyerStore, Journal, setAside, writeDurably } from '../src/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-seller-journal-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** FileHandle's prototype, whose `sync` every write on disk goes through. */
async function fileHandleProto(): Promise<{ sync(): Promise<void> }> {
  const probe = await open(join(dir, 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  return proto;
}

describe('a journal', () => {
  it('keeps the next append after a torn last line', async () => {
    const file = join(dir, 'torn.jsonl');
    await writeFile(file, `${JSON.stringify({ n: 1 })}\n{"n":`);
    const journal = new Journal<{ n: number }>(file);
    await journal.append({ n: 3 });
    expect(await journal.read()).toEqual([{ n: 1 }, { n: 3 }]);
    await journal.append({ n: 4 });
    expect(await journal.read()).toEqual([{ n: 1 }, { n: 3 }, { n: 4 }]);
    expect(await readFile(file, 'utf8')).toBe('{"n":1}\n{"n":\n{"n":3}\n{"n":4}\n');
  });

  it('reads entries longer than one read takes, with characters across its chunks', async () => {
    const journal = new Journal<{ text: string }>(join(dir, 'long.jsonl'));
    const entries = [{ text: 'é'.repeat(40_001) }, { text: 'a' }, { text: '€'.repeat(70_000) }, { text: 'b'.repeat(65_536) }];
    for (const e of entries) await journal.append(e);
    expect(await journal.read()).toEqual(entries);
    expect(await new Journal(join(dir, 'none.jsonl')).read()).toEqual([]);
  });
});

describe('a file written whole', () => {
  it('is on disk before it is renamed over the old one, and leaves nothing beside it', async () => {
    const file = join(dir, 'whole.json');
    await writeDurably(file, 'old\n');
    const proto = await fileHandleProto();
    const original = proto.sync;
    // What the file holds when each handle is synced: the old text, until the rename.
    const seen: string[] = [];
    vi.spyOn(proto, 'sync').mockImplementation(async function (this: unknown) {
      seen.push(await readFile(file, 'utf8'));
      return original.call(this);
    });
    await writeDurably(file, 'new\n');
    expect(seen[0]).toBe('old\n');
    expect(await readFile(file, 'utf8')).toBe('new\n');
    expect((await readdir(dir)).sort()).toEqual(['probe', 'whole.json']);
  });

  it('as the buyer store writes its files', async () => {
    const proto = await fileHandleProto();
    const sync = vi.spyOn(proto, 'sync');
    const store = new BuyerStore(join(dir, 'buyer'));
    await store.recordFunding(`0x${'cd'.repeat(32)}`, 7);
    expect(sync).toHaveBeenCalled();
    expect(await store.fundingBlock(`0x${'cd'.repeat(32)}`)).toBe(7);
    expect((await readdir(join(dir, 'buyer'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('that cannot be used is kept beside it, moved or copied', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(file, '{');
    const copied = await setAside(file, 'copy');
    expect(await readFile(file, 'utf8')).toBe('{');
    const moved = await setAside(file);
    expect(moved).toMatch(/bad\.json\.bad-\d{4}-\d{2}-\d{2}T/);
    expect(await readFile(moved, 'utf8')).toBe('{');
    expect(await readFile(copied, 'utf8')).toBe('{');
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
