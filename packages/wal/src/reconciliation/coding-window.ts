import { bytesToHex } from './bytes.js';
import { ReconciliationBudget } from './budget.js';
import { idChecksum, idMappingSeed } from './hash.js';
import { walObjectId, type ReconciliationSeed, type WalObjectId } from './ids.js';
import { createMappingCursor, nextMappingIndex, type MappingCursor } from './mapping.js';
import type { RatelessMappingParameters } from './configuration.js';
import { ReconciliationError } from './errors.js';
import { applyId, emptySymbol, type ReconciliationSymbolV1 } from './symbol.js';

interface WindowEntry {
  id: WalObjectId;
  checksum: Uint8Array;
  cursor: MappingCursor;
  nextIndex: number;
  ordinal: number;
}

export const ACCOUNTED_CODING_WINDOW_ID_BYTES = 128;

class MappingHeap {
  readonly #entries: WindowEntry[] = [];

  get length(): number {
    return this.#entries.length;
  }

  peek(): WindowEntry {
    return this.#entries[0]!;
  }

  push(value: WindowEntry): void {
    this.#entries.push(value);
    let current = this.#entries.length - 1;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (!this.#less(this.#entries[current], this.#entries[parent])) break;
      [this.#entries[current], this.#entries[parent]] = [this.#entries[parent], this.#entries[current]];
      current = parent;
    }
  }

  replaceHead(value: WindowEntry): void {
    this.#entries[0] = value;
    let current = 0;
    while (true) {
      const left = current * 2 + 1;
      if (left >= this.#entries.length) return;
      const right = left + 1;
      const child = right < this.#entries.length && this.#less(this.#entries[right], this.#entries[left]) ? right : left;
      if (!this.#less(this.#entries[child], this.#entries[current])) return;
      [this.#entries[current], this.#entries[child]] = [this.#entries[child], this.#entries[current]];
      current = child;
    }
  }

  #less(left: WindowEntry, right: WindowEntry): boolean {
    return left.nextIndex < right.nextIndex || (left.nextIndex === right.nextIndex && left.ordinal < right.ordinal);
  }
}

export class CodingWindow {
  readonly #reconciliationSeed: ReconciliationSeed;
  readonly #mappingParameters: RatelessMappingParameters;
  readonly #budget: ReconciliationBudget;
  readonly #heap = new MappingHeap();
  readonly #ids = new Set<string>();
  #nextSymbolIndex = 0;
  #nextOrdinal = 0;

  constructor(
    reconciliationSeed: ReconciliationSeed,
    mappingParameters: RatelessMappingParameters,
    budget = new ReconciliationBudget()
  ) {
    this.#reconciliationSeed = reconciliationSeed;
    this.#mappingParameters = mappingParameters;
    this.#budget = budget;
  }

  get size(): number {
    return this.#ids.size;
  }

  get nextSymbolIndex(): number {
    return this.#nextSymbolIndex;
  }

  addId(id: WalObjectId, cursor?: MappingCursor): void {
    const key = bytesToHex(id);
    if (this.#ids.has(key)) {
      throw new ReconciliationError('DUPLICATE_WAL_OBJECT_ID', `duplicate WalObjectId: ${key}`);
    }
    this.#budget.reserveMemory(ACCOUNTED_CODING_WINDOW_ID_BYTES);
    this.#ids.add(key);
    const entryCursor = cursor ?? createMappingCursor(idMappingSeed(this.#reconciliationSeed, id));
    this.#heap.push({
      id: walObjectId(id),
      checksum: idChecksum(this.#reconciliationSeed, id),
      cursor: entryCursor,
      nextIndex: entryCursor.lastIndex,
      ordinal: this.#nextOrdinal
    });
    this.#nextOrdinal += 1;
  }

  applyNext(symbol: ReconciliationSymbolV1, direction: 1n | -1n): ReconciliationSymbolV1 {
    if (symbol.symbolIndex !== this.#nextSymbolIndex) {
      throw new ReconciliationError(
        'NON_CONTIGUOUS_SYMBOL',
        `expected symbol ${this.#nextSymbolIndex}, received ${symbol.symbolIndex}`
      );
    }
    while (this.#heap.length > 0 && this.#heap.peek().nextIndex === this.#nextSymbolIndex) {
      this.#budget.chargeOperations();
      const entry = this.#heap.peek();
      applyId(symbol, entry.id, entry.checksum, direction);
      entry.nextIndex = nextMappingIndex(entry.cursor, this.#mappingParameters);
      this.#heap.replaceHead(entry);
    }
    this.#nextSymbolIndex += 1;
    return symbol;
  }

  produceNext(): ReconciliationSymbolV1 {
    return this.applyNext(emptySymbol(this.#nextSymbolIndex), 1n);
  }
}
