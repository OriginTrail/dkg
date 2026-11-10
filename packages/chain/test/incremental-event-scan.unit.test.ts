/**
 * Unit tests for IncrementalEventScan:
 * - a repeat read covers only the blocks since the last one, plus a reorg tail;
 * - a page read again replaces the events it held, so a reorged-away event drops out;
 * - reads that overlap share one scan;
 * - a scan that fails part-way keeps the pages it finished;
 * - a change of anchor neither drops nor misses events.
 */
import { describe, expect, it } from 'vitest';
import { IncrementalEventScan, type ScannedEvent } from '../src/incremental-event-scan.js';

type Page = [number, number];

/** A fake chain: `events` maps a block to the ids logged there; edit it to simulate new blocks or a reorg. */
function chainOf(events: Record<number, string[]>) {
  const pages: Page[] = [];
  const readPage = async (lo: number, hi: number): Promise<ScannedEvent<string>[]> => {
    pages.push([lo, hi]);
    const found: ScannedEvent<string>[] = [];
    for (const [block, ids] of Object.entries(events)) {
      if (Number(block) >= lo && Number(block) <= hi) for (const item of ids) found.push({ item, block: Number(block) });
    }
    return found;
  };
  return { pages, readPage };
}

const id = (item: string): string => item;
const sorted = (items: string[]): string[] => [...items].sort();

describe('IncrementalEventScan', () => {
  it('reads the whole range once, then only the blocks since the last read and the reorg tail', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 10 });
    const chain = chainOf({ 105: ['a'], 230: ['b'] });
    let head = 250;
    const range = async () => ({ anchor: 100, head });

    expect(sorted(await scan.read('k', range, chain.readPage, id))).toEqual(['a', 'b']);
    expect(chain.pages).toEqual([[100, 199], [200, 250]]);

    chain.pages.length = 0;
    head = 300;
    expect(sorted(await scan.read('k', range, chain.readPage, id))).toEqual(['a', 'b']);
    // From the last block read (250), less the 10-block tail.
    expect(chain.pages).toEqual([[241, 300]]);

    chain.pages.length = 0;
    expect(sorted(await scan.read('k', range, chain.readPage, id))).toEqual(['a', 'b']);
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
    expect(sorted(await scan.read('k', range, chain.readPage, id))).toEqual(['a', 'b']);
  });

  it('drops an item whose only event a reorg removed from the tail, and keeps one an earlier event still names', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 50 });
    // Block 100 is outside the 50-block tail of a read through 150, so it is not read again.
    const events: Record<number, string[]> = { 100: ['early'], 149: ['early', 'orphan'] };
    const chain = chainOf(events);
    const range = async () => ({ anchor: 100, head: 150 });
    expect(sorted(await scan.read('k', range, chain.readPage, id))).toEqual(['early', 'orphan']);

    // A reorg replaces block 149 with one that holds neither event.
    delete events[149];
    chain.pages.length = 0;
    expect(await scan.read('k', range, chain.readPage, id)).toEqual(['early']);
    expect(chain.pages).toEqual([[101, 150]]);
  });

  it('keeps an item named by an event read twice once', async () => {
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
    expect(sorted(await scan.read('k', range, readPage, id))).toEqual(['a', 'b']);
    expect(chain.pages).toEqual([[200, 299]]);
  });

  it('starts a new read after a failure instead of sharing the failed one', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    let fail = true;
    const range = async () => {
      if (fail) throw new Error('no backend');
      return { anchor: 100, head: 120 };
    };
    const readPage = async () => [{ item: 'a', block: 110 }];
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
    expect(sorted(await scan.read('k', range, chain.readPage, id))).toEqual(['a', 'early']);
    expect(chain.pages).toEqual([[0, 99], [100, 199]]);

    // A higher anchor only narrows the range: nothing is read again, and events before it fall outside.
    anchor = 120;
    chain.pages.length = 0;
    expect(await scan.read('k', range, chain.readPage, id)).toEqual(['a']);
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
