import { concatBytes } from './bytes.js';
import { I64_MAX, I64_MIN, validateSymbol, type ReconciliationSymbolV1 } from './symbol.js';
import { ReconciliationError, type ReconciliationErrorCode } from './errors.js';

export type SymbolWireErrorCode =
  | 'MALFORMED_SYMBOL'
  | 'NON_CANONICAL_SYMBOL'
  | 'INTEGER_OUT_OF_RANGE'
  | 'TRAILING_BYTES';

export class SymbolWireError extends ReconciliationError {
  constructor(code: SymbolWireErrorCode, message: string) {
    super(code as ReconciliationErrorCode, message);
    this.name = 'SymbolWireError';
  }
}

function encodeMajor(major: number, value: bigint): Uint8Array {
  if (value < 24n) return Uint8Array.of((major << 5) | Number(value));
  if (value <= 0xffn) return Uint8Array.of((major << 5) | 24, Number(value));
  if (value <= 0xffffn) {
    const output = new Uint8Array(3);
    output[0] = (major << 5) | 25;
    new DataView(output.buffer).setUint16(1, Number(value), false);
    return output;
  }
  if (value <= 0xffff_ffffn) {
    const output = new Uint8Array(5);
    output[0] = (major << 5) | 26;
    new DataView(output.buffer).setUint32(1, Number(value), false);
    return output;
  }
  const output = new Uint8Array(9);
  output[0] = (major << 5) | 27;
  new DataView(output.buffer).setBigUint64(1, value, false);
  return output;
}

function encodeInteger(value: bigint): Uint8Array {
  return value >= 0n ? encodeMajor(0, value) : encodeMajor(1, -1n - value);
}

export function encodeReconciliationSymbolV1(symbol: ReconciliationSymbolV1): Uint8Array {
  validateSymbol(symbol);
  return concatBytes(
    Uint8Array.of(0x84),
    encodeInteger(BigInt(symbol.symbolIndex)),
    encodeInteger(symbol.count),
    Uint8Array.of(0x58, 0x20),
    symbol.idXor,
    Uint8Array.of(0x58, 0x20),
    symbol.checksumXor
  );
}

class Reader {
  #offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.#offset;
  }

  byte(): number {
    if (this.remaining < 1) throw new SymbolWireError('MALFORMED_SYMBOL', 'truncated CBOR value');
    return this.bytes[this.#offset++];
  }

  exact(length: number): Uint8Array {
    if (this.remaining < length) throw new SymbolWireError('MALFORMED_SYMBOL', 'truncated CBOR byte string');
    const output = this.bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return output;
  }

  unsigned(additional: number): bigint {
    if (additional < 24) return BigInt(additional);
    const lengths = new Map([[24, 1], [25, 2], [26, 4], [27, 8]]);
    const length = lengths.get(additional);
    if (length === undefined) throw new SymbolWireError('MALFORMED_SYMBOL', 'indefinite or reserved CBOR integer');
    const encoded = this.exact(length);
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const value = length === 1
      ? BigInt(encoded[0])
      : length === 2
        ? BigInt(view.getUint16(0, false))
        : length === 4
          ? BigInt(view.getUint32(0, false))
          : view.getBigUint64(0, false);
    const minimum = length === 1 ? 24n : length === 2 ? 0x100n : length === 4 ? 0x1_0000n : 0x1_0000_0000n;
    if (value < minimum) throw new SymbolWireError('NON_CANONICAL_SYMBOL', 'CBOR integer is not shortest-form');
    return value;
  }

  integer(): bigint {
    const head = this.byte();
    const major = head >>> 5;
    const value = this.unsigned(head & 0x1f);
    if (major === 0) return value;
    if (major === 1) return -1n - value;
    throw new SymbolWireError('MALFORMED_SYMBOL', 'expected a CBOR integer');
  }

  bytes32(): Uint8Array {
    const head = this.byte();
    if (head >>> 5 !== 2) throw new SymbolWireError('MALFORMED_SYMBOL', 'expected a CBOR byte string');
    const length = this.unsigned(head & 0x1f);
    if (length !== 32n) throw new SymbolWireError('MALFORMED_SYMBOL', 'symbol byte strings must be exactly 32 bytes');
    return this.exact(32);
  }
}

export function decodeReconciliationSymbolV1(bytes: Uint8Array): ReconciliationSymbolV1 {
  const reader = new Reader(bytes);
  if (reader.byte() !== 0x84) throw new SymbolWireError('MALFORMED_SYMBOL', 'symbol must be a four-item CBOR array');
  const symbolIndex = reader.integer();
  if (symbolIndex < 0n || symbolIndex > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SymbolWireError('INTEGER_OUT_OF_RANGE', 'symbolIndex is out of range');
  }
  const count = reader.integer();
  if (count < I64_MIN || count > I64_MAX) {
    throw new SymbolWireError('INTEGER_OUT_OF_RANGE', 'symbol count is out of signed-i64 range');
  }
  const symbol = {
    symbolIndex: Number(symbolIndex),
    count,
    idXor: reader.bytes32(),
    checksumXor: reader.bytes32()
  };
  if (reader.remaining !== 0) throw new SymbolWireError('TRAILING_BYTES', 'trailing bytes after symbol tuple');
  return symbol;
}
