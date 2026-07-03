// viem-free chain-id helpers (so the wallet store + add-chain params don't pull viem).

/**
 * The daemon's `chainId` can be the compound `"slug:chainId"` form (e.g. `"base:84532"`). Most web3
 * call sites need the bare numeric id (viem's `Chain.id`, the `wallet_switchEthereumChain` hex, the
 * connected-vs-expected chain guard). Extract the trailing number.
 */
export function numericChainId(chainId: string | number): number {
  if (typeof chainId === 'number') return chainId;
  const tail = String(chainId).match(/(\d+)\s*$/)?.[1];
  const n = tail ? Number(tail) : NaN;
  if (!Number.isFinite(n)) throw new Error(`Unrecognized chainId: ${chainId}`);
  return n;
}

/** `0x`-prefixed hex of the numeric chain id, for `wallet_switchEthereumChain`/`wallet_addEthereumChain`. */
export function chainIdHex(chainId: string | number): `0x${string}` {
  return `0x${numericChainId(chainId).toString(16)}`;
}
