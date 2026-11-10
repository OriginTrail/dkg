/**
 * Unit tests for IncrementalEventScan: a repeat read covers only the blocks
 * since the last one (plus a reorg tail), overlapping reads share one scan,
 * a scan that fails part-way keeps the pages it finished, and a change of
 * anchor is handled without dropping or missing items.
 */
import { describe, expect, it } from 'vitest';
import { IncrementalEventScan } from '../src/incremental-event-scan.js';

type Page = [number, number];

/** A fake chain: `events` maps a block to the ids logged there. */
function chainOf(events: Record<number, string[]>) {
  const pages: Page[] = [];
  const readPage = async (lo: number, hi: number): Promise<string[]> => {
    pages.push([lo, hi]);
    const found: string[] = [];
    for (const [block, ids] of Object.entries(events)) {
      if (Number(block) >= lo && Number(block) <= hi) found.push(...ids);
    }
    return found;
  };
  return { pages, readPage };
}

const id = (item: string): string => item;

describe('IncrementalEventScan', () => {
  it('reads the whole range once, then only the blocks since the last read and the reorg tail', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 10 });
    const chain = chainOf({ 105: ['a'], 230: ['b'] });
    let head = 250;
    const range = async () => ({ anchor: 100, head });

    expect((await scan.read('k', range, chain.readPage, id)).sort()).toEqual(['a', 'b']);
    expect(chain.pages).toEqual([[100, 199], [200, 250]]);

    chain.pages.length = 0;
    head = 300;
    expect((await scan.read('k', range, chain.readPage, id)).sort()).toEqual(['a', 'b']);
    // From the last block read (250), less the 10-block tail.
    expect(chain.pages).toEqual([[241, 300]]);

    chain.pages.length = 0;
    expect((await scan.read('k', range, chain.readPage, id)).sort()).toEqual(['a', 'b']);
    expect(chain.pages).toEqual([[291, 300]]);
  });

  it('finds an item logged in a later block', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const events: Record<number, string[]> = { 120: ['a'] };
    const chain = chainOf(events);
    let head = 150;
    const range = async () => ({ anchor: 100, head });
    expect(await scan.read('k', range, chain.readPage, id)).toEqual(['a']);
    events[160] = ['b'];
    head = 170;
    expect((await scan.read('k', range, chain.readPage, id)).sort()).toEqual(['a', 'b']);
  });

  it('keeps an item found twice once', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 50 });
    const chain = chainOf({ 140: ['a'] });
    const range = async () => ({ anchor: 100, head: 150 });
    expect(await scan.read('k', range, chain.readPage, id)).toEqual(['a']);
    // The tail read covers block 140 again.
    expect(await scan.read('k', range, chain.readPage, id)).toEqual(['a']);
  });

  it('shares one scan between reads that overlap', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const chain = chainOf({ 110: ['a'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const range = async () => { await gate; return { anchor: 100, head: 299 }; };
    const first = scan.read('k', range, chain.readPage, id);
    const second = scan.read('k', range, chain.readPage, id);
    expect(second).toBe(first);
    release();
    expect(await first).toEqual(['a']);
    expect(chain.pages).toEqual([[100, 199], [200, 299]]);
  });

  it('keeps the pages a failed read finished, and goes on from there', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const chain = chainOf({ 150: ['a'], 250: ['b'] });
    let failAt: number | undefined = 200;
    const readPage = async (lo: number, hi: number) => {
      if (lo === failAt) throw new Error('rate limited');
      return chain.readPage(lo, hi);
    };
    const range = async () => ({ anchor: 100, head: 299 });
    await expect(scan.read('k', range, readPage, id)).rejects.toThrow('rate limited');
    expect(chain.pages).toEqual([[100, 199]]);

    failAt = undefined;
    chain.pages.length = 0;
    expect((await scan.read('k', range, readPage, id)).sort()).toEqual(['a', 'b']);
    expect(chain.pages).toEqual([[200, 299]]);
  });

  it('starts a new read after a failure instead of sharing the failed one', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    let fail = true;
    const range = async () => {
      if (fail) throw new Error('no backend');
      return { anchor: 100, head: 120 };
    };
    const readPage = async () => ['a'];
    await expect(scan.read('k', range, readPage, id)).rejects.toThrow('no backend');
    fail = false;
    expect(await scan.read('k', range, readPage, id)).toEqual(['a']);
  });

  it('reads again from a lower anchor, and keeps its progress for a higher one', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const chain = chainOf({ 50: ['early'], 150: ['a'] });
    let anchor = 100;
    const range = async () => ({ anchor, head: 199 });
    expect(await scan.read('k', range, chain.readPage, id)).toEqual(['a']);

    // An anchor below the one the progress started at: the blocks in between were never read.
    anchor = 0;
    chain.pages.length = 0;
    expect((await scan.read('k', range, chain.readPage, id)).sort()).toEqual(['a', 'early']);
    expect(chain.pages).toEqual([[0, 99], [100, 199]]);

    // A higher anchor only narrows the range: nothing read so far is read again, and nothing is dropped.
    anchor = 120;
    chain.pages.length = 0;
    expect((await scan.read('k', range, chain.readPage, id)).sort()).toEqual(['a', 'early']);
    expect(chain.pages).toEqual([]);
  });

  it('keeps separate progress per key', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const chain = chainOf({ 110: ['a'] });
    const range = async () => ({ anchor: 100, head: 150 });
    await scan.read('one', range, chain.readPage, id);
    chain.pages.length = 0;
    await scan.read('two', range, chain.readPage, id);
    expect(chain.pages).toEqual([[100, 150]]);
  });

  it('refuses a page size or tail that is not a whole number of blocks', () => {
    expect(() => new IncrementalEventScan({ pageBlocks: 0, tailBlocks: 0 })).toThrow(RangeError);
    expect(() => new IncrementalEventScan({ pageBlocks: 10, tailBlocks: -1 })).toThrow(RangeError);
    expect(() => new IncrementalEventScan({ pageBlocks: 1.5, tailBlocks: 0 })).toThrow(RangeError);
  });
});
