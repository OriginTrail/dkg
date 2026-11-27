// SPDX-License-Identifier: Apache-2.0

/** Parse the configured numeric chain ID shared by pinned-snapshot readers. */
export function numericChainIdOf(chainId: string | undefined): bigint | undefined {
  if (!chainId) return undefined;
  const tail = chainId.includes(':') ? chainId.split(':').pop() : chainId;
  if (!tail || !/^[0-9]+$/.test(tail)) return undefined;
  try {
    const numeric = BigInt(tail);
    return numeric > 0n ? numeric : undefined;
  } catch {
    return undefined;
  }
}
