// SPDX-License-Identifier: Apache-2.0

/**
 * The `marketplace` block of the node's config. The marketplace is off unless
 * `enabled` is true.
 */
import { ethers } from 'ethers';

export interface MarketplaceConfig {
  /** Off by default: the node funds nothing. */
  enabled?: boolean;
  /**
   * The operational wallet that pays for subscriptions: the sender of every
   * funding and top-up. One of the node's operational wallets, the primary
   * one by default.
   */
  buyerWallet?: string;
  /** How long before an epoch ends the node funds the next epoch's subscription. Default 120. */
  prefundLeadMinutes?: number;
  /** How often the buyer's job runs. Default 300. */
  tickSeconds?: number;
}

export interface ResolvedMarketplaceConfig {
  enabled: boolean;
  buyerWallet: string;
  prefundLeadSeconds: number;
  tickSeconds: number;
}

export const DEFAULT_PREFUND_LEAD_MINUTES = 120;
export const DEFAULT_TICK_SECONDS = 300;

/**
 * The marketplace settings with their defaults. `operationalWallets` are the
 * node's, the primary one first; the buyer wallet must be one of them, since
 * the node signs its transactions.
 */
export function resolveMarketplaceConfig(
  config: MarketplaceConfig | undefined,
  operationalWallets: readonly string[],
): ResolvedMarketplaceConfig {
  const primary = operationalWallets[0];
  const buyer = config?.buyerWallet ?? primary;
  if (buyer === undefined || !ethers.isAddress(buyer)) {
    throw new Error('marketplace.buyerWallet must be an address; the node has no operational wallet to default to');
  }
  if (!operationalWallets.some((wallet) => wallet.toLowerCase() === buyer.toLowerCase())) {
    throw new Error(`marketplace.buyerWallet ${buyer} is not one of this node's operational wallets`);
  }
  const lead = config?.prefundLeadMinutes ?? DEFAULT_PREFUND_LEAD_MINUTES;
  if (!Number.isFinite(lead) || lead <= 0) throw new Error('marketplace.prefundLeadMinutes must be a positive number');
  const tick = config?.tickSeconds ?? DEFAULT_TICK_SECONDS;
  if (!Number.isInteger(tick) || tick < 1) throw new Error('marketplace.tickSeconds must be a positive integer');
  return {
    enabled: config?.enabled === true,
    buyerWallet: ethers.getAddress(buyer),
    prefundLeadSeconds: Math.round(lead * 60),
    tickSeconds: tick,
  };
}
