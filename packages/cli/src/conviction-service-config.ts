// SPDX-License-Identifier: Apache-2.0

/**
 * The `chain` setting of Conviction Account service spending (OT-RFC-27):
 * which of the node's operational wallets is its buyer key.
 */
import { ethers } from 'ethers';

export interface ConvictionServiceChainSettings {
  /**
   * The buyer key: the address that consents to Conviction Account service
   * assignments and funds plan periods as the assignee. It must be one of the
   * node's operational wallets, a local key in `wallets.json` or a payer
   * account of the external signer (`chain.signer`); otherwise the routes that
   * need it answer 503. Omitted, the primary operational wallet is the buyer key.
   */
  caBuyerAddress?: string;
}

/** `chain.caBuyerAddress`, checksummed; anything but an EVM address fails at startup. */
export function resolveCaBuyerAddress(value: unknown): string {
  if (typeof value !== 'string' || !ethers.isAddress(value)) {
    throw new Error('chain.caBuyerAddress must be a 0x-prefixed 20-byte EVM address');
  }
  return ethers.getAddress(value);
}

/**
 * The startup line about the buyer key, or `undefined` when none is
 * configured: the key, or a warning that the node holds no signer for it.
 * Never throws (`resolveChainConfig` refuses a malformed value first).
 */
export function caBuyerKeyStartupLine(
  configured: unknown,
  wallets: ReadonlyArray<{ readonly address: string }>,
): string | undefined {
  if (configured === undefined) return undefined;
  const ours = typeof configured === 'string' && ethers.isAddress(configured)
    && wallets.some((wallet) => wallet.address.toLowerCase() === configured.toLowerCase());
  return ours
    ? `Conviction Account buyer key: ${ethers.getAddress(configured as string)}`
    : `[warn] chain.caBuyerAddress ${String(configured)} is not one of this node's operational wallets; `
      + 'the Conviction Account routes that sign as the buyer key answer 503';
}
