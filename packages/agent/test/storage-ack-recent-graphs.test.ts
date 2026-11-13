import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE_ACK_RECENT_GRAPHS_FILE,
  STORAGE_ACK_RECENT_GRAPH_REFRESH_MS,
  STORAGE_ACK_RECENT_GRAPH_TTL_MS,
  StorageAckRecentGraphs,
} from '../src/storage-ack-recent-graphs.js';

/** The graphs StorageACK requests reached recently, kept across restarts. */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-recent-acks-'));
  dirs.push(dir);
  return join(dir, STORAGE_ACK_RECENT_GRAPHS_FILE);
}

describe('recently ACK-requested graphs', () => {
  it('keeps a requested graph for the next start', async () => {
    const path = await tempPath();
    let now = 1_000_000;
    const before = new StorageAckRecentGraphs({ path, now: () => now });
    await before.load();
    before.note('graph-a', '1001');
    now += 5_000;
    before.note('graph-b', '1002');
    await before.whenWritten();

    const after = new StorageAckRecentGraphs({ path, now: () => now });
    await after.load();
    expect(after.recent()).toEqual([
      { contextGraphId: 'graph-b', onChainId: '1002', at: 1_005_000 },
      { contextGraphId: 'graph-a', onChainId: '1001', at: 1_000_000 },
    ]);
  });

  it('writes a busy graph again only once its saved time is an hour old', async () => {
    const path = await tempPath();
    let now = 0;
    const writes = vi.fn();
    const list = new StorageAckRecentGraphs({
      path,
      now: () => now,
      io: {
        readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
        writeFile: async (file, data) => { writes(file, data); },
        rename: async () => undefined,
        mkdir: async () => undefined,
      },
    });
    for (let second = 0; second < 600; second += 1) {
      now = second * 1_000;
      list.note('busy-graph', '42');
      await list.whenWritten();
    }
    expect(writes).toHaveBeenCalledTimes(1);
    now = STORAGE_ACK_RECENT_GRAPH_REFRESH_MS;
    list.note('busy-graph', '42');
    await list.whenWritten();
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('keeps the most recent graphs within its bound and forgets old ones', async () => {
    const path = await tempPath();
    let now = STORAGE_ACK_RECENT_GRAPH_TTL_MS;
    const list = new StorageAckRecentGraphs({ path, now: () => now, maxGraphs: 3 });
    await list.load();
    for (let i = 0; i < 5; i += 1) {
      now += 1_000;
      list.note(`graph-${i}`, String(100 + i));
    }
    expect(list.recent().map((entry) => entry.contextGraphId)).toEqual(['graph-4', 'graph-3', 'graph-2']);

    // graph-2 was requested a day ago; graph-3 a second later.
    now += STORAGE_ACK_RECENT_GRAPH_TTL_MS - 1_500;
    expect(list.recent().map((entry) => entry.contextGraphId)).toEqual(['graph-4', 'graph-3']);
    await list.whenWritten();
    const reloaded = new StorageAckRecentGraphs({ path, now: () => now, maxGraphs: 3 });
    await reloaded.load();
    expect(reloaded.recent().map((entry) => entry.contextGraphId)).toEqual(['graph-4', 'graph-3']);
  });

  it('ignores an unreadable file and replaces it on the next request', async () => {
    const path = await tempPath();
    await writeFile(path, '{not json');
    const warn = vi.fn();
    const list = new StorageAckRecentGraphs({ path, warn });
    await list.load();
    expect(list.recent()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));

    list.note('graph', '7');
    await list.whenWritten();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 1,
      graphs: [{ contextGraphId: 'graph', onChainId: '7' }],
    });
  });

  it('keeps the saved list when a request is noted before it is read', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({
      version: 1,
      graphs: [
        { contextGraphId: 'saved', onChainId: '5', at: Date.now() - 1_000 },
        { contextGraphId: 'bad-id', onChainId: '0x5', at: Date.now() },
      ],
    }));
    const list = new StorageAckRecentGraphs({ path });
    list.note('fresh', '6');
    await list.whenWritten();

    expect(list.recent().map((entry) => entry.contextGraphId)).toEqual(['fresh', 'saved']);
    const written = JSON.parse(await readFile(path, 'utf8')) as { graphs: Array<{ contextGraphId: string }> };
    expect(written.graphs.map((entry) => entry.contextGraphId)).toEqual(['fresh', 'saved']);
  });

  it('lives in memory without a file', async () => {
    const list = new StorageAckRecentGraphs();
    await list.load();
    list.note('graph', '9');
    list.note('', '9');
    list.note('other', 'not-an-id');
    await list.whenWritten();
    expect(list.recent().map((entry) => entry.contextGraphId)).toEqual(['graph']);
  });
});
