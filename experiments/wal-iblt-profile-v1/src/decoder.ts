import { assertLength, bytesToHex, compareBytes, copyBytes } from './bytes.js';
import { CodingWindow } from './coding-window.js';
import { idChecksum, idMappingSeed } from './hash.js';
import { createMappingCursor, nextMappingIndex, type MappingCursor } from './mapping.js';
import type { MappingProfile } from './profile.js';
import {
  applyId,
  cloneSymbol,
  detectPureSymbol,
  isZeroSymbol,
  validateSymbol,
  type PureDirection,
  type ReconciliationSymbolV1
} from './symbol.js';

export type DecodeFailureCode =
  | 'NON_CONTIGUOUS_SYMBOL'
  | 'DUPLICATE_DECODED_ID'
  | 'DECODED_DIFFERENCE_LIMIT';

export class DecodeFailure extends Error {
  constructor(readonly code: DecodeFailureCode, message: string) {
    super(message);
    this.name = 'DecodeFailure';
  }
}

export interface PeelTraceEntry {
  symbolIndex: number;
  outcome: 'zero' | PureDirection;
  idHex?: string;
}

export interface DecodeSnapshot {
  complete: boolean;
  receivedSymbols: number;
  decodedSymbols: number;
  providerOnly: Uint8Array[];
  receiverOnly: Uint8Array[];
  peelTrace: PeelTraceEntry[];
}

class OrderedIndexQueue {
  readonly #values = new Set<number>();

  get length(): number {
    return this.#values.size;
  }

  add(value: number): void {
    this.#values.add(value);
  }

  take(): number {
    const value = Math.min(...this.#values);
    this.#values.delete(value);
    return value;
  }
}

export class RatelessIbltDecoder {
  readonly #reconciliationSeed: Uint8Array;
  readonly #mappingProfile: MappingProfile;
  readonly #maximumDecodedDifference: number;
  readonly #receiverWindow: CodingWindow;
  readonly #providerOnlyWindow: CodingWindow;
  readonly #receiverOnlyWindow: CodingWindow;
  readonly #cells: ReconciliationSymbolV1[] = [];
  readonly #queue = new OrderedIndexQueue();
  readonly #decodedCells = new Set<number>();
  readonly #providerOnly = new Map<string, Uint8Array>();
  readonly #receiverOnly = new Map<string, Uint8Array>();
  readonly #peelTrace: PeelTraceEntry[] = [];

  constructor(
    receiverIds: readonly Uint8Array[],
    reconciliationSeed: Uint8Array,
    mappingProfile: MappingProfile,
    maximumDecodedDifference: number
  ) {
    assertLength(reconciliationSeed, 32, 'reconciliationSeed');
    if (!Number.isSafeInteger(maximumDecodedDifference) || maximumDecodedDifference <= 0) {
      throw new RangeError('maximumDecodedDifference must be a positive safe integer');
    }
    this.#reconciliationSeed = copyBytes(reconciliationSeed);
    this.#mappingProfile = mappingProfile;
    this.#maximumDecodedDifference = maximumDecodedDifference;
    this.#receiverWindow = new CodingWindow(reconciliationSeed, mappingProfile);
    this.#providerOnlyWindow = new CodingWindow(reconciliationSeed, mappingProfile);
    this.#receiverOnlyWindow = new CodingWindow(reconciliationSeed, mappingProfile);
    for (const id of [...receiverIds].sort(compareBytes)) this.#receiverWindow.addId(id);
  }

  get complete(): boolean {
    return this.#decodedCells.size === this.#cells.length;
  }

  get receivedSymbols(): number {
    return this.#cells.length;
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
    let residual = cloneSymbol(providerSymbol);
    residual = this.#receiverWindow.applyNext(residual, -1n);
    residual = this.#providerOnlyWindow.applyNext(residual, -1n);
    residual = this.#receiverOnlyWindow.applyNext(residual, 1n);
    this.#cells.push(residual);
    this.#queueIfDecodable(expectedIndex);
    this.#peel();
    return this.snapshot();
  }

  addProviderWindow(symbols: readonly ReconciliationSymbolV1[]): DecodeSnapshot {
    for (const symbol of symbols) this.addProviderSymbol(symbol);
    return this.snapshot();
  }

  snapshot(): DecodeSnapshot {
    return {
      complete: this.complete,
      receivedSymbols: this.#cells.length,
      decodedSymbols: this.#decodedCells.size,
      providerOnly: [...this.#providerOnly.values()].map(copyBytes).sort(compareBytes),
      receiverOnly: [...this.#receiverOnly.values()].map(copyBytes).sort(compareBytes),
      peelTrace: this.#peelTrace.map((entry) => ({ ...entry }))
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
      const symbolIndex = this.#queue.take();
      const symbol = this.#cells[symbolIndex];
      if (isZeroSymbol(symbol)) {
        this.#decodedCells.add(symbolIndex);
        this.#peelTrace.push({ symbolIndex, outcome: 'zero' });
        continue;
      }
      const pure = detectPureSymbol(symbol, this.#reconciliationSeed)!;
      const key = bytesToHex(pure.id);
      if (this.#providerOnly.has(key) || this.#receiverOnly.has(key)) {
        throw new DecodeFailure('DUPLICATE_DECODED_ID', `decoded WalObjectId more than once: ${key}`);
      }
      if (this.#providerOnly.size + this.#receiverOnly.size >= this.#maximumDecodedDifference) {
        throw new DecodeFailure('DECODED_DIFFERENCE_LIMIT', 'decoded difference limit exceeded');
      }
      const direction = pure.direction === 'provider-only' ? -1n : 1n;
      const cursor = this.#applyDecodedId(pure.id, direction);
      if (pure.direction === 'provider-only') {
        this.#providerOnly.set(key, pure.id);
        this.#providerOnlyWindow.addId(pure.id, cursor);
      } else {
        this.#receiverOnly.set(key, pure.id);
        this.#receiverOnlyWindow.addId(pure.id, cursor);
      }
      this.#decodedCells.add(symbolIndex);
      this.#peelTrace.push({ symbolIndex, outcome: pure.direction, idHex: key });
    }
  }

  #applyDecodedId(id: Uint8Array, direction: 1n | -1n): MappingCursor {
    const checksum = idChecksum(this.#reconciliationSeed, id);
    const cursor = createMappingCursor(idMappingSeed(this.#reconciliationSeed, id));
    while (cursor.lastIndex < this.#cells.length) {
      const symbolIndex = cursor.lastIndex;
      applyId(this.#cells[symbolIndex], id, checksum, direction);
      this.#queueIfNewlyPure(symbolIndex);
      nextMappingIndex(cursor, this.#mappingProfile);
    }
    return cursor;
  }
}
