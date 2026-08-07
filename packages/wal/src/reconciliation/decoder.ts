import { bytesToHex, compareBytes, copyBytes } from './bytes.js';
import {
  DEFAULT_RECONCILIATION_LIMITS,
  ReconciliationBudget,
  type ReconciliationClock,
  type ReconciliationLimits,
  type ReconciliationUsage
} from './budget.js';
import { CodingWindow } from './coding-window.js';
import type { ProtocolV1IbltReconciliationAlgorithm } from './configuration.js';
import { ReconciliationError } from './errors.js';
import { idChecksum, idMappingSeed } from './hash.js';
import { walObjectId, type ReconciliationSeed, type WalObjectId } from './ids.js';
import { prepareWalObjectIdInput, type WalObjectIdInput } from './input.js';
import { createMappingCursor, nextMappingIndex, type MappingCursor } from './mapping.js';
import {
  applyId,
  cloneSymbol,
  detectPureSymbol,
  isZeroSymbol,
  validateSymbol,
  type PureDirection,
  type ReconciliationSymbolV1
} from './symbol.js';
import { decodeReconciliationSymbolV1 } from './wire.js';

export type DecodeFailureCode =
  | 'NON_CONTIGUOUS_SYMBOL'
  | 'DUPLICATE_DECODED_ID'
  | 'DECODED_DIFFERENCE_LIMIT';

export class DecodeFailure extends ReconciliationError {
  constructor(code: DecodeFailureCode, message: string) {
    super(code, message);
    this.name = 'DecodeFailure';
  }
}

export interface PeelTraceEntry {
  symbolIndex: number;
  outcome: 'zero' | PureDirection;
  idHex?: string;
}

export type DecodeState = 'awaiting-symbols' | 'needs-more-symbols' | 'complete';

export interface DecodeSnapshot {
  state: DecodeState;
  complete: boolean;
  receivedSymbols: number;
  decodedSymbols: number;
  providerOnly: WalObjectId[];
  receiverOnly: WalObjectId[];
  peelTrace: PeelTraceEntry[];
  usage: ReconciliationUsage;
}

export interface RatelessIbltDecoderOptions extends Omit<WalObjectIdInput, 'ids'> {
  receiverIds: Iterable<WalObjectId>;
  reconciliationSeed: ReconciliationSeed;
  algorithm: ProtocolV1IbltReconciliationAlgorithm;
  limits?: Readonly<ReconciliationLimits>;
  clock?: ReconciliationClock;
}

export const ACCOUNTED_RECONCILIATION_SYMBOL_BYTES = 128;

/** @internal Exported from this module only so its invariants can be tested. */
export class MinIndexQueue {
  readonly #heap: number[] = [];
  readonly #present = new Set<number>();

  get length(): number {
    return this.#heap.length;
  }

  add(value: number): void {
    if (this.#present.has(value)) return;
    this.#present.add(value);
    this.#heap.push(value);
    let current = this.#heap.length - 1;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.#heap[parent] <= this.#heap[current]) break;
      [this.#heap[parent], this.#heap[current]] = [this.#heap[current], this.#heap[parent]];
      current = parent;
    }
  }

  take(): number {
    const minimum = this.#heap[0]!;
    const tail = this.#heap.pop()!;
    this.#present.delete(minimum);
    if (this.#heap.length === 0) return minimum;
    this.#heap[0] = tail;
    let current = 0;
    while (true) {
      const left = current * 2 + 1;
      if (left >= this.#heap.length) break;
      const right = left + 1;
      const child = right < this.#heap.length && this.#heap[right] < this.#heap[left] ? right : left;
      if (this.#heap[current] <= this.#heap[child]) break;
      [this.#heap[current], this.#heap[child]] = [this.#heap[child], this.#heap[current]];
      current = child;
    }
    return minimum;
  }
}

export class RatelessIbltDecoder {
  readonly #reconciliationSeed: ReconciliationSeed;
  readonly #mappingParameters: ProtocolV1IbltReconciliationAlgorithm['mapping'];
  readonly #budget: ReconciliationBudget;
  readonly #receiverWindow: CodingWindow;
  readonly #providerOnlyWindow: CodingWindow;
  readonly #receiverOnlyWindow: CodingWindow;
  readonly #cells: ReconciliationSymbolV1[] = [];
  readonly #queue = new MinIndexQueue();
  readonly #decodedCells = new Set<number>();
  readonly #providerOnly = new Map<string, WalObjectId>();
  readonly #receiverOnly = new Map<string, WalObjectId>();
  readonly #peelTrace: PeelTraceEntry[] = [];

  constructor(options: RatelessIbltDecoderOptions) {
    this.#reconciliationSeed = options.reconciliationSeed;
    this.#mappingParameters = options.algorithm.mapping;
    this.#budget = new ReconciliationBudget(options.limits ?? DEFAULT_RECONCILIATION_LIMITS, options.clock);
    const input = prepareWalObjectIdInput({
      ids: options.receiverIds,
      idCount: options.idCount,
      idsAreSorted: options.idsAreSorted
    });
    this.#receiverWindow = new CodingWindow(
      options.reconciliationSeed,
      options.algorithm.mapping,
      this.#budget,
      { expectedIds: input.idCount, trackDuplicateIds: false }
    );
    this.#providerOnlyWindow = new CodingWindow(options.reconciliationSeed, options.algorithm.mapping, this.#budget);
    this.#receiverOnlyWindow = new CodingWindow(options.reconciliationSeed, options.algorithm.mapping, this.#budget);
    for (const id of input.ids) this.#receiverWindow.addId(id);
  }

  get complete(): boolean {
    return this.#cells.length > 0 &&
      this.#decodedCells.size === this.#cells.length &&
      this.#cells.every(isZeroSymbol);
  }

  get receivedSymbols(): number {
    return this.#cells.length;
  }

  get decodedDifferenceSize(): number {
    return this.#providerOnly.size + this.#receiverOnly.size;
  }

  get usage(): ReconciliationUsage {
    return this.#budget.snapshot();
  }

  addProviderSymbol(providerSymbol: ReconciliationSymbolV1): DecodeSnapshot {
    validateSymbol(providerSymbol);
    const expectedIndex = this.#cells.length;
    if (providerSymbol.symbolIndex !== expectedIndex) {
      throw new DecodeFailure(
        'NON_CONTIGUOUS_SYMBOL',
        `expected provider symbol ${expectedIndex}, received ${providerSymbol.symbolIndex}`
      );
    }
    this.#budget.acceptSymbol();
    this.#budget.reserveMemory(ACCOUNTED_RECONCILIATION_SYMBOL_BYTES);
    let residual = cloneSymbol(providerSymbol);
    residual = this.#receiverWindow.applyNext(residual, -1n);
    residual = this.#providerOnlyWindow.applyNext(residual, -1n);
    residual = this.#receiverOnlyWindow.applyNext(residual, 1n);
    this.#cells.push(residual);
    this.#queueIfDecodable(expectedIndex);
    this.#peel();
    return this.snapshot();
  }

  addEncodedProviderSymbol(bytes: Uint8Array): DecodeSnapshot {
    return this.addProviderSymbol(decodeReconciliationSymbolV1(bytes));
  }

  addProviderWindow(symbols: readonly ReconciliationSymbolV1[]): DecodeSnapshot {
    for (const symbol of symbols) this.addProviderSymbol(symbol);
    return this.snapshot();
  }

  addEncodedProviderWindow(symbols: readonly Uint8Array[]): DecodeSnapshot {
    for (const symbol of symbols) this.addEncodedProviderSymbol(symbol);
    return this.snapshot();
  }

  snapshot(): DecodeSnapshot {
    const complete = this.complete;
    const state: DecodeState = this.#cells.length === 0
      ? 'awaiting-symbols'
      : complete
        ? 'complete'
        : 'needs-more-symbols';
    return {
      state,
      complete,
      receivedSymbols: this.#cells.length,
      decodedSymbols: this.#decodedCells.size,
      providerOnly: complete
        ? [...this.#providerOnly.values()].map((id) => walObjectId(id)).sort(compareBytes)
        : [],
      receiverOnly: complete
        ? [...this.#receiverOnly.values()].map((id) => walObjectId(id)).sort(compareBytes)
        : [],
      peelTrace: this.#peelTrace.map((entry) => ({ ...entry })),
      usage: this.#budget.snapshot()
    };
  }

  residualSymbols(): ReconciliationSymbolV1[] {
    return this.#cells.map(cloneSymbol);
  }

  #queueIfDecodable(index: number): void {
    const symbol = this.#cells[index];
    if (isZeroSymbol(symbol) || detectPureSymbol(symbol, this.#reconciliationSeed) !== null) {
      this.#queue.add(index);
    }
  }

  #queueIfNewlyPure(index: number): void {
    if (detectPureSymbol(this.#cells[index], this.#reconciliationSeed) !== null) this.#queue.add(index);
  }

  #peel(): void {
    while (this.#queue.length > 0) {
      this.#budget.chargeOperations();
      const symbolIndex = this.#queue.take();
      const symbol = this.#cells[symbolIndex];
      if (isZeroSymbol(symbol)) {
        this.#decodedCells.add(symbolIndex);
        this.#peelTrace.push({ symbolIndex, outcome: 'zero' });
        continue;
      }
      const pure = detectPureSymbol(symbol, this.#reconciliationSeed)!;
      const id = walObjectId(pure.id);
      const key = bytesToHex(id);
      if (this.#providerOnly.has(key) || this.#receiverOnly.has(key)) {
        throw new DecodeFailure('DUPLICATE_DECODED_ID', `decoded WalObjectId more than once: ${key}`);
      }
      this.#budget.acceptDecodedId();
      const direction = pure.direction === 'provider-only' ? -1n : 1n;
      const cursor = this.#applyDecodedId(id, direction);
      if (pure.direction === 'provider-only') {
        this.#providerOnly.set(key, id);
        this.#providerOnlyWindow.addId(id, cursor);
      } else {
        this.#receiverOnly.set(key, id);
        this.#receiverOnlyWindow.addId(id, cursor);
      }
      this.#decodedCells.add(symbolIndex);
      this.#peelTrace.push({ symbolIndex, outcome: pure.direction, idHex: key });
    }
  }

  #applyDecodedId(id: WalObjectId, direction: 1n | -1n): MappingCursor {
    const checksum = idChecksum(this.#reconciliationSeed, id);
    const cursor = createMappingCursor(idMappingSeed(this.#reconciliationSeed, id));
    while (cursor.lastIndex < this.#cells.length) {
      this.#budget.chargeOperations();
      const symbolIndex = cursor.lastIndex;
      applyId(this.#cells[symbolIndex], id, checksum, direction);
      this.#queueIfNewlyPure(symbolIndex);
      nextMappingIndex(cursor, this.#mappingParameters);
    }
    return cursor;
  }
}
