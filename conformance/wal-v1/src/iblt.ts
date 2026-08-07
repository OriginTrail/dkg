import { compareBytes, equalBytes, hash, hex, u64le, xorInto } from './bytes.js';
import { encodeCanonical } from './cbor.js';
import { DOMAINS } from './schema.js';

const U64_MASK = 0xffff_ffff_ffff_ffffn;
const MULTIPLIER = 0xda94_2042_e4dd_58b5n;
const INVERSE_SQRT_NUMERATOR = 2 ** 32;
const INDEX_OFFSET = 1.5;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export interface SymbolV1 {
  index: number;
  count: bigint;
  idXor: Uint8Array;
  checksumXor: Uint8Array;
}

export interface MappingCursor {
  state: bigint;
  index: number;
}

export interface DecodeResult {
  complete: boolean;
  providerOnly: Uint8Array[];
  receiverOnly: Uint8Array[];
  peelTrace: Array<{ index: number; direction: 'zero' | 'provider-only' | 'receiver-only'; id?: string }>;
  residual: SymbolV1[];
}

function assertId(id: Uint8Array): void {
  if (id.length !== 32) throw new Error('WalObjectId must be bytes32');
}

export function deriveReconciliationSeed(
  requesterHeadId: Uint8Array,
  providerHeadId: Uint8Array,
  requesterNonce: Uint8Array
): Uint8Array {
  assertId(requesterHeadId);
  assertId(providerHeadId);
  if (requesterNonce.length !== 32) throw new Error('requester nonce must be bytes32');
  return hash(DOMAINS.ibltSeed, requesterHeadId, providerHeadId, requesterNonce);
}

export function checksum(seed: Uint8Array, id: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new Error('reconciliation seed must be bytes32');
  assertId(id);
  return hash(DOMAINS.ibltChecksum, seed, id);
}

export function createMappingCursor(seed: Uint8Array, id: Uint8Array): MappingCursor {
  if (seed.length !== 32) throw new Error('reconciliation seed must be bytes32');
  assertId(id);
  return { state: u64le(hash(DOMAINS.ibltMap, seed, id).subarray(0, 8)), index: 0 };
}

export function advanceMapping(cursor: MappingCursor): number {
  cursor.state = (cursor.state * MULTIPLIER) & U64_MASK;
  cursor.index = mappingIndexForState(cursor.state, cursor.index);
  return cursor.index;
}

export function mappingIndexForState(state: bigint, index: number): number {
  if (state < 0n || state > U64_MASK) throw new Error('mapping state must be an unsigned 64-bit integer');
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('mapping index must be a non-negative safe integer');
  const convertedState = Number(state);
  const statePlusOne = convertedState + 1;
  const squareRoot = Math.sqrt(statePlusOne);
  const inverseSquareRoot = INVERSE_SQRT_NUMERATOR / squareRoot;
  const adjustedInverseSquareRoot = inverseSquareRoot - 1;
  const convertedIndex = Number(index);
  const shiftedIndex = convertedIndex + INDEX_OFFSET;
  const product = shiftedIndex * adjustedInverseSquareRoot;
  const distance = Math.ceil(product);
  const next = index + Math.max(1, distance);
  if (!Number.isSafeInteger(next)) throw new Error('mapping index exceeds safe integer range');
  return next;
}

export function mappingIndices(seed: Uint8Array, id: Uint8Array, lastInclusive: number): number[] {
  if (!Number.isSafeInteger(lastInclusive) || lastInclusive < 0) throw new Error('invalid last symbol index');
  const cursor = createMappingCursor(seed, id);
  const output: number[] = [];
  while (cursor.index <= lastInclusive) {
    output.push(cursor.index);
    advanceMapping(cursor);
  }
  return output;
}

function emptySymbol(index: number): SymbolV1 {
  return { index, count: 0n, idXor: new Uint8Array(32), checksumXor: new Uint8Array(32) };
}

function apply(symbol: SymbolV1, id: Uint8Array, digest: Uint8Array, direction: 1n | -1n): void {
  const count = symbol.count + direction;
  if (count < I64_MIN || count > I64_MAX) throw new Error('signed i64 symbol count overflow');
  symbol.count = count;
  xorInto(symbol.idXor, id);
  xorInto(symbol.checksumXor, digest);
}

function cloneSymbol(symbol: SymbolV1): SymbolV1 {
  return { index: symbol.index, count: symbol.count, idXor: new Uint8Array(symbol.idXor), checksumXor: new Uint8Array(symbol.checksumXor) };
}

function sortedUniqueIds(ids: readonly Uint8Array[]): Uint8Array[] {
  const sorted = ids.map((id) => {
    assertId(id);
    return new Uint8Array(id);
  }).sort(compareBytes);
  for (let index = 1; index < sorted.length; index += 1) {
    if (equalBytes(sorted[index - 1], sorted[index])) throw new Error('duplicate WalObjectId');
  }
  return sorted;
}

export function encodeSymbols(ids: readonly Uint8Array[], seed: Uint8Array, count: number): SymbolV1[] {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('symbol count must be positive');
  const symbols = Array.from({ length: count }, (_, index) => emptySymbol(index));
  for (const id of sortedUniqueIds(ids)) {
    const digest = checksum(seed, id);
    for (const index of mappingIndices(seed, id, count - 1)) apply(symbols[index], id, digest, 1n);
  }
  return symbols;
}

export function encodeSymbolCbor(symbol: SymbolV1): Uint8Array {
  if (!Number.isSafeInteger(symbol.index) || symbol.index < 0) throw new Error('invalid symbol index');
  if (symbol.count < I64_MIN || symbol.count > I64_MAX) throw new Error('symbol count out of i64 range');
  assertId(symbol.idXor);
  assertId(symbol.checksumXor);
  return encodeCanonical([BigInt(symbol.index), symbol.count, symbol.idXor, symbol.checksumXor]);
}

function subtract(provider: SymbolV1, receiver: SymbolV1): SymbolV1 {
  if (provider.index !== receiver.index) throw new Error('symbol index mismatch');
  const count = provider.count - receiver.count;
  if (count < I64_MIN || count > I64_MAX) throw new Error('signed i64 symbol count overflow');
  const result = cloneSymbol(provider);
  result.count = count;
  xorInto(result.idXor, receiver.idXor);
  xorInto(result.checksumXor, receiver.checksumXor);
  return result;
}

function pure(symbol: SymbolV1, seed: Uint8Array): 'provider-only' | 'receiver-only' | null {
  if (symbol.count !== 1n && symbol.count !== -1n) return null;
  if (!equalBytes(checksum(seed, symbol.idXor), symbol.checksumXor)) return null;
  return symbol.count === 1n ? 'provider-only' : 'receiver-only';
}

function zero(symbol: SymbolV1): boolean {
  if (symbol.count !== 0n) return false;
  return symbol.idXor.every((value) => value === 0) && symbol.checksumXor.every((value) => value === 0);
}

export function decodeDifference(
  providerSymbols: readonly SymbolV1[],
  receiverIds: readonly Uint8Array[],
  seed: Uint8Array
): DecodeResult {
  if (providerSymbols.length === 0) throw new Error('at least one symbol is required');
  for (let index = 0; index < providerSymbols.length; index += 1) {
    if (providerSymbols[index].index !== index) throw new Error('symbols must be contiguous from zero');
  }
  const receiverSymbols = encodeSymbols(receiverIds, seed, providerSymbols.length);
  const residual = providerSymbols.map((symbol, index) => subtract(symbol, receiverSymbols[index]));
  const providerOnly = new Map<string, Uint8Array>();
  const receiverOnly = new Map<string, Uint8Array>();
  const decoded = new Set<number>();
  const peelTrace: DecodeResult['peelTrace'] = [];

  while (true) {
    let selected = -1;
    let selectedDirection: 'zero' | 'provider-only' | 'receiver-only' | null = null;
    for (let index = 0; index < residual.length; index += 1) {
      if (decoded.has(index)) continue;
      if (zero(residual[index])) {
        selected = index;
        selectedDirection = 'zero';
        break;
      }
      const direction = pure(residual[index], seed);
      if (direction !== null) {
        selected = index;
        selectedDirection = direction;
        break;
      }
    }
    if (selected < 0 || selectedDirection === null) break;
    const symbol = residual[selected];
    decoded.add(selected);
    if (selectedDirection === 'zero') {
      peelTrace.push({ index: selected, direction: 'zero' });
      continue;
    }
    const id = new Uint8Array(symbol.idXor);
    const key = hex(id);
    if (providerOnly.has(key) || receiverOnly.has(key)) throw new Error('duplicate decoded ID');
    if (selectedDirection === 'provider-only') providerOnly.set(key, id);
    else receiverOnly.set(key, id);
    peelTrace.push({ index: selected, direction: selectedDirection, id: key });
    const digest = checksum(seed, id);
    const removal = selectedDirection === 'provider-only' ? -1n : 1n;
    for (const index of mappingIndices(seed, id, residual.length - 1)) apply(residual[index], id, digest, removal);
  }

  const complete = residual.every(zero);
  return {
    complete,
    providerOnly: complete ? [...providerOnly.values()].sort(compareBytes) : [],
    receiverOnly: complete ? [...receiverOnly.values()].sort(compareBytes) : [],
    peelTrace,
    residual
  };
}
