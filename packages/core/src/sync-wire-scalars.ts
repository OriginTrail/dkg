/**
 * Closed RFC-64 wire-scalar validators shared by dormant sync codecs.
 *
 * Unsigned integers are decimal JSON strings so their full u64/u256 ranges do
 * not pass through JavaScript's binary floating-point number representation.
 * Block, index, count, length, and Unix-millisecond timestamp fields use u64;
 * chain IDs use u256.
 */
declare const DECIMAL_U64_V1_BRAND: unique symbol;
declare const DECIMAL_U256_V1_BRAND: unique symbol;
declare const DIGEST_32_V1_BRAND: unique symbol;
declare const EVM_ADDRESS_V1_BRAND: unique symbol;

export type DecimalU64V1 = string & {
  readonly [DECIMAL_U64_V1_BRAND]: true;
};
export type DecimalU256V1 = string & {
  readonly [DECIMAL_U256_V1_BRAND]: true;
};
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
export type Digest32V1 = string & {
  readonly [DIGEST_32_V1_BRAND]: true;
};
export type EvmAddressV1 = string & {
  readonly [EVM_ADDRESS_V1_BRAND]: true;
};

export const MAX_DECIMAL_U64 = (1n << 64n) - 1n;
export const MAX_DECIMAL_U256 = (1n << 256n) - 1n;

const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const CANONICAL_DIGEST_32 = /^0x[0-9a-f]{64}$/;
const LOWER_HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;
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
): asserts value is ChainIdV1 {
  assertCanonicalDecimalU256(value, label);
}

/** Packed v10 KA IDs use the full DecimalU256V1 domain, never u64. */
/**
 * A non-negative SAFE integer — block numbers and log/transaction indices
 * on this wire are JSON numbers. ONE transcription of the rule (PR #2436
 * review r23): the event-position validator and the VM-update scalar layer
 * both delegate here, so the accepted representation cannot drift apart.
 */
export function assertNonNegativeSafeInteger(
  value: unknown,
  label = 'value',
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

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
): asserts value is TimestampMsV1 {
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
  // Derive the digit cap from the domain bound so the two never desynchronize.
  const maxDigits = max.toString().length;
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
