import { bytesToHex } from './bytes.js';
import { ReconciliationBudget } from './budget.js';
import { idChecksum, idMappingSeed } from './hash.js';
import { walObjectId, type ReconciliationSeed, type WalObjectId } from './ids.js';
import {
  advanceMappingPrngState,
  createMappingCursor,
  mappingIndexForState,
  type MappingCursor
} from './mapping.js';
import type { RatelessMappingParameters } from './configuration.js';
import { ReconciliationError } from './errors.js';
import { applyId, emptySymbol, type ReconciliationSymbolV1 } from './symbol.js';

export const ACCOUNTED_CODING_WINDOW_ID_BYTES = 128;
const ID_BYTES = 32;
const MINIMUM_CAPACITY = 4;

export interface CodingWindowOptions {
  expectedIds?: number;
  /** Only disable after prepareWalObjectIdInput has validated uniqueness. */
  trackDuplicateIds?: boolean;
}

class MappingHeap {
  #entries: Uint32Array;
  #length = 0;

  constructor(capacity: number, readonly nextIndex: (ordinal: number) => number) {
    this.#entries = new Uint32Array(capacity);
  }

  get length(): number {
    return this.#length;
  }

  peek(): number {
    return this.#entries[0];
  }

  push(ordinal: number): void {
    this.#ensureCapacity(this.#length + 1);
    this.#entries[this.#length] = ordinal;
    let current = this.#length;
    this.#length += 1;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (!this.#less(this.#entries[current], this.#entries[parent])) break;
      [this.#entries[current], this.#entries[parent]] = [this.#entries[parent], this.#entries[current]];
      current = parent;
    }
  }

  replaceHead(): void {
    let current = 0;
    while (true) {
      const left = current * 2 + 1;
      if (left >= this.#length) return;
      const right = left + 1;
      const child = right < this.#length && this.#less(this.#entries[right], this.#entries[left]) ? right : left;
      if (!this.#less(this.#entries[child], this.#entries[current])) return;
      [this.#entries[current], this.#entries[child]] = [this.#entries[child], this.#entries[current]];
      current = child;
    }
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#entries.length) return;
    const capacity = Math.max(MINIMUM_CAPACITY, this.#entries.length * 2, required);
    const expanded = new Uint32Array(capacity);
    expanded.set(this.#entries);
    this.#entries = expanded;
  }

  #less(left: number, right: number): boolean {
    const leftIndex = this.nextIndex(left);
    const rightIndex = this.nextIndex(right);
    return leftIndex < rightIndex || (leftIndex === rightIndex && left < right);
  }
}

export class CodingWindow {
  readonly #reconciliationSeed: ReconciliationSeed;
  readonly #mappingParameters: RatelessMappingParameters;
  readonly #budget: ReconciliationBudget;
  readonly #ids?: Set<string>;
  readonly #heap: MappingHeap;
  #idBytes: Uint8Array;
  #checksumBytes: Uint8Array;
  #prngStates: BigUint64Array;
  #nextIndices: Float64Array;
  #size = 0;
  #nextSymbolIndex = 0;

  constructor(
    reconciliationSeed: ReconciliationSeed,
    mappingParameters: RatelessMappingParameters,
    budget = new ReconciliationBudget(),
    options: CodingWindowOptions = {}
  ) {
    const expectedIds = options.expectedIds ?? 0;
    if (!Number.isSafeInteger(expectedIds) || expectedIds < 0 || expectedIds > 0xffff_ffff) {
      throw new ReconciliationError('INVALID_CONFIGURATION', 'expectedIds must fit an unsigned 32-bit integer');
    }
    const availableAccountedMemory = budget.limits.maximumMemoryBytes - budget.snapshot().accountedMemoryBytes;
    if (expectedIds > Math.floor(availableAccountedMemory / ACCOUNTED_CODING_WINDOW_ID_BYTES)) {
      throw new ReconciliationError('MEMORY_LIMIT', 'expectedIds exceed the reconciliation memory budget', {
        expectedIds,
        limit: budget.limits.maximumMemoryBytes
      });
    }
    this.#reconciliationSeed = reconciliationSeed;
    this.#mappingParameters = mappingParameters;
    this.#budget = budget;
    this.#ids = options.trackDuplicateIds === false ? undefined : new Set<string>();
    this.#idBytes = new Uint8Array(expectedIds * ID_BYTES);
    this.#checksumBytes = new Uint8Array(expectedIds * ID_BYTES);
    this.#prngStates = new BigUint64Array(expectedIds);
    this.#nextIndices = new Float64Array(expectedIds);
    this.#heap = new MappingHeap(expectedIds, (ordinal) => this.#nextIndices[ordinal]);
  }

  get size(): number {
    return this.#size;
  }

  get nextSymbolIndex(): number {
    return this.#nextSymbolIndex;
  }

  addId(id: WalObjectId, cursor?: MappingCursor): void {
    const key = this.#ids === undefined ? undefined : bytesToHex(id);
    if (key !== undefined && this.#ids!.has(key)) {
      throw new ReconciliationError('DUPLICATE_WAL_OBJECT_ID', `duplicate WalObjectId: ${key}`);
    }
    this.#budget.reserveMemory(ACCOUNTED_CODING_WINDOW_ID_BYTES);
    this.#ensureCapacity(this.#size + 1);
    const offset = this.#size * ID_BYTES;
    const copiedId = walObjectId(id);
    this.#idBytes.set(copiedId, offset);
    this.#checksumBytes.set(idChecksum(this.#reconciliationSeed, copiedId), offset);
    const entryCursor = cursor ?? createMappingCursor(idMappingSeed(this.#reconciliationSeed, copiedId));
    this.#prngStates[this.#size] = entryCursor.prngState;
    this.#nextIndices[this.#size] = entryCursor.lastIndex;
    if (key !== undefined) this.#ids!.add(key);
    this.#heap.push(this.#size);
    this.#size += 1;
  }

  applyNext(symbol: ReconciliationSymbolV1, direction: 1n | -1n): ReconciliationSymbolV1 {
    if (symbol.symbolIndex !== this.#nextSymbolIndex) {
      throw new ReconciliationError(
        'NON_CONTIGUOUS_SYMBOL',
        `expected symbol ${this.#nextSymbolIndex}, received ${symbol.symbolIndex}`
      );
    }
    while (this.#heap.length > 0 && this.#nextIndices[this.#heap.peek()] === this.#nextSymbolIndex) {
      this.#budget.chargeOperations();
      const ordinal = this.#heap.peek();
      const offset = ordinal * ID_BYTES;
      const id = this.#idBytes.subarray(offset, offset + ID_BYTES) as WalObjectId;
      const checksum = this.#checksumBytes.subarray(offset, offset + ID_BYTES);
      applyId(symbol, id, checksum, direction);
      const state = advanceMappingPrngState(this.#prngStates[ordinal], this.#mappingParameters.multiplier);
      this.#prngStates[ordinal] = state;
      this.#nextIndices[ordinal] = mappingIndexForState(
        state,
        this.#nextIndices[ordinal],
        this.#mappingParameters
      );
      this.#heap.replaceHead();
    }
    this.#nextSymbolIndex += 1;
    return symbol;
  }

  produceNext(): ReconciliationSymbolV1 {
    return this.applyNext(emptySymbol(this.#nextSymbolIndex), 1n);
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#prngStates.length) return;
    const capacity = Math.max(MINIMUM_CAPACITY, this.#prngStates.length * 2, required);
    const idBytes = new Uint8Array(capacity * ID_BYTES);
    idBytes.set(this.#idBytes);
    this.#idBytes = idBytes;
    const checksumBytes = new Uint8Array(capacity * ID_BYTES);
    checksumBytes.set(this.#checksumBytes);
    this.#checksumBytes = checksumBytes;
    const prngStates = new BigUint64Array(capacity);
    prngStates.set(this.#prngStates);
    this.#prngStates = prngStates;
    const nextIndices = new Float64Array(capacity);
    nextIndices.set(this.#nextIndices);
    this.#nextIndices = nextIndices;
  }
}
