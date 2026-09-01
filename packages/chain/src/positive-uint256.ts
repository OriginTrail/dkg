const MAX_UINT256 = (1n << 256n) - 1n;

/** Scalar forms accepted at public API boundaries for positive uint256 values. */
export type PositiveUint256Input = bigint | number | string;

/**
 * Normalize untrusted boundary input without accepting rounded JavaScript
 * numbers or values that cannot be encoded as a Solidity uint256.
 */
export function normalizePositiveUint256(value: unknown, field: string): bigint {
  let normalized: bigint;
  if (typeof value === 'bigint') {
    normalized = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${field} must be a positive integer within uint256 range.`);
    }
    normalized = BigInt(value);
  } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    normalized = BigInt(value);
  } else {
    throw new Error(`${field} must be a positive integer within uint256 range.`);
  }

  if (normalized <= 0n || normalized > MAX_UINT256) {
    throw new Error(`${field} must be a positive integer within uint256 range.`);
  }
  return normalized;
}

/** Serialize a supported positive uint256 input as its canonical decimal form. */
export function serializePositiveUint256(
  value: PositiveUint256Input,
  field: string,
): string {
  return normalizePositiveUint256(value, field).toString();
}
