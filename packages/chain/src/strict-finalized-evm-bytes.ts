const CANONICAL_LOWER_HEX_BYTES_V1 = /^0x(?:[0-9a-f]{2})*$/;

/** Shared strict-profile predicate for canonical lowercase EVM byte strings. */
export function isCanonicalLowerHexBytesV1(input: unknown): input is string {
  return typeof input === 'string' && CANONICAL_LOWER_HEX_BYTES_V1.test(input);
}
