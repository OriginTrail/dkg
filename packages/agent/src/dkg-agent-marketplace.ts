// SPDX-License-Identifier: Apache-2.0

/**
 * OT-RFC-27 marketplace mixin: the agent-facing surface over the seller and
 * buyer services in `src/marketplace/`. The runtime is wired from the
 * lifecycle (`startMarketplaceRuntimeV1`, one call after messenger setup)
 * behind `config.marketplace?.enabled` and chain marketplace support; every
 * public method throws a clear error when the runtime is off.
 *
 * Mixin holder classes carry methods only (`applyMixins` copies prototypes),
 * so the runtime state lives in a module-level WeakMap keyed by the agent —
 * the same pattern the mock chain adapter's marketplace state uses.
 */

import { join } from 'node:path';
import { ethers } from 'ethers';
import { MARKETPLACE_CONTEXT_GRAPH, type OperationContext } from '@origintrail-official/dkg-core';
import type { TxResult } from '@origintrail-official/dkg-chain';
import {
  offeringIdFor,
  type MarketplaceOffer,
  type MeterState,
  type PlanPolicy,
} from '@origintrail-official/dkg-marketplace';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { MarketplaceOfferingConfig } from './marketplace/config.js';
import { inferAdapterPublisherAddress } from './dkg-agent-helpers.js';
import {
  MarketplaceSellerService,
  type MarketplaceFlushResult,
  type MarketplaceLogger,
  type MarketplaceSellerOffering,
} from './marketplace/seller-service.js';
import {
  MarketplaceBuyerService,
  type MarketplaceInvokeResult,
  type MarketplaceSubscribeResult,
} from './marketplace/buyer-service.js';
import {
  createQueryExecutor,
  createStubInferenceExecutor,
  type MarketplaceExecutor,
} from './marketplace/executors.js';
import {
  createContextGraphOfferSource,
  publishMarketplaceOfferings,
} from './marketplace/offer-publisher.js';

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
/** Empty-discovery SWM backfill: at most one peer sweep per interval. */
const OFFER_BACKFILL_MIN_INTERVAL_MS = 30_000;
const OFFER_BACKFILL_MAX_PEERS = 4;

interface MarketplaceRuntime {
  buyer: MarketplaceBuyerService;
  /** Absent when no operational signing key is available (buyer-only node). */
  seller?: MarketplaceSellerService;
  sellerAddress?: string;
  flushTimer: ReturnType<typeof setInterval> | null;
  log: MarketplaceLogger;
}

/** Runtime per agent — mixin holders cannot carry instance fields. */
const marketplaceRuntimes = new WeakMap<DKGAgentBase, MarketplaceRuntime>();

export type MarketplaceSettleAction = 'flush-receipts' | 'finalize' | 'claim' | 'roll';

export interface MarketplaceStatus {
  enabled: boolean;
  sellerReady: boolean;
  buyerReady: boolean;
  epoch?: bigint;
  settlementDeadline?: bigint;
  seller?: { offerings: number; pendingReceipts: number; submittedClaims: number };
  buyer?: { subscribed: boolean; epoch?: bigint; sessionKeyAddress?: string; meter?: MeterState };
}

/**
 * Best-effort on-chain anchor for the shared `marketplace` CG. Under RFC-64 a
 * plain-name unregistered CG has no authority a replica can verify (its
 * creator is a peer DID, and only wallet-namespace ids mint an owner-signed
 * seed), so buyer nodes fail closed and never materialize its offer shares.
 * Registration gives every node the finalized chain binding to resolve. The
 * first seller to publish registers; a later seller adopts the existing
 * binding instead of minting a duplicate graph for the same name. Failures
 * are contained — the offers are still shared locally and the next publish
 * retries the anchor.
 */
async function ensureMarketplaceContextGraphRegistered(agent: DKGAgent, log: MarketplaceLogger): Promise<void> {
  try {
    if (await agent.isContextGraphRegistered(MARKETPLACE_CONTEXT_GRAPH)) return;
    const authority = await agent.resolveContextGraphSubscriptionBootstrapAuthority(
      MARKETPLACE_CONTEXT_GRAPH,
      { signal: AbortSignal.timeout(20_000), freshness: 'bounded' },
    ).catch(() => undefined);
    if (authority?.outcome === 'allowed' && authority.onChainId !== undefined) return;
    const { onChainId, txHash } = await agent.registerContextGraph(MARKETPLACE_CONTEXT_GRAPH);
    log.info(
      `[marketplace] anchored the "${MARKETPLACE_CONTEXT_GRAPH}" context graph on-chain `
      + `(onChainId=${onChainId}${txHash ? `, tx=${txHash}` : ''}) so buyers can verify its authority`,
    );
  } catch (error) {
    log.warn(
      `[marketplace] could not register the "${MARKETPLACE_CONTEXT_GRAPH}" context graph on-chain — `
      + `buyer nodes cannot sync its offers until a seller registers it: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireRuntime(agent: DKGAgentBase): MarketplaceRuntime {
  const runtime = marketplaceRuntimes.get(agent);
  if (!runtime) {
    throw new Error(
      'marketplace is not running on this node (config.marketplace.enabled plus a marketplace-capable chain adapter are required)',
    );
  }
  return runtime;
}

function resolveExecutor(agent: DKGAgent, config: MarketplaceOfferingConfig): MarketplaceExecutor {
  const kind = config.executor ?? (config.serviceType === 'query' ? 'local-query' : 'stub-inference');
  if (kind === 'local-query') {
    return createQueryExecutor(async (sparql) => {
      // Scoped read: an UNSCOPED query needs a store with all-writer revision
      // coverage, which backend stores (e.g. oxigraph-server) do not provide —
      // the executor would refuse every call there. The prototype serves the
      // buyer's SPARQL over this node's synced marketplace CG view.
      const result = await agent.query(sparql, {
        contextGraphId: MARKETPLACE_CONTEXT_GRAPH,
        includeSharedMemory: true,
      });
      const bindings = (result as { bindings?: unknown })?.bindings;
      return { rowCount: Array.isArray(bindings) ? bindings.length : 0, result };
    });
  }
  return createStubInferenceExecutor();
}

function resolveOffering(agent: DKGAgent, config: MarketplaceOfferingConfig): MarketplaceSellerOffering {
  return {
    offeringLocalId: config.offeringLocalId,
    offeringId: offeringIdFor(config.offeringLocalId),
    serviceType: config.serviceType,
    ...(config.modelId !== undefined ? { modelId: config.modelId } : {}),
    unit: config.unit,
    askPerUnitWei: config.askPerUnitWei,
    ...(config.capacityUnitsPerMin !== undefined ? { capacityUnitsPerMin: config.capacityUnitsPerMin } : {}),
    ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
    executor: resolveExecutor(agent, config),
  };
}

export class MarketplaceMethods extends DKGAgentBase {
  /**
   * Wire the marketplace runtime: protocol handlers, receipt flush timer,
   * buyer session-key home. Called once from the lifecycle after messenger
   * setup; a no-op (logged once) when disabled or unsupported by the chain.
   */
  startMarketplaceRuntimeV1(this: DKGAgent, ctx: OperationContext): void {
    const config = this.config.marketplace;
    if (!config?.enabled) return;
    if (typeof this.chain.supportsMarketplace !== 'function' || this.chain.chainId === 'none') {
      this.log.warn(ctx, '[marketplace] enabled in config but the chain adapter has no marketplace surface — runtime not wired');
      return;
    }
    const log: MarketplaceLogger = {
      info: (message) => this.log.info(ctx, message),
      warn: (message) => this.log.warn(ctx, message),
    };

    // Offers travel as SWM shares of the shared `marketplace` CG. A seller is
    // subscribed implicitly when it creates the CG, but nothing creates it on
    // a buyer — without this subscription the shares never reach this node
    // and discovery stays empty forever. Subscribe every marketplace node the
    // same way the lifecycle subscribes the system CGs (`always-on`): the
    // subscription is idempotent, needs no local CG to exist yet, and puts
    // the CG into the sync-on-connect/catchup scope so shares published
    // before this node joined are backfilled from peers.
    const ensureOfferSubscription = (): void => {
      try {
        this.subscribeToContextGraph(MARKETPLACE_CONTEXT_GRAPH, { syncMode: 'always-on' });
      } catch (error) {
        log.warn(
          `[marketplace] could not subscribe to the "${MARKETPLACE_CONTEXT_GRAPH}" context graph `
          + `(retried on the next offer discovery): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    ensureOfferSubscription();

    // Empty-discovery self-heal: pull the marketplace CG's shared memory from
    // a few connected peers directly. The periodic sync reconciler skips
    // recently-synced peers, so a node whose first marketplace sync ran
    // before the CG's authority was anchored on-chain would otherwise stay
    // empty until the staleness window expires. Throttled; failures logged.
    let lastOfferBackfillAtMs = 0;
    const requestOfferBackfill = (): void => {
      const now = Date.now();
      if (now - lastOfferBackfillAtMs < OFFER_BACKFILL_MIN_INTERVAL_MS) return;
      lastOfferBackfillAtMs = now;
      const peers = this.node.libp2p.getPeers()
        .map((peer) => peer.toString())
        .filter((peerId) => peerId !== this.peerId)
        .slice(0, OFFER_BACKFILL_MAX_PEERS);
      for (const peerId of peers) {
        this.syncSharedMemoryFromPeer(peerId, [MARKETPLACE_CONTEXT_GRAPH]).catch((error: unknown) => {
          log.warn(
            `[marketplace] offer backfill SWM pull from ${peerId.slice(-8)} failed: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    };

    const buyer = new MarketplaceBuyerService({
      messenger: this.messenger,
      chain: this.chain,
      resolveBuyerAddress: async () => {
        const address = await inferAdapterPublisherAddress(this.chain);
        if (!address) throw new Error('marketplace: cannot resolve the buyer funding wallet from the chain adapter');
        return address;
      },
      offerSource: createContextGraphOfferSource(this),
      ensureOfferSubscription,
      requestOfferBackfill,
      log,
      ...(this.config.dataDir
        ? { sessionKeyPath: join(this.config.dataDir, 'marketplace', 'session-key.json') }
        : {}),
      ...(config.buyer?.authTtlSeconds !== undefined ? { authTtlSeconds: config.buyer.authTtlSeconds } : {}),
      ...(config.buyer?.quoteTimeoutMs !== undefined ? { quoteTimeoutMs: config.buyer.quoteTimeoutMs } : {}),
      ...(config.buyer?.serveTimeoutMs !== undefined ? { serveTimeoutMs: config.buyer.serveTimeoutMs } : {}),
      ...(config.buyer?.maxQuoteProbes !== undefined ? { maxQuoteProbes: config.buyer.maxQuoteProbes } : {}),
    });

    const runtime: MarketplaceRuntime = { buyer, flushTimer: null, log };

    // Receipts are signed by the operational wallet whose transactions submit
    // the batches (the contract resolves the seller identity from msg.sender).
    const signerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (signerKey) {
      const receiptSigner = new ethers.Wallet(signerKey);
      const seller = new MarketplaceSellerService({
        messenger: this.messenger,
        chain: this.chain,
        receiptSigner,
        receiptSignerAddress: receiptSigner.address,
        log,
        ...(config.seller?.batching ? { batching: config.seller.batching } : {}),
      });
      seller.setOfferings((config.seller?.offerings ?? []).map((offering) => resolveOffering(this, offering)));
      seller.registerProtocolHandlers();
      runtime.seller = seller;
      runtime.sellerAddress = receiptSigner.address;
      runtime.flushTimer = setInterval(() => {
        void seller.flushReceipts();
      }, config.seller?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
      if (runtime.flushTimer.unref) runtime.flushTimer.unref();
    } else {
      this.log.info(ctx, '[marketplace] no operational signing key — seller role unavailable, buyer runtime only');
    }

    marketplaceRuntimes.set(this, runtime);
    this.log.info(
      ctx,
      `[marketplace] runtime wired (seller=${runtime.seller ? 'ready' : 'off'}, buyer=ready)`,
    );
  }

  /** Clear the flush timer at shutdown; pending receipts are reported, not retried. */
  stopMarketplaceRuntimeV1(this: DKGAgent): void {
    const runtime = marketplaceRuntimes.get(this);
    if (!runtime) return;
    if (runtime.flushTimer) {
      clearInterval(runtime.flushTimer);
      runtime.flushTimer = null;
    }
    const pending = runtime.seller?.pendingReceiptCount() ?? 0;
    if (pending > 0) {
      runtime.log.warn(`[marketplace] stopping with ${pending} unsubmitted receipt claim(s)`);
    }
    marketplaceRuntimes.delete(this);
  }

  async marketplaceStatus(this: DKGAgent): Promise<MarketplaceStatus> {
    const runtime = marketplaceRuntimes.get(this);
    if (!runtime) {
      return { enabled: this.config.marketplace?.enabled === true, sellerReady: false, buyerReady: false };
    }
    const status: MarketplaceStatus = {
      enabled: true,
      sellerReady: runtime.seller !== undefined,
      buyerReady: true,
      ...(runtime.seller ? { seller: runtime.seller.status() } : {}),
      buyer: runtime.buyer.status(),
    };
    try {
      const epoch = await this.chain.getCurrentEpoch?.();
      if (epoch !== undefined) {
        status.epoch = epoch;
        const deadline = await this.chain.marketplaceSettlementDeadline?.(epoch);
        if (deadline !== undefined) status.settlementDeadline = deadline;
      }
    } catch (error) {
      runtime.log.warn(
        `[marketplace] status epoch read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return status;
  }

  /** Replace the served offering set; publishes the offer KAs unless told not to. */
  async marketplaceSetOfferings(this: DKGAgent,
    offerings: MarketplaceOfferingConfig[],
    opts: { publish?: boolean } = {},
  ): Promise<{ offerings: number; published: string[] }> {
    const runtime = requireRuntime(this);
    if (!runtime.seller) {
      throw new Error('marketplace: seller role unavailable on this node (no operational signing key)');
    }
    runtime.seller.setOfferings(offerings.map((offering) => resolveOffering(this, offering)));
    if (opts.publish === false) return { offerings: offerings.length, published: [] };
    const { published } = await this.marketplacePublishOfferings();
    return { offerings: offerings.length, published };
  }

  /** Publish every configured offering as a KA into the `marketplace` CG. */
  async marketplacePublishOfferings(this: DKGAgent): Promise<{ published: string[] }> {
    const runtime = requireRuntime(this);
    if (!runtime.seller || !runtime.sellerAddress) {
      throw new Error('marketplace: seller role unavailable on this node (no operational signing key)');
    }
    const sellerIdentityId = this.identityId > 0n ? this.identityId : await this.chain.getIdentityId();
    if (sellerIdentityId <= 0n) {
      throw new Error('marketplace: cannot publish offerings before the node has an on-chain identity');
    }
    const { published } = await publishMarketplaceOfferings(this, runtime.seller.listOfferings(), {
      sellerIdentityId,
      sellerPeerId: this.peerId,
      sellerAddress: runtime.sellerAddress,
    }, {
      ensureRegistered: async () => ensureMarketplaceContextGraphRegistered(this, runtime.log),
    });
    return { published };
  }

  async marketplaceDiscoverOffers(this: DKGAgent): Promise<MarketplaceOffer[]> {
    return requireRuntime(this).buyer.discoverOffers();
  }

  async marketplaceSubscribe(this: DKGAgent,
    opts: { amountWei: bigint; policy: PlanPolicy; epoch?: bigint },
  ): Promise<MarketplaceSubscribeResult> {
    return requireRuntime(this).buyer.subscribe(opts);
  }

  async marketplaceInvoke(this: DKGAgent, opts: {
    serviceType: MarketplaceOffer['serviceType'];
    modelId?: string;
    payload: Record<string, unknown>;
    maxUnits: bigint;
  }): Promise<MarketplaceInvokeResult> {
    return requireRuntime(this).buyer.invoke(opts);
  }

  marketplaceMeter(this: DKGAgent): { state?: MeterState; summary?: string } {
    const runtime = requireRuntime(this);
    const state = runtime.buyer.meterState();
    const summary = runtime.buyer.meterSummary();
    return { ...(state ? { state } : {}), ...(summary !== undefined ? { summary } : {}) };
  }

  /**
   * Settlement/ops rail: force-flush local receipts, finalize a bucket after
   * the deadline, claim this node's epoch reward, or roll an empty pool.
   */
  async marketplaceSettle(this: DKGAgent, opts: {
    action: MarketplaceSettleAction;
    buyer?: string;
    epoch?: bigint;
  }): Promise<MarketplaceFlushResult | (TxResult & { rewardWei?: bigint })> {
    const runtime = requireRuntime(this);
    if (opts.action === 'flush-receipts') {
      if (!runtime.seller) {
        throw new Error('marketplace: seller role unavailable on this node (no operational signing key)');
      }
      return runtime.seller.flushReceipts({ all: true });
    }
    const epoch = opts.epoch ?? runtime.buyer.activeEpoch();
    if (epoch === undefined) {
      throw new Error(`marketplace settle ${opts.action}: pass \`epoch\` (no active subscription to default from)`);
    }
    switch (opts.action) {
      case 'finalize': {
        const buyer = opts.buyer ?? (await inferAdapterPublisherAddress(this.chain));
        if (!buyer) throw new Error('marketplace settle finalize: pass `buyer` (no local funding wallet resolved)');
        if (typeof this.chain.marketplaceFinalizeBucket !== 'function') {
          throw new Error('marketplace: chain adapter cannot finalize buckets');
        }
        return this.chain.marketplaceFinalizeBucket(buyer, epoch);
      }
      case 'claim': {
        const identityId = this.identityId > 0n ? this.identityId : await this.chain.getIdentityId();
        if (identityId <= 0n) throw new Error('marketplace settle claim: this node has no on-chain identity');
        if (typeof this.chain.marketplaceClaimEpochReward !== 'function') {
          throw new Error('marketplace: chain adapter cannot claim epoch rewards');
        }
        return this.chain.marketplaceClaimEpochReward(identityId, epoch);
      }
      case 'roll': {
        if (typeof this.chain.marketplaceRollEpochPool !== 'function') {
          throw new Error('marketplace: chain adapter cannot roll epoch pools');
        }
        return this.chain.marketplaceRollEpochPool(epoch);
      }
      default:
        throw new Error(`marketplace settle: unknown action ${String(opts.action)}`);
    }
  }
}
