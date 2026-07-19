import { protocolError } from './errors.js';
import type { CborProtocolValue } from './schema.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function encodeArgument(majorType: number, argument: bigint): Uint8Array {
  if (argument < 0n || argument > MAX_U64) {
    return protocolError('WAL_CBOR_INTEGER_RANGE', 'CBOR argument must fit an unsigned 64-bit integer');
  }
  if (argument < 24n) return Uint8Array.of((majorType << 5) | Number(argument));
  if (argument <= 0xffn) return Uint8Array.of((majorType << 5) | 24, Number(argument));
  if (argument <= 0xffffn) {
    const output = new Uint8Array(3);
    output[0] = (majorType << 5) | 25;
    new DataView(output.buffer).setUint16(1, Number(argument), false);
    return output;
  }
  if (argument <= 0xffff_ffffn) {
    const output = new Uint8Array(5);
    output[0] = (majorType << 5) | 26;
    new DataView(output.buffer).setUint32(1, Number(argument), false);
    return output;
  }
  const output = new Uint8Array(9);
  output[0] = (majorType << 5) | 27;
  new DataView(output.buffer).setBigUint64(1, argument, false);
  return output;
}

export function encodeCanonicalCbor(value: CborProtocolValue): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === 'boolean') return Uint8Array.of(value ? 0xf5 : 0xf4);
  if (typeof value === 'bigint') {
    return value >= 0n
      ? encodeArgument(0, value)
      : encodeArgument(1, -1n - value);
  }
  if (typeof value === 'string') {
    if (value !== value.normalize('NFC')) {
      return protocolError('WAL_CBOR_NON_NFC', 'CBOR text must already be NFC normalized');
    }
    const encoded = textEncoder.encode(value);
    return concat([encodeArgument(3, BigInt(encoded.length)), encoded]);
  }
  if (value instanceof Uint8Array) {
    return concat([encodeArgument(2, BigInt(value.length)), value]);
  }
  if (Array.isArray(value)) {
    return concat([encodeArgument(4, BigInt(value.length)), ...value.map(encodeCanonicalCbor)]);
  }
  return protocolError(
    'WAL_CBOR_UNSUPPORTED_VALUE',
    'CBOR maps, numbers, floats, tags, undefined, and unsupported values are forbidden',
  );
}

class CanonicalCborReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private readByte(): number {
    if (this.offset >= this.bytes.length) {
      return protocolError('WAL_CBOR_TRUNCATED', 'truncated CBOR value');
    }
    return this.bytes[this.offset++];
  }

  private readExact(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) {
      return protocolError('WAL_CBOR_TRUNCATED', 'truncated CBOR value');
    }
    const output = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return output;
  }

  private readArgument(additional: number): bigint {
    if (additional < 24) return BigInt(additional);
    if (additional === 31) {
      return protocolError('WAL_CBOR_INDEFINITE_LENGTH', 'indefinite-length CBOR is forbidden');
    }
    const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (width === 0) {
      return protocolError('WAL_CBOR_RESERVED_ARGUMENT', 'reserved CBOR additional information');
    }
    const encoded = this.readExact(width);
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const argument = width === 1
      ? BigInt(encoded[0])
      : width === 2
        ? BigInt(view.getUint16(0, false))
        : width === 4
          ? BigInt(view.getUint32(0, false))
          : view.getBigUint64(0, false);
    const minimum = width === 1 ? 24n : width === 2 ? 256n : width === 4 ? 65_536n : 4_294_967_296n;
    if (argument < minimum) {
      return protocolError('WAL_CBOR_NON_SHORTEST', 'CBOR arguments must use their shortest representation');
    }
    return argument;
  }

  readValue(): CborProtocolValue {
    const initial = this.readByte();
    const majorType = initial >>> 5;
    const additional = initial & 31;
    if (majorType === 0 || majorType === 1) {
      const argument = this.readArgument(additional);
      return majorType === 0 ? argument : -1n - argument;
    }
    if (majorType === 2 || majorType === 3 || majorType === 4) {
      const length = this.readArgument(additional);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
        return protocolError('WAL_CBOR_LENGTH_RANGE', 'CBOR collection length exceeds the safe decoder range');
      }
      if (majorType === 4) {
        if (length > BigInt(this.remaining)) {
          return protocolError('WAL_CBOR_TRUNCATED', 'CBOR array length exceeds the remaining input');
        }
        return Array.from({ length: Number(length) }, () => this.readValue());
      }
      const encoded = this.readExact(Number(length));
      if (majorType === 2) return encoded;
      let text: string;
      try {
        text = textDecoder.decode(encoded);
      } catch {
        return protocolError('WAL_CBOR_INVALID_UTF8', 'CBOR text must contain valid UTF-8');
      }
      if (text !== text.normalize('NFC')) {
        return protocolError('WAL_CBOR_NON_NFC', 'CBOR text must be NFC normalized');
      }
      return text;
    }
    if (majorType === 5) return protocolError('WAL_CBOR_MAP_FORBIDDEN', 'CBOR maps are forbidden');
    if (majorType === 6) return protocolError('WAL_CBOR_TAG_FORBIDDEN', 'CBOR tags are forbidden');
    if (majorType === 7 && additional === 20) return false;
    if (majorType === 7 && additional === 21) return true;
    if (majorType === 7 && additional === 22) return null;
    return protocolError('WAL_CBOR_SIMPLE_FORBIDDEN', 'CBOR floats, undefined, and unsupported simple values are forbidden');
  }
}

export function decodeCanonicalCbor(bytes: Uint8Array): CborProtocolValue {
  if (!(bytes instanceof Uint8Array)) {
    return protocolError('WAL_CBOR_UNSUPPORTED_VALUE', 'canonical CBOR input must be a Uint8Array');
  }
  const reader = new CanonicalCborReader(bytes);
  const value = reader.readValue();
  if (reader.remaining !== 0) {
    return protocolError('WAL_CBOR_TRAILING_BYTES', 'trailing bytes after canonical CBOR value');
  }
  return value;
}

export function compareCanonicalCbor(left: CborProtocolValue, right: CborProtocolValue): number {
  const a = encodeCanonicalCbor(left);
  const b = encodeCanonicalCbor(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}
