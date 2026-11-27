/**
 * Unit tests for IncrementalEventScan:
 * - a repeat read covers only the blocks since the last one, plus a reorg tail;
 * - a page read again replaces the events it held, so a reorged-away event drops out;
 * - a head that moves back drops the events above it and reads those blocks again later;
 * - reads that overlap share one scan;
 * - a scan that fails part-way keeps the pages it finished;
 * - a change of anchor neither drops nor misses events.
 */
import { describe, expect, it } from 'vitest';
import {
  IncrementalEventScan,
  type IncrementalEventScanProgress,
  type ScannedEvent,
} from '../src/incremental-event-scan.js';

type Page = [number, number];
type Range = { anchor: number; head: number };
type ReadPage = (lo: number, hi: number) => Promise<ScannedEvent<string>[]>;

/** A fake chain: `events` maps a block to the ids logged there; edit it to simulate new blocks or a reorg. */
function chainOf(events: Record<number, string[]>) {
  const pages: Page[] = [];
  const readPage: ReadPage = async (lo, hi) => {
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

/** One read: its range from `range`, its pages from `readPage`. */
function read(
  scan: IncrementalEventScan<string>,
  key: string,
  range: (progress: IncrementalEventScanProgress | undefined) => Promise<Range>,
  readPage: ReadPage,
): Promise<string[]> {
  return scan.read(key, async (progress) => ({ ...(await range(progress)), readPage }), id);
}

describe('IncrementalEventScan', () => {
  it('reads the whole range once, then only the blocks since the last read and the reorg tail', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 10 });
    const chain = chainOf({ 105: ['a'], 230: ['b'] });
    let head = 250;
    const range = async () => ({ anchor: 100, head });

    expect(sorted(await read(scan, 'k', range, chain.readPage))).toEqual(['a', 'b']);
    expect(chain.pages).toEqual([[100, 199], [200, 250]]);

    chain.pages.length = 0;
    head = 300;
    expect(sorted(await read(scan, 'k', range, chain.readPage))).toEqual(['a', 'b']);
    // From the last block read (250), less the 10-block tail.
    expect(chain.pages).toEqual([[241, 300]]);

    chain.pages.length = 0;
    expect(sorted(await read(scan, 'k', range, chain.readPage))).toEqual(['a', 'b']);
    expect(chain.pages).toEqual([[291, 300]]);
  });

  it('finds an item logged in a later block', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const events: Record<number, string[]> = { 120: ['a'] };
    const chain = chainOf(events);
    let head = 150;
    const range = async () => ({ anchor: 100, head });
    expect(await read(scan, 'k', range, chain.readPage)).toEqual(['a']);
    events[160] = ['b'];
    head = 170;
    expect(sorted(await read(scan, 'k', range, chain.readPage))).toEqual(['a', 'b']);
  });

  it('drops an item whose only event a reorg removed from the tail, and keeps one an earlier event still names', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 50 });
    // Block 100 is outside the 50-block tail of a read through 150, so it is not read again.
    const events: Record<number, string[]> = { 100: ['early'], 149: ['early', 'orphan'] };
    const chain = chainOf(events);
    const range = async () => ({ anchor: 100, head: 150 });
    expect(sorted(await read(scan, 'k', range, chain.readPage))).toEqual(['early', 'orphan']);

    // A reorg replaces block 149 with one that holds neither event.
    delete events[149];
    chain.pages.length = 0;
    expect(await read(scan, 'k', range, chain.readPage)).toEqual(['early']);
    expect(chain.pages).toEqual([[101, 150]]);
  });

  it('drops the events above a head that moved back, and reads those blocks again once the head passes them', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 50 });
    const events: Record<number, string[]> = { 100: ['early'], 149: ['orphan'] };
    const chain = chainOf(events);
    let head = 150;
    const range = async () => ({ anchor: 100, head });
    expect(sorted(await read(scan, 'k', range, chain.readPage))).toEqual(['early', 'orphan']);

    // A reorg onto a shorter chain without the event at 149: the head is now 145.
    delete events[149];
    head = 145;
    chain.pages.length = 0;
    expect(await read(scan, 'k', range, chain.readPage)).toEqual(['early']);
    // From the new head less the tail: the blocks up to it are read again, and nothing above it.
    expect(chain.pages).toEqual([[100, 145]]);

    // The new chain grows past the old head, with an event of its own at 155.
    events[155] = ['b'];
    head = 160;
    chain.pages.length = 0;
    expect(sorted(await read(scan, 'k', range, chain.readPage))).toEqual(['b', 'early']);
    expect(chain.pages).toEqual([[100, 160]]);
  });

  it('keeps an item named by an event read twice once', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 50 });
    const chain = chainOf({ 140: ['a'] });
    const range = async () => ({ anchor: 100, head: 150 });
    expect(await read(scan, 'k', range, chain.readPage)).toEqual(['a']);
    // The tail read covers block 140 again.
    expect(await read(scan, 'k', range, chain.readPage)).toEqual(['a']);
  });

  it('shares one scan between reads that overlap', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const chain = chainOf({ 110: ['a'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let prepared = 0;
    const range = async () => { prepared += 1; await gate; return { anchor: 100, head: 299 }; };
    const first = read(scan, 'k', range, chain.readPage);
    const second = read(scan, 'k', range, chain.readPage);
    release();
    expect(await first).toEqual(['a']);
    expect(await second).toEqual(['a']);
    // One plan, and each page read once.
    expect(prepared).toBe(1);
    expect(chain.pages).toEqual([[100, 199], [200, 299]]);
  });

  it('keeps the pages a failed read finished, and goes on from there', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const chain = chainOf({ 150: ['a'], 250: ['b'] });
    let failAt: number | undefined = 200;
    const readPage: ReadPage = async (lo, hi) => {
      if (lo === failAt) throw new Error('rate limited');
      return chain.readPage(lo, hi);
    };
    const range = async () => ({ anchor: 100, head: 299 });
    await expect(read(scan, 'k', range, readPage)).rejects.toThrow('rate limited');
    expect(chain.pages).toEqual([[100, 199]]);

    failAt = undefined;
    chain.pages.length = 0;
    expect(sorted(await read(scan, 'k', range, readPage))).toEqual(['a', 'b']);
    expect(chain.pages).toEqual([[200, 299]]);
  });

  it('starts a new read after a failure instead of sharing the failed one', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    let fail = true;
    const range = async () => {
      if (fail) throw new Error('no backend');
      return { anchor: 100, head: 120 };
    };
    const readPage: ReadPage = async () => [{ item: 'a', block: 110 }];
    await expect(read(scan, 'k', range, readPage)).rejects.toThrow('no backend');
    fail = false;
    expect(await read(scan, 'k', range, readPage)).toEqual(['a']);
  });

  it('reads again from a lower anchor, and keeps its progress for a higher one', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const chain = chainOf({ 50: ['early'], 150: ['a'] });
    let anchor = 100;
    const range = async () => ({ anchor, head: 199 });
    expect(await read(scan, 'k', range, chain.readPage)).toEqual(['a']);

    // An anchor below the one the progress started at: the blocks in between were never read.
    anchor = 0;
    chain.pages.length = 0;
    expect(sorted(await read(scan, 'k', range, chain.readPage))).toEqual(['a', 'early']);
    expect(chain.pages).toEqual([[0, 99], [100, 199]]);

    // A higher anchor only narrows the range: nothing is read again, and events before it fall outside.
    anchor = 120;
    chain.pages.length = 0;
    expect(await read(scan, 'k', range, chain.readPage)).toEqual(['a']);
    expect(chain.pages).toEqual([]);
  });

  it('gives the plan the progress once a page is read, and none before', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const seen: Array<IncrementalEventScanProgress | undefined> = [];
    let failFirstPage = true;
    const range = async (progress: IncrementalEventScanProgress | undefined) => { seen.push(progress); return { anchor: 100, head: 150 }; };
    const readPage: ReadPage = async () => {
      if (failFirstPage) { failFirstPage = false; throw new Error('rate limited'); }
      return [];
    };
    await expect(read(scan, 'k', range, readPage)).rejects.toThrow('rate limited');
    await read(scan, 'k', range, readPage);
    await read(scan, 'k', range, readPage);
    // Nothing was read before the first failure, so the second read gets no progress either.
    expect(seen).toEqual([undefined, undefined, { anchor: 100, through: 150 }]);
  });

  it('keeps separate progress per key', async () => {
    const scan = new IncrementalEventScan<string>({ pageBlocks: 100, tailBlocks: 0 });
    const chain = chainOf({ 110: ['a'] });
    const range = async () => ({ anchor: 100, head: 150 });
    await read(scan, 'one', range, chain.readPage);
    chain.pages.length = 0;
    await read(scan, 'two', range, chain.readPage);
    expect(chain.pages).toEqual([[100, 150]]);
  });

  it('refuses a page size or tail that is not a whole number of blocks', () => {
    expect(() => new IncrementalEventScan({ pageBlocks: 0, tailBlocks: 0 })).toThrow(RangeError);
    expect(() => new IncrementalEventScan({ pageBlocks: 10, tailBlocks: -1 })).toThrow(RangeError);
    expect(() => new IncrementalEventScan({ pageBlocks: 1.5, tailBlocks: 0 })).toThrow(RangeError);
  });
});
