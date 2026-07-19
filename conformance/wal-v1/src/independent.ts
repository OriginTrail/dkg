import { webcrypto } from 'node:crypto';
import { getBytes, verifyMessage } from 'ethers';
import { compareBytes, concat, equalBytes, hash, hex, sortedUniqueBytes, utf8 } from './bytes.js';
import { independentEncodeSymbols, type SymbolV1 } from './iblt.js';
import { independentSetCommitmentRoot } from './set-commitment.js';
import { DOMAINS } from './schema.js';
import type { ReducerCase, ReducerDecision } from './reference.js';

type Value = null | boolean | bigint | string | Uint8Array | Value[];

function lengthPrefix(major: number, size: bigint): Uint8Array {
  if (size < 24n) return Uint8Array.of(major * 32 + Number(size));
  if (size < 256n) return Uint8Array.of(major * 32 + 24, Number(size));
  const width = size < 65_536n ? 2 : size < 4_294_967_296n ? 4 : 8;
  const result = new Uint8Array(width + 1);
  result[0] = major * 32 + (width === 2 ? 25 : width === 4 ? 26 : 27);
  const view = new DataView(result.buffer);
  if (width === 2) view.setUint16(1, Number(size));
  else if (width === 4) view.setUint32(1, Number(size));
  else view.setBigUint64(1, size);
  return result;
}

export function independentCborEncode(value: Value): Uint8Array {
  if (value === null) return Uint8Array.of(246);
  if (value === false) return Uint8Array.of(244);
  if (value === true) return Uint8Array.of(245);
  if (typeof value === 'bigint') return value >= 0n ? lengthPrefix(0, value) : lengthPrefix(1, -1n - value);
  if (typeof value === 'string') {
    if (value.normalize('NFC') !== value) throw new Error('text is not NFC');
    const body = utf8(value);
    return concat(lengthPrefix(3, BigInt(body.length)), body);
  }
  if (value instanceof Uint8Array) return concat(lengthPrefix(2, BigInt(value.length)), value);
  if (Array.isArray(value)) {
    const pieces = value.map((entry) => independentCborEncode(entry));
    return concat(lengthPrefix(4, BigInt(pieces.length)), ...pieces);
  }
  throw new Error('unsupported value');
}

class Cursor {
  position = 0;

  constructor(readonly input: Uint8Array) {}

  take(length = 1): Uint8Array {
    if (this.position + length > this.input.length) throw new Error('truncated input');
    const value = this.input.slice(this.position, this.position + length);
    this.position += length;
    return value;
  }

  size(ai: number): bigint {
    if (ai < 24) return BigInt(ai);
    const width = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : -1;
    if (width < 0) throw new Error('indefinite or reserved argument');
    const bytes = this.take(width);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = width === 1
      ? BigInt(bytes[0])
      : width === 2
        ? BigInt(view.getUint16(0))
        : width === 4
          ? BigInt(view.getUint32(0))
          : view.getBigUint64(0);
    const lowerBound = width === 1 ? 24n : width === 2 ? 256n : width === 4 ? 65_536n : 4_294_967_296n;
    if (result < lowerBound) throw new Error('non-minimal argument');
    return result;
  }

  parse(): Value {
    const header = this.take()[0];
    const type = header >> 5;
    const ai = header & 31;
    if (type === 0 || type === 1) {
      const magnitude = this.size(ai);
      return type === 0 ? magnitude : -1n - magnitude;
    }
    if (type === 2 || type === 3 || type === 4) {
      const size = this.size(ai);
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('length too large');
      if (type === 2) return this.take(Number(size));
      if (type === 3) {
        const result = new TextDecoder('utf-8', { fatal: true }).decode(this.take(Number(size)));
        if (result.normalize('NFC') !== result) throw new Error('text is not NFC');
        return result;
      }
      const array: Value[] = [];
      while (array.length < Number(size)) array.push(this.parse());
      return array;
    }
    if (type === 5 || type === 6) throw new Error('maps and tags are forbidden');
    if (type === 7 && ai === 20) return false;
    if (type === 7 && ai === 21) return true;
    if (type === 7 && ai === 22) return null;
    throw new Error('float or unsupported simple value');
  }
}

export function independentCborDecode(input: Uint8Array): Value {
  const cursor = new Cursor(input);
  const result = cursor.parse();
  if (cursor.position !== input.length) throw new Error('trailing bytes');
  if (!equalBytes(independentCborEncode(result), input)) throw new Error('non-canonical input');
  return result;
}

function byteField(value: Value, length?: number): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) throw new Error('invalid byte field');
  return value;
}

function u64(value: Value): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error('invalid u64');
  return value;
}

export function independentVerifyWalObject(input: Uint8Array): { id: Uint8Array; payloadBytes: Uint8Array } {
  const value = independentCborDecode(input);
  if (!Array.isArray(value) || value.length !== 8) throw new Error('WalObjectV1 arity');
  if (value[0] !== 1n) throw new Error('WalObjectV1 version');
  byteField(value[1], 32);
  const writer = byteField(value[2], 20);
  u64(value[3]);
  const sequence = u64(value[4]);
  if (value[5] !== null) byteField(value[5], 32);
  if ((sequence === 0n) !== (value[5] === null)) throw new Error('WalObjectV1 sequence link');
  const payloadBytes = byteField(value[6]);
  const signature = byteField(value[7], 65);
  const digest = hash(DOMAINS.walObjectSignature, independentCborEncode(value.slice(0, 7)));
  const recovered = getBytes(verifyMessage(digest, `0x${hex(signature)}`));
  if (!equalBytes(recovered, writer)) throw new Error('WalObjectV1 signature');
  return { id: hash(DOMAINS.walObjectId, input), payloadBytes };
}

export function independentRoot(ids: readonly Uint8Array[]): Uint8Array {
  return independentSetCommitmentRoot(ids);
}

export function independentSymbols(ids: readonly Uint8Array[], seed: Uint8Array, count: number): SymbolV1[] {
  return independentEncodeSymbols(ids, seed, count);
}

export async function independentDecryptAesGcm(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: associatedData, tagLength: 128 },
    cryptoKey,
    ciphertext
  );
  return new Uint8Array(plaintext);
}

function sameSet(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  if (left.length !== right.length) return false;
  const a = sortedUniqueBytes(left);
  const b = sortedUniqueBytes(right);
  return a.every((value, index) => equalBytes(value, b[index]));
}

function overlap(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  const seen = new Set(left.map((entry) => hex(entry)));
  for (const entry of right) if (seen.has(hex(entry))) return true;
  return false;
}

function digest(domain: string, values: readonly Uint8Array[]): Uint8Array {
  const encoded = independentCborEncode(sortedUniqueBytes(values));
  return hash(domain, encoded);
}

export function independentReduceCase(input: ReducerCase): ReducerDecision {
  const current = sortedUniqueBytes(input.currentHeads);
  const base = sortedUniqueBytes(input.baseHeads);
  let status: ReducerDecision['status'] = 'conflict';
  let active = base;
  let conflicts = current;

  if (input.operation === 'MOVE_TIER_TARGET' && !input.hasTierReceipt) {
    status = 'pending';
    active = current;
    conflicts = [];
  } else if (input.operation === 'RESOLVE') {
    if (sameSet(input.resolutionHeads ?? [], current)) {
      status = 'apply';
      active = base;
      conflicts = [];
    }
  } else if (sameSet(current, base)) {
    status = 'apply';
    active = current;
    conflicts = [];
  } else if (input.operation === 'PATCH' && input.mode === 'PATCH' && !overlap(input.touchedKeys, input.concurrentTouchedKeys)) {
    status = 'merge';
    active = current;
    conflicts = [];
  }

  active.sort(compareBytes);
  conflicts.sort(compareBytes);
  return {
    status,
    activeHeads: active,
    conflictHeads: conflicts,
    headDigest: digest(DOMAINS.reducerHeads, active),
    conflictDigest: digest(DOMAINS.reducerConflict, conflicts)
  };
}
