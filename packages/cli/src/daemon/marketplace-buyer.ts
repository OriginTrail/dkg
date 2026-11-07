// SPDX-License-Identifier: Apache-2.0

/**
 * The daemon's marketplace buyer (OT-RFC-27): built at boot when
 * `marketplace.enabled` is set and the chain has the marketplace, with its job
 * started. A setting the node cannot use (a buyer wallet that is not one of
 * its operational wallets, say) leaves the marketplace off, logged, and the
 * boot goes on. A renewal that fails is logged and recorded as a notification.
 */
import { join } from 'node:path';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { Buyer, BuyerStore, resolveMarketplaceConfig, type BuyerAlert } from '@origintrail-official/dkg-marketplace';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import type { DkgConfig } from '../config.js';

export interface MarketplaceBuyerOptions {
  config: Pick<DkgConfig, 'marketplace'>;
  agent: Pick<DKGAgent, 'marketplaceChain'>;
  /** The node's operational wallets. */
  wallets: readonly string[];
  /** The node's data directory; the buyer keeps its plan and session keys under `marketplace/`. */
  dataDir: string;
  dashDb: Pick<DashboardDB, 'insertNotification'>;
  log: (message: string) => void;
}

export function startMarketplaceBuyer(options: MarketplaceBuyerOptions): Buyer | undefined {
  const { config, agent, wallets, dataDir, dashDb, log } = options;
  if (config.marketplace?.enabled !== true) return undefined;
  const chain = agent.marketplaceChain();
  if (!chain) {
    log('[marketplace] marketplace.enabled is set, but the node has no chain with the marketplace: it stays off');
    return undefined;
  }
  let resolved;
  try {
    resolved = resolveMarketplaceConfig(config.marketplace, wallets);
  } catch (err) {
    log(`[marketplace] ${err instanceof Error ? err.message : String(err)}: the marketplace stays off`);
    return undefined;
  }
  const onAlert = (alert: BuyerAlert): void => {
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: 'marketplace_renewal_failed',
        title: 'Marketplace renewal failed',
        message: alert.message,
        source: 'marketplace',
        meta: JSON.stringify({ epoch: alert.epoch, code: alert.code }),
      });
    } catch {
      // A notification that cannot be stored never stops the job; the log has it.
    }
  };
  const buyer = new Buyer({
    chain,
    // Session keys are sealed under the node's wallets.key, as its operational wallets' keys are.
    store: new BuyerStore(join(dataDir, 'marketplace'), dataDir),
    config: resolved,
    nodeWallets: wallets,
    onAlert,
    log,
  });
  buyer.start();
  log(
    `[marketplace] buyer wallet ${resolved.buyerWallet}: the job runs every ${resolved.tickSeconds} s ` +
    `and prefunds ${resolved.prefundLeadSeconds / 60} min before an epoch ends`,
  );
  return buyer;
}
