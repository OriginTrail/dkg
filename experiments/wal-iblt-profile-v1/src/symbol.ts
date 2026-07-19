import {
  WAL_OBJECT_ID_LENGTH,
  assertLength,
  copyBytes,
  equalBytes,
  isZero,
  xorInto
} from './bytes.js';
import { idChecksum } from './hash.js';

export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

export interface ReconciliationSymbolV1 {
  symbolIndex: number;
  count: bigint;
  idXor: Uint8Array;
  checksumXor: Uint8Array;
}

export type PureDirection = 'provider-only' | 'receiver-only';

export interface PureSymbol {
  direction: PureDirection;
  id: Uint8Array;
  checksum: Uint8Array;
}

export function emptySymbol(symbolIndex: number): ReconciliationSymbolV1 {
  if (!Number.isSafeInteger(symbolIndex) || symbolIndex < 0) {
    throw new RangeError('symbolIndex must be a non-negative safe integer');
  }
  return {
    symbolIndex,
    count: 0n,
    idXor: new Uint8Array(WAL_OBJECT_ID_LENGTH),
    checksumXor: new Uint8Array(32)
  };
}

export function cloneSymbol(symbol: ReconciliationSymbolV1): ReconciliationSymbolV1 {
  validateSymbol(symbol);
  return {
    symbolIndex: symbol.symbolIndex,
    count: symbol.count,
    idXor: copyBytes(symbol.idXor),
    checksumXor: copyBytes(symbol.checksumXor)
  };
}

export function validateSymbol(symbol: ReconciliationSymbolV1): void {
  if (!Number.isSafeInteger(symbol.symbolIndex) || symbol.symbolIndex < 0) {
    throw new RangeError('symbolIndex must be a non-negative safe integer');
  }
  if (typeof symbol.count !== 'bigint' || symbol.count < I64_MIN || symbol.count > I64_MAX) {
    throw new RangeError('symbol count must be a signed 64-bit integer');
  }
  assertLength(symbol.idXor, WAL_OBJECT_ID_LENGTH, 'idXor');
  assertLength(symbol.checksumXor, 32, 'checksumXor');
}

export function applyId(
  symbol: ReconciliationSymbolV1,
  id: Uint8Array,
  checksum: Uint8Array,
  direction: 1n | -1n
): void {
  assertLength(id, WAL_OBJECT_ID_LENGTH, 'walObjectId');
  assertLength(checksum, 32, 'checksum');
  const nextCount = symbol.count + direction;
  if (nextCount < I64_MIN || nextCount > I64_MAX) throw new RangeError('symbol count overflow');
  symbol.count = nextCount;
  xorInto(symbol.idXor, id);
  xorInto(symbol.checksumXor, checksum);
}

export function subtractSymbols(
  provider: ReconciliationSymbolV1,
  receiver: ReconciliationSymbolV1
): ReconciliationSymbolV1 {
  validateSymbol(provider);
  validateSymbol(receiver);
  if (provider.symbolIndex !== receiver.symbolIndex) throw new RangeError('symbol indices do not match');
  const count = provider.count - receiver.count;
  if (count < I64_MIN || count > I64_MAX) throw new RangeError('symbol count overflow');
  const output = cloneSymbol(provider);
  output.count = count;
  xorInto(output.idXor, receiver.idXor);
  xorInto(output.checksumXor, receiver.checksumXor);
  return output;
}

export function isZeroSymbol(symbol: ReconciliationSymbolV1): boolean {
  return symbol.count === 0n && isZero(symbol.idXor) && isZero(symbol.checksumXor);
}

export function detectPureSymbol(
  symbol: ReconciliationSymbolV1,
  reconciliationSeed: Uint8Array
): PureSymbol | null {
  if (symbol.count !== 1n && symbol.count !== -1n) return null;
  const checksum = idChecksum(reconciliationSeed, symbol.idXor);
  if (!equalBytes(checksum, symbol.checksumXor)) return null;
  return {
    direction: symbol.count === 1n ? 'provider-only' : 'receiver-only',
    id: copyBytes(symbol.idXor),
    checksum
  };
}
