// SPDX-License-Identifier: Apache-2.0

/**
 * An event-log scan that remembers what it read, per key.
 *
 * - The first read of a key covers its range from the anchor (such as the
 *   contract's deployment block) to the head.
 * - Each later read covers only the blocks after the last block read, plus a
 *   short tail that it reads again in case of a reorg.
 * - What a read finds is kept. A read that fails part-way keeps the pages it
 *   finished, and the next read goes on from there.
 * - Reads of one key that overlap share one scan.
 *
 * A later read never drops an item an earlier read found: the scan only adds.
 */

export interface IncrementalEventScanRange {
  /** The first block that can hold the events. */
  readonly anchor: number;
  /** The newest block to read up to. */
  readonly head: number;
}

export interface IncrementalEventScanOptions {
  /** Blocks per page. */
  readonly pageBlocks: number;
  /** Blocks before the last block read that a later read covers again. */
  readonly tailBlocks: number;
}

interface ScanEntry<T> {
  /** The anchor the kept progress was read from; -1 before the first read. */
  anchor: number;
  /** The last block read; below `anchor` before the first page. */
  through: number;
  readonly found: Map<string, T>;
  running?: Promise<T[]>;
}

export class IncrementalEventScan<T> {
  readonly #entries = new Map<string, ScanEntry<T>>();
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
   * Everything found for `key` from the anchor up to the head that `range` resolves.
   *
   * @param range - resolves the anchor and the head for this read.
   * @param readPage - reads one page, both bounds inclusive, and returns what it found there.
   * @param idOf - names an item, so one found twice is kept once.
   */
  read(
    key: string,
    range: () => Promise<IncrementalEventScanRange>,
    readPage: (fromBlock: number, toBlock: number) => Promise<Iterable<T>>,
    idOf: (item: T) => string,
  ): Promise<T[]> {
    let entry = this.#entries.get(key);
    if (entry?.running) return entry.running;
    if (!entry) {
      entry = { anchor: -1, through: -1, found: new Map() };
      this.#entries.set(key, entry);
    }
    const scan = entry;
    const running = (async () => {
      const { anchor, head } = await range();
      if (scan.anchor < 0 || anchor < scan.anchor) {
        // The first read, or an anchor below the one the kept progress started at: that progress
        // does not cover the blocks in between, so read again from the new anchor.
        scan.anchor = anchor;
        scan.through = anchor - 1;
        scan.found.clear();
      } else if (anchor > scan.anchor) {
        // A later anchor narrows the range. What was read from the earlier one stays valid.
        scan.anchor = anchor;
      }
      const from = Math.max(anchor, scan.through + 1 - this.#tailBlocks);
      for (let lo = from; lo <= head; lo += this.#pageBlocks) {
        const hi = Math.min(lo + this.#pageBlocks - 1, head);
        for (const item of await readPage(lo, hi)) scan.found.set(idOf(item), item);
        if (hi > scan.through) scan.through = hi;
      }
      return [...scan.found.values()];
    })();
    scan.running = running;
    const settle = (): void => {
      if (scan.running === running) scan.running = undefined;
    };
    running.then(settle, settle);
    return running;
  }
}
