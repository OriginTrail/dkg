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
import type {
  MarketplaceOffer,
  MeterState,
  PlanPolicy,
  SellerRecountRecord,
  SellerStanding,
} from '@origintrail-official/dkg-marketplace';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { MarketplaceOfferingConfig } from './marketplace/config.js';
import { inferAdapterPublisherAddress } from './dkg-agent-helpers.js';
import { VmReconcileQueueClosedError } from './vm-reconcile-service.js';
import {
  MarketplaceSellerService,
  type MarketplaceFlushResult,
  type MarketplaceLogger,
} from './marketplace/seller-service.js';
import {
  MarketplaceBuyerService,
  type MarketplaceInvokeResult,
  type MarketplaceSubscribeResult,
} from './marketplace/buyer-service.js';
import type { MarketplaceQueryFn } from './marketplace/executors.js';
import {
  SellerConnectorManager,
  type MarketplaceConnectorStatus,
  type SellerOfferingDeps,
} from './marketplace/seller-offerings.js';
import { BuyerTokenizers } from './marketplace/tokenizer-files.js';
import {
  DEFAULT_CHAT_SERVE_TIMEOUT_MS,
  listGatewayModels,
  runChatCompletion,
  runGatewayQuery,
  type BuyerChatDeps,
  type MarketplaceChatCompletionInput,
  type MarketplaceChatCompletionResult,
  type MarketplaceGatewayModel,
  type MarketplaceGatewayQueryResult,
} from './marketplace/buyer-chat.js';
import type { MarketplaceSpendGuard } from './marketplace/buyer-errors.js';
import {
  createContextGraphOfferSource,
  publishMarketplaceOfferings,
  type MarketplaceOfferPublishResult,
} from './marketplace/offer-publisher.js';
import {
  createMarketplaceOfferAssetPort,
  ensureMarketplaceContextGraphAnchor,
} from './marketplace/offer-assets.js';

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
/** Discovery refresh (VM reconcile; SWM peer pull when empty): at most once per interval. */
const OFFER_BACKFILL_MIN_INTERVAL_MS = 30_000;
const OFFER_BACKFILL_MAX_PEERS = 4;

interface MarketplaceRuntime {
  buyer: MarketplaceBuyerService;
  /** Buyer chat/gateway deps (recount engines + chat serve timeout). */
  chat: BuyerChatDeps;
  /** Absent when no operational signing key is available (buyer-only node). */
  seller?: MarketplaceSellerService;
  /** The served offering set, incl. connector mounts + boot retries. */
  offerings?: SellerConnectorManager;
  sellerAddress?: string;
  flushTimer: ReturnType<typeof setInterval> | null;
  log: MarketplaceLogger;
  /**
   * Set (with the reason) when the one-time capability probe found no live
   * Marketplace contract behind the adapter: the runtime stays wired so
   * status/discovery answer, but every settlement call will fail until the
   * deployment registers the contract. Reported by `marketplaceStatus`.
   */
  degraded?: string;
}

/** Bounded final receipt flush at shutdown (persistence keeps the rest). */
const STOP_FLUSH_TIMEOUT_MS = 5_000;

/** Runtime per agent — mixin holders cannot carry instance fields. */
const marketplaceRuntimes = new WeakMap<DKGAgentBase, MarketplaceRuntime>();

export type MarketplaceSettleAction = 'flush-receipts' | 'finalize' | 'claim' | 'roll';

export interface MarketplaceStatus {
  enabled: boolean;
  sellerReady: boolean;
  buyerReady: boolean;
  /** Present (with the reason) when the chain has no live Marketplace contract. */
  degraded?: string;
  epoch?: bigint;
  settlementDeadline?: bigint;
  seller?: {
    offerings: number;
    pendingReceipts: number;
    submittedClaims: number;
    connectors?: { mounted: number; failed: number; mounting: number };
  };
  buyer?: {
    subscribed: boolean;
    epoch?: bigint;
    sessionKeyAddress?: string;
    meter?: MeterState;
    recount?: { sellers: number; deprioritized: number; denied: number };
  };
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

/** Seller offering deps bound to this agent (local SPARQL over the marketplace CG VM). */
function sellerOfferingDeps(
  agent: DKGAgent,
  log: MarketplaceLogger,
  opts: { dataDir?: string; queryGuards?: SellerOfferingDeps['queryGuards'] },
): SellerOfferingDeps {
  const queryFn: MarketplaceQueryFn = async (sparql, { signal }) => {
    // Scoped read: an UNSCOPED query needs a store with all-writer revision
    // coverage, which backend stores (e.g. oxigraph-server) do not provide —
    // the executor would refuse every call there. The prototype serves the
    // buyer's SPARQL over this node's Verifiable Memory of the marketplace
    // CG (the confirmed offer KAs). Not shared memory too: that route runs
    // the query once per partition and unions the results, so a `LIMIT n`
    // could return up to 2n rows whenever offer KAs are also held in shared
    // memory (around a publish). The guard's abort signal cancels store work.
    const result = await agent.query(sparql, { contextGraphId: MARKETPLACE_CONTEXT_GRAPH, signal });
    return { result };
  };
  return {
    log,
    queryFn,
    ...(opts.queryGuards ? { queryGuards: opts.queryGuards } : {}),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
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

    // Offers are Knowledge Assets of the shared `marketplace` CG (published to
    // Verifiable Memory, updated in place on-chain). Nothing creates that CG
    // on a buyer — without a subscription this node never binds the CG's
    // on-chain anchor, never reconciles its offers, and discovery stays empty
    // forever. Subscribe every marketplace node the same way the lifecycle
    // subscribes the system CGs (`always-on`): the subscription is
    // idempotent, needs no local CG to exist yet, and puts the CG into the
    // chain-driven VM reconcile and sync-on-connect scope.
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

    // Discovery refresh, throttled: reconcile the marketplace CG's Verifiable
    // Memory from the chain now instead of on the next periodic sweep, so an
    // offer update confirmed on-chain reaches this buyer's next discovery
    // (the reconcile also binds a freshly anchored CG). An EMPTY discovery
    // additionally pulls the CG's shared memory from a few connected peers:
    // the periodic sync reconciler skips recently-synced peers, so a node
    // whose first marketplace sync ran before the CG was anchored would
    // otherwise stay empty until the staleness window expires.
    let lastOfferBackfillAtMs = 0;
    const requestOfferBackfill = (empty: boolean): void => {
      const now = Date.now();
      if (now - lastOfferBackfillAtMs < OFFER_BACKFILL_MIN_INTERVAL_MS) return;
      lastOfferBackfillAtMs = now;
      this.runVmReconcileForCg(MARKETPLACE_CONTEXT_GRAPH, 'manual').catch((error: unknown) => {
        if (error instanceof VmReconcileQueueClosedError) return; // node shutting down
        // Expected until this node binds the CG's anchor; the sweep retries.
        log.info(
          `[marketplace] offer refresh VM reconcile did not run (the periodic sweep retries): `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (!empty) return;
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
      ...(this.config.dataDir
        ? { standingPath: join(this.config.dataDir, 'marketplace', 'seller-standing.json') }
        : {}),
      ...(config.buyer?.recountPolicy ? { recountPolicy: config.buyer.recountPolicy } : {}),
    });

    const runtime: MarketplaceRuntime = {
      buyer,
      chat: {
        buyer,
        tokenizers: new BuyerTokenizers(config.buyer?.tokenizers, log),
        chatServeTimeoutMs: config.buyer?.chatServeTimeoutMs ?? DEFAULT_CHAT_SERVE_TIMEOUT_MS,
      },
      flushTimer: null,
      log,
    };

    // Receipts are signed by the operational wallet whose transactions submit
    // the batches (the contract resolves the seller identity from msg.sender).
    const signerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (signerKey) {
      const receiptSigner = new ethers.Wallet(signerKey);
      const flushIntervalMs = config.seller?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
      const seller = new MarketplaceSellerService({
        messenger: this.messenger,
        chain: this.chain,
        receiptSigner,
        receiptSignerAddress: receiptSigner.address,
        log,
        flushIntervalMs,
        ...(this.config.dataDir ? { stateDir: join(this.config.dataDir, 'marketplace') } : {}),
        ...(config.seller?.batching ? { batching: config.seller.batching } : {}),
      });
      // Static offerings serve now; connector offerings mount in the
      // background (held `failed` + retried with backoff when the upstream
      // is not up yet). Boot never publishes.
      const offerings = new SellerConnectorManager(seller, sellerOfferingDeps(this, log, {
        ...(this.config.dataDir ? { dataDir: this.config.dataDir } : {}),
        ...(config.seller?.queryGuards ? { queryGuards: config.seller.queryGuards } : {}),
      }));
      offerings.boot(config.seller?.offerings ?? []);
      seller.registerProtocolHandlers();
      runtime.seller = seller;
      runtime.offerings = offerings;
      runtime.sellerAddress = receiptSigner.address;
      runtime.flushTimer = setInterval(() => {
        void seller.flushReceipts();
      }, flushIntervalMs);
      if (runtime.flushTimer.unref) runtime.flushTimer.unref();
    } else {
      this.log.info(ctx, '[marketplace] no operational signing key — seller role unavailable, buyer runtime only');
    }

    marketplaceRuntimes.set(this, runtime);
    this.log.info(
      ctx,
      `[marketplace] runtime wired (seller=${runtime.seller ? 'ready' : 'off'}, buyer=ready)`,
    );

    // One-time capability probe, detached: `supportsMarketplace()` only turns
    // true once the adapter's init resolved the Hub binding, so force one
    // resolution and degrade LOUDLY (once) when the deployment carries no
    // Marketplace contract — otherwise the misconfiguration surfaces as a
    // cryptic failure on the first settlement call. The runtime stays wired;
    // `marketplaceStatus` reports the degraded state.
    void (async () => {
      try {
        if (typeof this.chain.marketplaceGetAddress !== 'function') {
          runtime.degraded = 'the chain adapter has no marketplace surface';
        } else {
          await this.chain.marketplaceGetAddress();
          return;
        }
      } catch (error) {
        runtime.degraded = `no Marketplace contract is reachable: ${error instanceof Error ? error.message : String(error)}`;
      }
      log.warn(
        `[marketplace] runtime degraded — ${runtime.degraded} (quotes/offers still answer; `
        + 'funding, serving and settlement will fail until the deployment registers the Marketplace contract)',
      );
    })();
  }

  /**
   * Shutdown: stop the flush timer, attempt one BOUNDED final receipt flush
   * (so a clean stop does not strand claims until the next boot), then report
   * whatever remains — with a `stateDir` it is persisted for resubmission.
   */
  async stopMarketplaceRuntimeV1(this: DKGAgent): Promise<void> {
    const runtime = marketplaceRuntimes.get(this);
    if (!runtime) return;
    if (runtime.flushTimer) {
      clearInterval(runtime.flushTimer);
      runtime.flushTimer = null;
    }
    runtime.offerings?.stop();
    const seller = runtime.seller;
    if (seller && seller.pendingReceiptCount() > 0) {
      try {
        const flushed = await Promise.race([
          seller.flushReceipts({ all: true }),
          new Promise<undefined>((resolve) => {
            const timer = setTimeout(() => resolve(undefined), STOP_FLUSH_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        if (flushed === undefined) {
          runtime.log.warn(`[marketplace] final receipt flush still running after ${STOP_FLUSH_TIMEOUT_MS}ms — not waiting`);
        }
      } catch (error) {
        runtime.log.warn(
          `[marketplace] final receipt flush failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const pending = seller.pendingReceiptCount();
      if (pending > 0) {
        runtime.log.warn(
          `[marketplace] stopping with ${pending} unsubmitted receipt claim(s)`
          + `${this.config.dataDir ? ' (persisted; resubmitted on the next start)' : ' (LOST — no data dir)'}`,
        );
      }
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
      ...(runtime.degraded !== undefined ? { degraded: runtime.degraded } : {}),
      ...(runtime.seller
        ? { seller: { ...runtime.seller.status(), ...(runtime.offerings ? { connectors: runtime.offerings.counts() } : {}) } }
        : {}),
      buyer: { ...runtime.buyer.status(), recount: runtime.buyer.recountSummary() },
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

  /**
   * Replace the served offering set; publishes the offer KAs unless told not
   * to. ALL-OR-NOTHING: every connector offering mounts first; any mount
   * failure throws `MarketplaceConnectorMountError` and the old set stays.
   */
  async marketplaceSetOfferings(this: DKGAgent,
    offerings: MarketplaceOfferingConfig[],
    opts: { publish?: boolean } = {},
  ): Promise<{ offerings: number; published: string[]; assets?: MarketplaceOfferPublishResult['assets'] }> {
    const runtime = requireRuntime(this);
    if (!runtime.seller || !runtime.offerings) {
      throw new Error('marketplace: seller role unavailable on this node (no operational signing key)');
    }
    await runtime.offerings.replace(offerings);
    if (opts.publish === false) return { offerings: offerings.length, published: [] };
    const { published, assets } = await this.marketplacePublishOfferings();
    return { offerings: offerings.length, published, assets };
  }

  /**
   * Publish every configured offering as its own Knowledge Asset into the
   * `marketplace` CG (Verifiable Memory; a changed offering updates its KA
   * on-chain, an unchanged one is left alone). The KAs are authored by the
   * receipt-signing agent: buyers accept an offer only from a KA whose author
   * is the offer's `sellerAddress`.
   */
  async marketplacePublishOfferings(this: DKGAgent): Promise<MarketplaceOfferPublishResult> {
    const runtime = requireRuntime(this);
    const sellerAddress = runtime.sellerAddress;
    if (!runtime.seller || !sellerAddress) {
      throw new Error('marketplace: seller role unavailable on this node (no operational signing key)');
    }
    const sellerIdentityId = this.identityId > 0n ? this.identityId : await this.chain.getIdentityId();
    if (sellerIdentityId <= 0n) {
      throw new Error('marketplace: cannot publish offerings before the node has an on-chain identity');
    }
    const author = [this.defaultAgentAddress, ...this.listLocalAgents().map(({ agentAddress }) => agentAddress)]
      .find((address) => address?.toLowerCase() === sellerAddress.toLowerCase());
    if (!author) {
      throw new Error(
        `marketplace: the receipt signer ${sellerAddress} is not a local agent of this node, so it cannot author `
        + 'the offer Knowledge Assets (buyers accept an offer only from a KA authored by its sellerAddress)',
      );
    }
    return publishMarketplaceOfferings(
      createMarketplaceOfferAssetPort(this, author),
      runtime.seller.listOfferings(),
      { sellerIdentityId, sellerPeerId: this.peerId, sellerAddress },
      { ensureAnchor: async () => ensureMarketplaceContextGraphAnchor(this, this.chain, runtime.log) },
    );
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

  marketplaceMeter(this: DKGAgent): {
    state?: MeterState;
    summary?: string;
    recount: Array<SellerRecountRecord & { standing: SellerStanding }>;
  } {
    const runtime = requireRuntime(this);
    const state = runtime.buyer.meterState();
    const summary = runtime.buyer.meterSummary();
    return {
      ...(state ? { state } : {}),
      ...(summary !== undefined ? { summary } : {}),
      recount: runtime.buyer.recountSnapshot(),
    };
  }

  /** An OpenAI-shaped chat completion routed to an `openai-chat/v1` offer (the gateway's chat call). */
  async marketplaceChatCompletion(this: DKGAgent,
    input: MarketplaceChatCompletionInput,
  ): Promise<MarketplaceChatCompletionResult> {
    return runChatCompletion(requireRuntime(this).chat, input);
  }

  /** A SPARQL call sized by the query cost schedule (the gateway's query call). */
  async marketplaceGatewayQuery(this: DKGAgent,
    input: { sparql: string; maxRows?: number; spendGuard?: MarketplaceSpendGuard },
  ): Promise<MarketplaceGatewayQueryResult> {
    return runGatewayQuery(requireRuntime(this).chat, input);
  }

  /** Chat models across discovered `openai-chat/v1` offers. */
  async marketplaceGatewayModels(this: DKGAgent): Promise<MarketplaceGatewayModel[]> {
    return listGatewayModels(requireRuntime(this).chat);
  }

  /** This seller's connector offerings: state, origin, metering pin, optional live health probe. */
  async marketplaceConnectorStatus(this: DKGAgent, opts: { probe?: boolean } = {}): Promise<MarketplaceConnectorStatus[]> {
    const runtime = requireRuntime(this);
    return runtime.offerings ? runtime.offerings.status(opts) : [];
  }

  /** Operator override: clear a seller's local recount standing. */
  marketplaceResetSellerStanding(this: DKGAgent, sellerIdentityId: bigint): boolean {
    return requireRuntime(this).buyer.resetSellerStanding(sellerIdentityId);
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
