import { concat, equalBytes, utf8 } from './bytes.js';

export type CborValue = null | boolean | number | bigint | string | Uint8Array | readonly CborValue[];

function major(majorType: number, value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error('CBOR argument out of range');
  if (value < 24n) return Uint8Array.of((majorType << 5) | Number(value));
  if (value <= 0xffn) return Uint8Array.of((majorType << 5) | 24, Number(value));
  if (value <= 0xffffn) {
    const output = new Uint8Array(3);
    output[0] = (majorType << 5) | 25;
    new DataView(output.buffer).setUint16(1, Number(value), false);
    return output;
  }
  if (value <= 0xffff_ffffn) {
    const output = new Uint8Array(5);
    output[0] = (majorType << 5) | 26;
    new DataView(output.buffer).setUint32(1, Number(value), false);
    return output;
  }
  const output = new Uint8Array(9);
  output[0] = (majorType << 5) | 27;
  new DataView(output.buffer).setBigUint64(1, value, false);
  return output;
}

export function encodeCanonical(value: CborValue): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === 'boolean') return Uint8Array.of(value ? 0xf5 : 0xf4);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('only safe integers are permitted');
    return encodeCanonical(BigInt(value));
  }
  if (typeof value === 'bigint') return value >= 0n ? major(0, value) : major(1, -1n - value);
  if (typeof value === 'string') {
    if (value !== value.normalize('NFC')) throw new Error('text must be NFC');
    const bytes = utf8(value);
    return concat(major(3, BigInt(bytes.length)), bytes);
  }
  if (value instanceof Uint8Array) return concat(major(2, BigInt(value.length)), value);
  if (Array.isArray(value)) return concat(major(4, BigInt(value.length)), ...value.map(encodeCanonical));
  throw new Error('maps, floats, tags, undefined, and unsupported CBOR values are forbidden');
}

class Reader {
  #offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.#offset;
  }

  readByte(): number {
    if (this.#offset >= this.bytes.length) throw new Error('truncated CBOR');
    return this.bytes[this.#offset++];
  }

  readExact(length: number): Uint8Array {
    if (length < 0 || this.#offset + length > this.bytes.length) throw new Error('truncated CBOR');
    const output = this.bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return output;
  }

  argument(additional: number): bigint {
    if (additional < 24) return BigInt(additional);
    if (additional === 31) throw new Error('indefinite lengths are forbidden');
    const length = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (length === 0) throw new Error('reserved CBOR additional information');
    const encoded = this.readExact(length);
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const value = length === 1
      ? BigInt(encoded[0])
      : length === 2
        ? BigInt(view.getUint16(0, false))
        : length === 4
          ? BigInt(view.getUint32(0, false))
          : view.getBigUint64(0, false);
    const minimum = length === 1 ? 24n : length === 2 ? 256n : length === 4 ? 65_536n : 4_294_967_296n;
    if (value < minimum) throw new Error('non-shortest CBOR argument');
    return value;
  }

  value(): CborValue {
    const initial = this.readByte();
    const majorType = initial >>> 5;
    const additional = initial & 31;
    if (majorType === 0 || majorType === 1) {
      const argument = this.argument(additional);
      return majorType === 0 ? argument : -1n - argument;
    }
    if (majorType === 2 || majorType === 3) {
      const length = this.argument(additional);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR length out of range');
      const bytes = this.readExact(Number(length));
      if (majorType === 2) return bytes;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text !== text.normalize('NFC')) throw new Error('non-NFC text');
      return text;
    }
    if (majorType === 4) {
      const length = this.argument(additional);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR length out of range');
      return Array.from({ length: Number(length) }, () => this.value());
    }
    if (majorType === 5) throw new Error('maps are forbidden');
    if (majorType === 6) throw new Error('tags are forbidden');
    if (majorType === 7 && additional === 20) return false;
    if (majorType === 7 && additional === 21) return true;
    if (majorType === 7 && additional === 22) return null;
    throw new Error('floats, undefined, and unsupported simple values are forbidden');
  }
}

export function decodeCanonical(bytes: Uint8Array): CborValue {
  const reader = new Reader(bytes);
  const value = reader.value();
  if (reader.remaining !== 0) throw new Error('trailing CBOR bytes');
  if (!equalBytes(encodeCanonical(value), bytes)) throw new Error('non-canonical CBOR');
  return value;
}

export function assertTuple(value: CborValue, arity: number, name: string): asserts value is CborValue[] {
  if (!Array.isArray(value) || value.length !== arity) throw new Error(`${name} must be an exact ${arity}-item tuple`);
}
