/**
 * Closed RFC-64 wire-scalar validators shared by dormant sync codecs.
 *
 * Unsigned integers are decimal JSON strings so their full u64/u256 ranges do
 * not pass through JavaScript's binary floating-point number representation.
 * Block, index, count, length, and Unix-millisecond timestamp fields use u64;
 * chain IDs use u256.
 */
export type DecimalU64V1 = string;
export type DecimalU256V1 = string;
export type ChainIdV1 = DecimalU256V1;
export type KaIdV1 = DecimalU256V1;
export type ReservedKaIdV1 = KaIdV1;
export type BatchIdV1 = KaIdV1;
export type StartKaIdV1 = KaIdV1;
export type EndKaIdV1 = KaIdV1;
export type BlockNumberV1 = DecimalU64V1;
export type IndexV1 = DecimalU64V1;
export type CountV1 = DecimalU64V1;
export type ByteLengthV1 = DecimalU64V1;
export type TimestampMsV1 = DecimalU64V1;
export type Digest32V1 = string;
export type EvmAddressV1 = string;

export const MAX_DECIMAL_U64 = 18_446_744_073_709_551_615n;
export const MAX_DECIMAL_U256 =
  115_792_089_237_316_195_423_570_985_008_687_907_853_269_984_665_640_564_039_457_584_007_913_129_639_935n;

const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const CANONICAL_DIGEST_32 = /^0x[0-9a-f]{64}$/;
const LOWER_HEX_BYTES = /^0x(?:[0-9a-f]{2})+$/;
const ZERO_EVM_ADDRESS = `0x${'00'.repeat(20)}`;

export function parseCanonicalDecimalU64(
  value: unknown,
  label = 'value',
): bigint {
  return parseCanonicalUnsignedDecimal(value, MAX_DECIMAL_U64, 'u64', label);
}

export function assertCanonicalDecimalU64(
  value: unknown,
  label = 'value',
): asserts value is DecimalU64V1 {
  parseCanonicalDecimalU64(value, label);
}

export function parseCanonicalDecimalU256(
  value: unknown,
  label = 'value',
): bigint {
  return parseCanonicalUnsignedDecimal(value, MAX_DECIMAL_U256, 'u256', label);
}

export function assertCanonicalDecimalU256(
  value: unknown,
  label = 'value',
): asserts value is DecimalU256V1 {
  parseCanonicalDecimalU256(value, label);
}

/** ChainIdV1 is the full DecimalU256V1 structural domain, including zero. */
export function assertCanonicalChainId(
  value: unknown,
  label = 'chainId',
): asserts value is DecimalU256V1 {
  assertCanonicalDecimalU256(value, label);
}

/** Packed v10 KA IDs use the full DecimalU256V1 domain, never u64. */
export function assertCanonicalKaId(
  value: unknown,
  label = 'kaId',
): asserts value is KaIdV1 {
  assertCanonicalDecimalU256(value, label);
}

/** TimestampMsV1 is a u64 count of milliseconds from the Unix epoch. */
export function assertCanonicalTimestampMs(
  value: unknown,
  label = 'timestampMs',
): asserts value is DecimalU64V1 {
  assertCanonicalDecimalU64(value, label);
}

export function assertCanonicalDigest(
  value: unknown,
  label = 'digest',
): asserts value is Digest32V1 {
  if (typeof value !== 'string' || !CANONICAL_DIGEST_32.test(value)) {
    throw new Error(`${label} must be a lowercase 32-byte 0x digest`);
  }
}

export function assertCanonicalEvmAddress(
  value: unknown,
  label = 'address',
): asserts value is EvmAddressV1 {
  if (typeof value !== 'string' || !EVM_ADDRESS.test(value)) {
    throw new Error(`${label} must be a lowercase 20-byte 0x EVM address`);
  }
  if (value === ZERO_EVM_ADDRESS) {
    throw new Error(`${label} must not be the zero address`);
  }
}

export function assertCanonicalHexBytes(
  value: unknown,
  label: string,
  minBytes: number,
  maxBytes: number,
): asserts value is string {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`${label} must be lowercase 0x-prefixed bytes`);
  }
  const hexLength = value.length - 2;
  if (
    hexLength % 2 !== 0
    || hexLength < minBytes * 2
    || hexLength > maxBytes * 2
    || !LOWER_HEX_BYTES.test(value)
  ) {
    throw new Error(
      `${label} must be ${minBytes === maxBytes ? `${minBytes}` : `${minBytes}-${maxBytes}`} lowercase bytes`,
    );
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Require one plain record to contain exactly enumerable string data fields. */
export function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(record);
  if (actual.some((key) => typeof key !== 'string')) {
    throw new Error(`${label} must not contain symbol properties`);
  }
  const strings = actual as string[];
  const sortedExpected = [...expected].sort();
  if (
    strings.length !== sortedExpected.length
    || [...strings].sort().some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  for (const key of strings) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable data properties`);
    }
  }
}

function parseCanonicalUnsignedDecimal(
  value: unknown,
  max: bigint,
  width: 'u64' | 'u256',
  label: string,
): bigint {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a canonical unsigned decimal ${width} string`);
  }

  // Bound both regex work and BigInt construction for hostile in-memory callers.
  const maxDigits = width === 'u64' ? 20 : 78;
  if (value.length > maxDigits) {
    throw new Error(`${label} is outside the ${width} range`);
  }
  if (!CANONICAL_UNSIGNED_DECIMAL.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal ${width} string`);
  }
  const parsed = BigInt(value);
  if (parsed > max) {
    throw new Error(`${label} is outside the ${width} range`);
  }
  return parsed;
}
