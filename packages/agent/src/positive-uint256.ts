const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Normalize the scalar shapes intentionally supported by the public JS API
 * without accepting rounded numbers or values that cannot be encoded on-chain.
 */
export function parsePositiveUint256(value: unknown, field: string): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${field} must be a positive integer within uint256 range.`);
    }
    parsed = BigInt(value);
  } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new Error(`${field} must be a positive integer within uint256 range.`);
  }

  if (parsed <= 0n || parsed > MAX_UINT256) {
    throw new Error(`${field} must be a positive integer within uint256 range.`);
  }
  return parsed;
}
