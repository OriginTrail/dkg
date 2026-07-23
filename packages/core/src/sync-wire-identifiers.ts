/** Cross-protocol network identifier used by RFC-64 wire objects. */
declare const NETWORK_ID_V1_BRAND: unique symbol;

export type NetworkIdV1 = string & { readonly [NETWORK_ID_V1_BRAND]: true };

export const MAX_NETWORK_ID_BYTES_V1 = 128;

const NETWORK_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const UTF8 = new TextEncoder();

export function assertNetworkIdV1(
  value: unknown,
  label = 'networkId',
): asserts value is NetworkIdV1 {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (
    value.length > MAX_NETWORK_ID_BYTES_V1
    || UTF8.encode(value).byteLength > MAX_NETWORK_ID_BYTES_V1
  ) {
    throw new Error(`${label} exceeds ${MAX_NETWORK_ID_BYTES_V1} UTF-8 bytes`);
  }
  if (!NETWORK_ID_PATTERN.test(value)) {
    throw new Error(`${label} contains a character outside the networkId grammar`);
  }
}
