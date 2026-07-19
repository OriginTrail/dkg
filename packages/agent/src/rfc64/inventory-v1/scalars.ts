import {
  MAX_DECIMAL_U64,
  MAX_DECIMAL_U256,
  assertCanonicalDecimalU64,
  assertCanonicalDecimalU256,
  assertCanonicalDigest,
  type DecimalU64V1,
  type DecimalU256V1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

const EVM_ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const ZERO_EVM_ADDRESS_V1 = `0x${'00'.repeat(20)}`;

export class InventoryV1ScalarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryV1ScalarError';
  }
}

export function decimalU64ToSqlBlobV1(value: DecimalU64V1): Uint8Array {
  assertCanonicalDecimalU64(value, 'u64');
  return unsignedBigIntToFixedWidth(BigInt(value), 8, MAX_DECIMAL_U64, 'u64');
}

export function decimalU256ToSqlBlobV1(value: DecimalU256V1): Uint8Array {
  assertCanonicalDecimalU256(value, 'u256');
  return unsignedBigIntToFixedWidth(BigInt(value), 32, MAX_DECIMAL_U256, 'u256');
}

export function sqlBlobToDecimalU64V1(value: unknown): DecimalU64V1 {
  const decoded = fixedWidthToUnsignedBigInt(value, 8, 'u64').toString();
  assertCanonicalDecimalU64(decoded, 'u64');
  return decoded as DecimalU64V1;
}

export function sqlBlobToDecimalU256V1(value: unknown): DecimalU256V1 {
  const decoded = fixedWidthToUnsignedBigInt(value, 32, 'u256').toString();
  assertCanonicalDecimalU256(decoded, 'u256');
  return decoded as DecimalU256V1;
}

export function digest32ToSqlBlobV1(value: Digest32V1): Uint8Array {
  assertCanonicalDigest(value, 'digest');
  return lowerHexToBytes(value.slice(2), 32, 'digest');
}

export function sqlBlobToDigest32V1(value: unknown): Digest32V1 {
  const digest = `0x${bytesToLowerHex(assertSqlBlobWidthV1(value, 32, 'digest'))}`;
  assertCanonicalDigest(digest, 'digest');
  return digest;
}

export function evmAddressToSqlBlobV1(value: EvmAddressV1): Uint8Array {
  assertEvmAddressV1(value);
  return lowerHexToBytes(value.slice(2), 20, 'address');
}

export function sqlBlobToEvmAddressV1(value: unknown): EvmAddressV1 {
  const address = `0x${bytesToLowerHex(assertSqlBlobWidthV1(value, 20, 'address'))}`;
  assertEvmAddressV1(address);
  return address;
}

export function nullableIdentifierToSqlTextV1(
  value: string | null,
  assertIdentifier: (candidate: unknown) => void,
): string | null {
  if (value === null) return null;
  assertIdentifier(value);
  if (value.normalize('NFC') !== value) {
    throw new InventoryV1ScalarError('identifier must already be NFC normalized');
  }
  return value;
}

export function assertSqlBlobWidthV1(
  value: unknown,
  width: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== width) {
    throw new InventoryV1ScalarError(`${label} must be an exact ${width}-byte SQL BLOB`);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

export function sqlBlobsEqualV1(left: unknown, right: unknown): boolean {
  if (!(left instanceof Uint8Array)) return false;
  if (!(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

function unsignedBigIntToFixedWidth(
  value: bigint,
  width: number,
  maximum: bigint,
  label: string,
): Uint8Array {
  if (value < 0n || value > maximum) {
    throw new InventoryV1ScalarError(`${label} is outside its unsigned range`);
  }
  const result = new Uint8Array(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

function fixedWidthToUnsignedBigInt(value: unknown, width: number, label: string): bigint {
  const bytes = assertSqlBlobWidthV1(value, width, label);
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function lowerHexToBytes(value: string, width: number, label: string): Uint8Array {
  if (value.length !== width * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new InventoryV1ScalarError(`${label} must be ${width} lowercase hex bytes`);
  }
  const result = new Uint8Array(width);
  for (let index = 0; index < width; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function bytesToLowerHex(value: Uint8Array): string {
  let result = '';
  for (const byte of value) result += byte.toString(16).padStart(2, '0');
  return result;
}

function assertEvmAddressV1(value: unknown): asserts value is EvmAddressV1 {
  if (
    typeof value !== 'string'
    || !EVM_ADDRESS_V1.test(value)
    || value === ZERO_EVM_ADDRESS_V1
  ) {
    throw new InventoryV1ScalarError('address must be a lowercase nonzero 20-byte EVM address');
  }
}
