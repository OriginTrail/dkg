/**
 * Bounded-cost BPE merge core shared by the `hf-bpe-v1` and
 * `tiktoken-o200k-v1` count engines (internal; not exported from the package
 * root).
 *
 * The fork's merge loops rescan and rebuild the whole symbol array on every
 * merge, which is O(n²) per pre-tokenized piece: one long `\p{L}+` run (2 MB
 * of concatenated words) blocks the event loop for minutes. This core is the
 * HF-tokenizers / tiktoken "large piece" algorithm instead: a doubly-linked
 * symbol list plus a min-heap keyed `(rank, leftmost position)` with lazy
 * invalidation, O(n log n) per piece.
 *
 * Equivalence with the fork loops (pinned by a differential test against the
 * verbatim loops kept in `test/oracle-bpe.ts`):
 *   - tiktoken (merge the leftmost lowest-rank pair, one at a time): identical
 *     for every rank file — the heap always holds every adjacent pair with its
 *     current key, and stale entries are skipped.
 *   - HF (merge every occurrence of the lowest-rank pair per pass): identical
 *     for BPE-consistent merge lists, where a merge involving a merged symbol
 *     always ranks after the merge that created it.
 * Both seats run this code, so for every pin it IS the count definition.
 */

/**
 * Resolve the merge of two adjacent symbol ids: a non-negative merge index
 * (into the engine's rank/result tables) or -1 when the pair never merges.
 */
export type PairLookup = (left: number, right: number) => number;

export interface MergeTables {
  /** Merge index → priority (lower merges first). */
  readonly rankOf: ArrayLike<number>;
  /** Merge index → symbol id of the merged symbol. */
  readonly resultOf: ArrayLike<number>;
}

/**
 * Reusable per-call scratch. One `encodeCount` call allocates one of these
 * and grows it to the largest piece it meets, so a single huge piece costs
 * linear memory and nothing is retained across calls.
 */
export class BpeScratch {
  sym = new Int32Array(0);
  prev = new Int32Array(0);
  next = new Int32Array(0);
  alive = new Uint8Array(0);
  heapRank = new Float64Array(0);
  heapPos = new Int32Array(0);
  heapSize = 0;

  ensure(symbols: number): void {
    if (this.sym.length >= symbols) return;
    let capacity = Math.max(16, this.sym.length);
    while (capacity < symbols) capacity *= 2;
    this.sym = new Int32Array(capacity);
    this.prev = new Int32Array(capacity);
    this.next = new Int32Array(capacity);
    this.alive = new Uint8Array(capacity);
  }

  #growHeap(): void {
    const capacity = Math.max(16, this.heapRank.length * 2);
    const rank = new Float64Array(capacity);
    const pos = new Int32Array(capacity);
    rank.set(this.heapRank.subarray(0, this.heapSize));
    pos.set(this.heapPos.subarray(0, this.heapSize));
    this.heapRank = rank;
    this.heapPos = pos;
  }

  #less(i: number, j: number): boolean {
    const ri = this.heapRank[i];
    const rj = this.heapRank[j];
    return ri < rj || (ri === rj && this.heapPos[i] < this.heapPos[j]);
  }

  #swap(i: number, j: number): void {
    const rank = this.heapRank[i];
    const pos = this.heapPos[i];
    this.heapRank[i] = this.heapRank[j];
    this.heapPos[i] = this.heapPos[j];
    this.heapRank[j] = rank;
    this.heapPos[j] = pos;
  }

  push(rank: number, pos: number): void {
    if (this.heapSize === this.heapRank.length) this.#growHeap();
    let i = this.heapSize++;
    this.heapRank[i] = rank;
    this.heapPos[i] = pos;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.#less(i, parent)) break;
      this.#swap(i, parent);
      i = parent;
    }
  }

  /** Remove the minimum entry; the caller reads it first from index 0. */
  popMin(): void {
    const last = --this.heapSize;
    if (last === 0) return;
    this.heapRank[0] = this.heapRank[last];
    this.heapPos[0] = this.heapPos[last];
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= last) break;
      const right = left + 1;
      const child = right < last && this.#less(right, left) ? right : left;
      if (!this.#less(child, i)) break;
      this.#swap(child, i);
      i = child;
    }
  }
}

/**
 * Merge the `length` symbol ids already written to `scratch.sym[0..length)`
 * and return the final symbol count. Symbol id -1 marks a symbol that takes
 * part in no merge (it still counts as one symbol).
 */
export function mergeCount(scratch: BpeScratch, length: number, lookup: PairLookup, tables: MergeTables): number {
  if (length <= 1) return length;
  const { sym, prev, next, alive } = scratch;
  scratch.heapSize = 0;
  for (let i = 0; i < length; i++) {
    prev[i] = i - 1;
    next[i] = i + 1 < length ? i + 1 : -1;
    alive[i] = 1;
  }
  for (let i = 0; i + 1 < length; i++) {
    const merge = sym[i] < 0 || sym[i + 1] < 0 ? -1 : lookup(sym[i], sym[i + 1]);
    if (merge >= 0) scratch.push(tables.rankOf[merge], i);
  }
  let count = length;
  while (scratch.heapSize > 0) {
    const rank = scratch.heapRank[0];
    const left = scratch.heapPos[0];
    scratch.popMin();
    if (alive[left] === 0) continue;
    const right = next[left];
    if (right < 0 || sym[left] < 0 || sym[right] < 0) continue;
    // Lazy invalidation: the entry is live iff the pair now at `left` still
    // merges at exactly this rank (a changed neighbour or symbol re-resolves).
    const merge = lookup(sym[left], sym[right]);
    if (merge < 0 || tables.rankOf[merge] !== rank) continue;
    sym[left] = tables.resultOf[merge];
    alive[right] = 0;
    const after = next[right];
    next[left] = after;
    if (after >= 0) prev[after] = left;
    count--;
    const before = prev[left];
    if (before >= 0 && sym[before] >= 0) {
      const leftMerge = lookup(sym[before], sym[left]);
      if (leftMerge >= 0) scratch.push(tables.rankOf[leftMerge], before);
    }
    if (after >= 0 && sym[after] >= 0) {
      const rightMerge = lookup(sym[left], sym[after]);
      if (rightMerge >= 0) scratch.push(tables.rankOf[rightMerge], left);
    }
  }
  return count;
}
