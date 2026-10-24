// SPDX-License-Identifier: Apache-2.0

/**
 * Return the numeric EIP-155 suffix carried by a DKG chain label.
 *
 * UALs in persisted jobs use both bare numeric labels (`31337`) and
 * namespaced labels (`evm:31337`, `base:8453`).  The adapter exposes the
 * authoritative numeric network through `getEvmChainId()`, so representation
 * aliases must compare by that value rather than by their raw strings.
 */
function numericEvmChainId(chainId: string): bigint | undefined {
  const match = /(?:^|:)([0-9]+)$/.exec(chainId.trim());
  if (!match) return undefined;
  try {
    return BigInt(match[1]);
  } catch {
    return undefined;
  }
}

/**
 * Whether a graph-scoped UAL's chain label names the chain this adapter
 * writes to: an exact label match, or the same numeric EIP-155 id.
 */
export function graphScopeTargetsChain(
  scopeChainId: string,
  adapterChainId: string,
  evmChainId?: bigint,
): boolean {
  // DKG chain labels are protocol namespaces, not necessarily EIP-155 aliases.
  // For example, `otp:20430` identifies the NeuroWeb test network while the
  // backing EVM currently reports chain id 31337.  An exact adapter-label match
  // is therefore authoritative and must win before numeric alias comparison.
  if (scopeChainId === adapterChainId) return true;
  const scopeNumericId = numericEvmChainId(scopeChainId);
  // If the raw labels differ, accept representation aliases only when their
  // numeric EIP-155 ids agree (for example `31337` and `evm:31337`).
  if (scopeNumericId !== undefined && evmChainId !== undefined) {
    return scopeNumericId === evmChainId;
  }
  const adapterNumericId = evmChainId ?? numericEvmChainId(adapterChainId);
  return scopeNumericId !== undefined
    && adapterNumericId !== undefined
    && scopeNumericId === adapterNumericId;
}
