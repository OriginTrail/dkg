// SPDX-License-Identifier: Apache-2.0

/**
 * The daemon's marketplace buyer (OT-RFC-27): built at boot when
 * `marketplace.enabled` is set and the chain has the marketplace, with its job
 * started. A setting the node cannot use (a buyer wallet that is not one of
 * its operational wallets, say) leaves the marketplace off, logged, and the
 * boot goes on. A renewal that fails is logged and recorded as a notification.
 * Beside it, the buyer's gateway: OpenAI-compatible calls, paid from the
 * subscription and served by sellers over the messenger, each dialed by the
 * peer id its signed offer names, with its job, which follows what landed and
 * makes ended epochs final.
 *
 * At boot (`startMarketplace`) buying and selling start each on its own: a
 * part that fails to start (a file it cannot read, say) is logged and stays
 * off, and the node boots on without it.
 */
import { join } from 'node:path';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  AccessKeys,
  Buyer,
  BuyerStore,
  Gateway,
  PEER_LIMITS,
  Router,
  decodeMessage,
  encodeMessage,
  serviceOffersFromBindings,
  serviceOffersQuery,
  NO_FX,
  resolveFx,
  resolveMarketplaceConfig,
  type BuyerAlert,
  type MarketplaceConfig,
} from '@origintrail-official/dkg-marketplace';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import type { DkgConfig } from '../config.js';
import { subscribeWhenAdmitted } from './marketplace-context-graph.js';
import { startMarketplaceSeller, type MarketplaceSellerRuntime } from './marketplace-seller.js';
import { withNetworkMarketplaceContextGraph } from './marketplace-network-default.js';

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
    // The block is the node config's, as read from its file: the resolver checks every setting.
    resolved = resolveMarketplaceConfig(config.marketplace as MarketplaceConfig, wallets);
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

export interface MarketplaceGatewayOptions {
  config: { marketplace?: unknown };
  agent: DKGAgent;
  buyer: Buyer;
  dataDir: string;
  log?: (message: string) => void;
}

/**
 * The buyer's gateway: its router reads offers from the Marketplace Context
 * Graph's Verifiable Memory alone, which the node subscribes to once the graph
 * admits it, keeps those their sellers signed, and reaches sellers over the
 * messenger. Its job runs as often as the buyer's.
 */
export async function startMarketplaceGateway(options: MarketplaceGatewayOptions): Promise<Gateway> {
  const { agent, buyer, dataDir } = options;
  const contextGraphId = (options.config.marketplace as MarketplaceConfig | undefined)?.contextGraphId;
  const offers = async () => contextGraphId
    ? serviceOffersFromBindings((await agent.query(serviceOffersQuery(), { contextGraphId, view: 'verifiable-memory' })).bindings as Record<string, unknown>[])
    : [];
  const router = new Router({
    chain: buyer.chain,
    offers,
    // The router reads the answer as a quote.
    quote: async (peerId, services) => decodeMessage(await agent.sendMarketplaceMessage(peerId, 'quote', encodeMessage({ services }), {
      timeoutMs: PEER_LIMITS.quoteTimeoutMs, maxReadBytes: PEER_LIMITS.quoteResponseBytes,
    })),
    pinned: async (serviceId) => {
      const pinned = (await buyer.store.readPlan())?.services.find((s) => s.serviceId === serviceId)?.pinnedSeller;
      return pinned === undefined ? [] : [pinned];
    },
  });
  const dir = join(dataDir, 'marketplace');
  let fx = NO_FX;
  try {
    fx = resolveFx(options.config.marketplace as MarketplaceConfig | undefined);
  } catch (err) {
    options.log?.(`[marketplace] ${err instanceof Error ? err.message : String(err)}: the catalog shows no USD`);
  }
  const gateway = new Gateway({
    chain: buyer.chain,
    buyerWallet: buyer.buyerWallet,
    store: buyer.store,
    router,
    keys: new AccessKeys(dir),
    send: (peerId, payload, messageId) => agent.sendMarketplaceMessage(peerId, 'serve', payload, {
      timeoutMs: PEER_LIMITS.serveTimeoutMs, maxReadBytes: PEER_LIMITS.serveResponseBytes, messageId,
    }),
    dir,
    modelOf: async (serviceId, epoch) => (await router.offersOf([epoch])).find((o) => o.serviceId === serviceId)?.model,
    fx,
    ...(options.log ? { log: options.log } : {}),
  });
  await gateway.load();
  gateway.start(buyer.config.tickSeconds);
  if (contextGraphId) {
    try {
      // Asked until the graph admits the node, or until the gateway stops.
      const stopAdmission = subscribeWhenAdmitted(agent, contextGraphId, options.log ? { log: options.log } : {});
      const stopJob = gateway.stop.bind(gateway);
      gateway.stop = () => {
        stopAdmission();
        return stopJob();
      };
    } catch (err) {
      await gateway.stop();
      throw err;
    }
  }
  return gateway;
}

export interface MarketplaceStartOptions {
  config: Pick<DkgConfig, 'marketplace'>;
  /** The node's network config: its `marketplace.contextGraphId`, when it names one, is the node's default graph. */
  network?: object | null;
  agent: DKGAgent;
  /** The node's operational wallets; the first signs the seller's receipts and offers. */
  wallets: readonly string[];
  dataDir: string;
  dashDb: Pick<DashboardDB, 'insertNotification'>;
  log: (message: string) => void;
}

/** What runs of the marketplace: each part `undefined` while it is off. */
export interface MarketplaceParts {
  marketplace: Buyer | undefined;
  marketplaceGateway: Gateway | undefined;
  marketplaceSeller: MarketplaceSellerRuntime | undefined;
}

/**
 * The marketplace at boot, when enabled: the buyer with its gateway, and the
 * seller. A part that fails to start is logged and stays off, and never stops
 * the boot: a buyer whose gateway fails stops with it, since nothing could
 * spend what it funds. Both use the network's Marketplace Context Graph unless
 * the node's config names its own.
 */
export async function startMarketplace(options: MarketplaceStartOptions): Promise<MarketplaceParts> {
  const { agent, wallets, dataDir, dashDb, log } = options;
  const config = withNetworkMarketplaceContextGraph(options.config, options.network);
  let marketplace: Buyer | undefined;
  let marketplaceGateway: Gateway | undefined;
  try {
    marketplace = startMarketplaceBuyer({ config, agent, wallets, dataDir, dashDb, log });
    if (marketplace) marketplaceGateway = await startMarketplaceGateway({ config, agent, buyer: marketplace, dataDir, log });
  } catch (err) {
    log(`[marketplace] buying could not start and stays off: ${messageOf(err)}`);
    await marketplace?.stop().catch(() => undefined);
    marketplace = undefined;
  }
  let marketplaceSeller: MarketplaceSellerRuntime | undefined;
  try {
    marketplaceSeller = await startMarketplaceSeller({ config, agent, signer: wallets[0], wallets, dataDir, log });
  } catch (err) {
    log(`[marketplace] selling could not start and stays off: ${messageOf(err)}`);
  }
  return { marketplace, marketplaceGateway, marketplaceSeller };
}
