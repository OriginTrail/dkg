// SPDX-License-Identifier: Apache-2.0

import { KeyedSingleFlight } from './keyed-ttl-single-flight-cache.js';

/**
 * An event-log scan that remembers what it read, per key.
 *
 * - The first read of a key covers its range, from the anchor (such as the
 *   contract's deployment block) to the head.
 * - Each later read covers only the blocks after the last block read, plus a
 *   short tail that it reads again in case of a reorg.
 * - The scan keeps each event with its block. A page that is read again
 *   replaces the events it held before, so an event that a reorg removed
 *   drops out. An item stays listed while any event still kept names it.
 * - A head below the last block read (a reorg onto a shorter chain, or a
 *   backend that lags) drops the events above it, and those blocks are read
 *   again once the head passes them.
 * - A read that fails part-way keeps the pages it finished, and the next read
 *   goes on from there.
 * - Reads of one key that overlap share one scan (`KeyedSingleFlight`).
 */

/** How far a key's scan has read: from `anchor` through `through`. */
export interface IncrementalEventScanProgress {
  readonly anchor: number;
  readonly through: number;
}

/** One event a page held: the item it names, and the block it is in. */
export interface ScannedEvent<T> {
  readonly item: T;
  readonly block: number;
}

/** What one read covers, and how it reads a page. */
export interface IncrementalEventScanPlan<T> {
  /** The first block that can hold the events. */
  readonly anchor: number;
  /** The newest block to read up to. */
  readonly head: number;
  /** Reads one page, both bounds inclusive, and returns every event found there. */
  readonly readPage: (fromBlock: number, toBlock: number) => Promise<Iterable<ScannedEvent<T>>>;
}

export interface IncrementalEventScanOptions {
  /** Blocks per page. */
  readonly pageBlocks: number;
  /** Blocks before the last block read that a later read covers again. */
  readonly tailBlocks: number;
}

interface KeptEvent<T> extends ScannedEvent<T> {
  readonly id: string;
}

interface ScanEntry<T> {
  /** The anchor the kept progress was read from; -1 before the first read. */
  anchor: number;
  /** The last block read; below `anchor` before the first page. */
  through: number;
  /** Each event kept, by `${id}@${block}`. */
  readonly events: Map<string, KeptEvent<T>>;
}

export class IncrementalEventScan<T> {
  readonly #entries = new Map<string, ScanEntry<T>>();
  readonly #flight = new KeyedSingleFlight<string>();
  readonly #pageBlocks: number;
  readonly #tailBlocks: number;

  constructor(options: IncrementalEventScanOptions) {
    if (!Number.isSafeInteger(options.pageBlocks) || options.pageBlocks < 1) {
      throw new RangeError(`pageBlocks must be a positive integer, got ${options.pageBlocks}`);
    }
    if (!Number.isSafeInteger(options.tailBlocks) || options.tailBlocks < 0) {
      throw new RangeError(`tailBlocks must be a non-negative integer, got ${options.tailBlocks}`);
    }
    this.#pageBlocks = options.pageBlocks;
    this.#tailBlocks = options.tailBlocks;
  }

  /**
   * The items named by the events from the anchor up to the head of this read.
   *
   * @param prepare - plans this read: its anchor, its head and its page reader. It gets the key's progress
   *   once a page has been read, so it can keep that anchor and only look up the head.
   * @param idOf - names an item, so one named by several events is listed once.
   */
  read(
    key: string,
    prepare: (progress: IncrementalEventScanProgress | undefined) => Promise<IncrementalEventScanPlan<T>>,
    idOf: (item: T) => string,
  ): Promise<T[]> {
    return this.#flight.run(key, key, () => this.#scan(key, prepare, idOf));
  }

  async #scan(
    key: string,
    prepare: (progress: IncrementalEventScanProgress | undefined) => Promise<IncrementalEventScanPlan<T>>,
    idOf: (item: T) => string,
  ): Promise<T[]> {
    let scan = this.#entries.get(key);
    if (!scan) {
      scan = { anchor: -1, through: -1, events: new Map() };
      this.#entries.set(key, scan);
    }
    const progress = scan.anchor >= 0 && scan.through >= scan.anchor ? { anchor: scan.anchor, through: scan.through } : undefined;
    const { anchor, head, readPage } = await prepare(progress);
    if (scan.anchor < 0 || anchor < scan.anchor) {
      // The first read, or an anchor below the one the kept progress started at: that progress
      // does not cover the blocks in between, so read again from the new anchor.
      scan.anchor = anchor;
      scan.through = anchor - 1;
      scan.events.clear();
    } else if (anchor > scan.anchor) {
      // A later anchor narrows the range. What was read from the earlier one stays valid; the
      // events before the new anchor are outside the range now.
      scan.anchor = anchor;
      for (const [eventKey, event] of scan.events) if (event.block < anchor) scan.events.delete(eventKey);
    }
    if (head < scan.through) {
      // The head is below the last block read: drop what was kept above it, and read those blocks
      // again once the head passes them.
      for (const [eventKey, event] of scan.events) if (event.block > head) scan.events.delete(eventKey);
      scan.through = Math.max(head, scan.anchor - 1);
    }
    const from = Math.max(anchor, scan.through + 1 - this.#tailBlocks);
    for (let lo = from; lo <= head; lo += this.#pageBlocks) {
      const hi = Math.min(lo + this.#pageBlocks - 1, head);
      const found = await readPage(lo, hi);
      // The page as read now replaces what it held before, so an event a reorg removed drops out.
      for (const [eventKey, event] of scan.events) if (event.block >= lo && event.block <= hi) scan.events.delete(eventKey);
      for (const { item, block } of found) {
        const id = idOf(item);
        scan.events.set(`${id}@${block}`, { id, item, block });
      }
      if (hi > scan.through) scan.through = hi;
    }
    const items = new Map<string, T>();
    for (const { id, item } of scan.events.values()) if (!items.has(id)) items.set(id, item);
    return [...items.values()];
  }
}
