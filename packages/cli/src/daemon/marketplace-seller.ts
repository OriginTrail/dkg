// SPDX-License-Identifier: Apache-2.0

/**
 * The daemon's marketplace seller (OT-RFC-27): built at boot when
 * `marketplace.seller.enabled` is set and the chain has the marketplace. It
 * answers `quote` and `serve` over the messenger, and its job checks the Core
 * Node gate, shares its offers, signed and naming the node's peer id, into the
 * Marketplace Context Graph and lands its receipts. Offers are shared once the
 * graph admits the node, each copy as its own Knowledge Asset, and at once
 * when it does. A setting it cannot use leaves selling off, logged, and the
 * boot goes on.
 */
import { join } from 'node:path';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  PEER_LIMITS,
  Seller,
  connectorOf,
  decodeMessage,
  encodeMessage,
  refusal,
  resolveSellerConfig,
  type MarketplaceConfig,
} from '@origintrail-official/dkg-marketplace';
import { shareOfferAsset, subscribeWhenAdmitted } from './marketplace-context-graph.js';

export interface MarketplaceSellerOptions {
  config: { marketplace?: unknown };
  agent: DKGAgent;
  /** The operational wallet that signs receipts and offers: the primary one. */
  signer: string | undefined;
  /** The node's operational wallets, which Operate lists. */
  wallets?: readonly string[];
  /** The node's data directory; the seller keeps its ledger and prices under `marketplace/`. */
  dataDir: string;
  log: (message: string) => void;
}

export interface MarketplaceSellerRuntime {
  seller: Seller;
  /** Stop answering and stop the job. */
  stop(): Promise<void>;
}

export async function startMarketplaceSeller(options: MarketplaceSellerOptions): Promise<MarketplaceSellerRuntime | undefined> {
  const { config, agent, signer, dataDir, log } = options;
  let resolved;
  try {
    // The block is the node config's, as read from its file: the resolver checks every setting.
    resolved = resolveSellerConfig(config.marketplace as MarketplaceConfig | undefined);
  } catch (err) {
    log(`[marketplace] ${err instanceof Error ? err.message : String(err)}: selling stays off`);
    return undefined;
  }
  if (!resolved) return undefined;
  const chain = agent.marketplaceChain();
  if (!chain || !signer) {
    log('[marketplace] marketplace.seller.enabled is set, but the node has no chain with the marketplace or no operational wallet: selling stays off');
    return undefined;
  }
  let services;
  try {
    services = resolved.services.map((s) => ({ ...s, connector: connectorOf(s.backend) }));
  } catch (err) {
    log(`[marketplace] ${err instanceof Error ? err.message : String(err)}: selling stays off`);
    return undefined;
  }
  const contextGraphId = resolved.contextGraphId;
  let admitted = false;
  const seller = new Seller({
    chain,
    dir: join(dataDir, 'marketplace'),
    services,
    signer,
    peerId: agent.peerId,
    stopServingSeconds: resolved.stopServingSeconds,
    tickSeconds: resolved.tickSeconds,
    landing: resolved.landing,
    ...(options.wallets ? { wallets: options.wallets } : {}),
    ...(contextGraphId ? {
      shareOffer: async (quads) => {
        if (!admitted) throw new Error(`"${contextGraphId}" has not admitted this node yet`);
        await shareOfferAsset(agent, contextGraphId, quads);
      },
    } : {}),
    log,
  });
  await seller.load();
  const dispose = agent.registerMarketplaceHandlers({
    quote: async (payload) => encodeMessage(await seller.quote(decodeMessage(payload))),
    serve: async (payload) => {
      let raw: unknown;
      try {
        raw = decodeMessage(payload);
      } catch {
        return encodeMessage(refusal('BadRequest', 'not JSON'));
      }
      return encodeMessage(await seller.serve(raw));
    },
  }, { quote: PEER_LIMITS.quoteRequestBytes, serve: PEER_LIMITS.serveRequestBytes });
  seller.start();
  const stopAdmission = contextGraphId ? subscribeWhenAdmitted(agent, contextGraphId, {
    log,
    onAdmitted: () => {
      admitted = true;
      void seller.tick().catch(() => undefined);
    },
  }) : undefined;
  log(`[marketplace] selling ${services.length} service(s); receipts signed by ${signer}`);
  return {
    seller,
    async stop() {
      stopAdmission?.();
      dispose();
      await seller.stop();
    },
  };
}
