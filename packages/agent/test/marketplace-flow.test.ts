/**
 * OT-RFC-27 marketplace agent runtime — full chainless flow over an
 * in-process messenger pair (real `Messenger` substrate instances wired
 * through router doubles, following messenger-substrate.test.ts) and a shared
 * `MockChainAdapter` marketplace (buyer and seller adapters settle against
 * ONE in-memory contract state, exactly like a devnet deployment):
 *
 *   subscribe → discover (injected offer source) → quote → invoke → receipt
 *   verify → batch flush → finalize → claim reward
 *
 * plus the seller-side objective-fault matrix (bad auth signature, replay,
 * expiry, wrong seller, over-max-units, settlement window), the buyer-side
 * soft-ceiling refusal, bad-receipt voiding, meter math, and session-key
 * persistence under the node data dir.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  MARKETPLACE_SERVE_VERSION,
  PROTOCOL_MARKETPLACE_SERVE,
  decodeMarketplaceServeResponse,
  encodeMarketplaceServeRequest,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';
import { MOCK_MARKETPLACE_ADDRESS, MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  computeAuthDigest,
  countTokens,
  eip191SignDigest,
  offeringIdFor,
  proRataFinalize,
  queryUnits,
  sessionKeyWallet,
  type AuthorizationFields,
  type MarketplaceOffer,
  type PlanPolicy,
} from '@origintrail-official/dkg-marketplace';
import { Messenger } from '../src/p2p/messenger.js';
import {
  MarketplaceSellerService,
  type MarketplaceSellerOffering,
} from '../src/marketplace/seller-service.js';
import {
  MarketplaceBuyerService,
  MarketplaceInvokeError,
  MarketplaceRouteError,
} from '../src/marketplace/buyer-service.js';
import {
  createQueryExecutor,
  createStubInferenceExecutor,
  type MarketplaceExecutor,
} from '../src/marketplace/executors.js';

const TRAC = 10n ** 18n;
const NOW_SECONDS = 1_900_000_000;
const SELLER_IDENTITY = 7n;
const SELLER_PEER = '12D3KooWSellerSellerSellerSellerSellerSellerSell';
const BUYER_PEER = '12D3KooWBuyerBuyerBuyerBuyerBuyerBuyerBuyerBuyer';
const INFERENCE_ASK = 500_000_000_000n; // 0.5 µTRAC per token
const QUERY_ASK = 15_000_000_000_000n; // 15 µTRAC per query unit
const LLM_OFFERING = 'devnet-llm';
const KNOWLEDGE_OFFERING = 'devnet-knowledge';

type InboundHandler = (data: Uint8Array, peerId: { toString(): string; toBytes(): Uint8Array }) => Promise<Uint8Array>;

interface Endpoint {
  peerId: string;
  messenger: Messenger;
  handlers: Map<string, InboundHandler>;
  remote?: Endpoint;
}

/** One side of an in-process pair: a real Messenger over a router double. */
function makeEndpoint(peerId: string): Endpoint {
  const handlers = new Map<string, InboundHandler>();
  const endpoint = { peerId, handlers } as Endpoint;
  const router = {
    register(protocolId: string, handler: InboundHandler): void {
      handlers.set(protocolId, handler);
    },
    async send(targetPeerId: string, protocolId: string, data: Uint8Array): Promise<Uint8Array> {
      const remote = endpoint.remote;
      if (!remote || remote.peerId !== targetPeerId) throw new Error(`no route to ${targetPeerId}`);
      const handler = remote.handlers.get(protocolId);
      if (!handler) throw new Error(`${targetPeerId} has no handler for ${protocolId}`);
      return handler(data, { toString: () => endpoint.peerId, toBytes: () => new Uint8Array() });
    },
  };
  endpoint.messenger = new Messenger({
    router: router as unknown as ProtocolRouter,
    idempotencyStore: new InMemoryMessageIdempotencyStore(),
    outboxStore: new InMemoryProtocolOutboxStore({ backoffs: [10], maxAgeMs: 60_000 }),
  });
  return endpoint;
}

function silentLog() {
  return { info: () => {}, warn: () => {} };
}

interface Harness {
  buyerWallet: ethers.Wallet;
  sellerWallet: ethers.Wallet;
  buyerChain: MockChainAdapter;
  sellerChain: MockChainAdapter;
  buyer: MarketplaceBuyerService;
  seller: MarketplaceSellerService;
  buyerEndpoint: Endpoint;
  offers: MarketplaceOffer[];
  policy: PlanPolicy;
  dataDir: string;
  sessionKeyPath: string;
  queryCalls: string[];
  cleanup(): void;
}

function makeOfferings(queryCalls: string[], inferenceExecutor?: MarketplaceExecutor): MarketplaceSellerOffering[] {
  return [
    {
      offeringLocalId: LLM_OFFERING,
      offeringId: offeringIdFor(LLM_OFFERING),
      serviceType: 'inference',
      unit: 'token',
      askPerUnitWei: INFERENCE_ASK,
      executor: inferenceExecutor ?? createStubInferenceExecutor(),
    },
    {
      offeringLocalId: KNOWLEDGE_OFFERING,
      offeringId: offeringIdFor(KNOWLEDGE_OFFERING),
      serviceType: 'query',
      unit: 'query-unit',
      askPerUnitWei: QUERY_ASK,
      executor: createQueryExecutor(async (sparql) => {
        queryCalls.push(sparql);
        return { rowCount: 3, result: { bindings: ['a', 'b', 'c'] } };
      }),
    },
  ];
}

function createHarness(opts: { inferenceExecutor?: MarketplaceExecutor } = {}): Harness {
  const buyerWallet = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
  const sellerWallet = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
  const buyerChain = new MockChainAdapter('mock:31337', buyerWallet.address);
  const sellerChain = new MockChainAdapter('mock:31337', sellerWallet.address);
  // Buyer and sellers settle against ONE marketplace deployment.
  sellerChain.__attachMarketplaceState(buyerChain.__marketplaceState());
  sellerChain.seedIdentity(sellerWallet.address, SELLER_IDENTITY);
  buyerChain.__marketplaceState().nowSeconds = BigInt(NOW_SECONDS);

  const buyerEndpoint = makeEndpoint(BUYER_PEER);
  const sellerEndpoint = makeEndpoint(SELLER_PEER);
  buyerEndpoint.remote = sellerEndpoint;
  sellerEndpoint.remote = buyerEndpoint;

  const queryCalls: string[] = [];
  const seller = new MarketplaceSellerService({
    messenger: sellerEndpoint.messenger,
    chain: sellerChain,
    receiptSigner: sellerWallet,
    receiptSignerAddress: sellerWallet.address,
    log: silentLog(),
    now: () => NOW_SECONDS * 1000,
    // Keep every flush manual: the tests drive settlement deterministically.
    batching: { maxBatchSize: 100, maxDelayMs: 3_600_000, maxBuyerExposureWei: 1_000_000n * TRAC },
  });
  seller.setOfferings(makeOfferings(queryCalls, opts.inferenceExecutor));
  seller.registerProtocolHandlers();

  const offers: MarketplaceOffer[] = [
    {
      offerId: `urn:dkg:marketplace:offer:${SELLER_PEER}:${LLM_OFFERING}`,
      offeringId: offeringIdFor(LLM_OFFERING),
      serviceType: 'inference',
      unit: 'token',
      askPerUnitWei: INFERENCE_ASK,
      sellerIdentityId: SELLER_IDENTITY,
      sellerPeerId: SELLER_PEER,
      sellerAddress: sellerWallet.address,
    },
    {
      offerId: `urn:dkg:marketplace:offer:${SELLER_PEER}:${KNOWLEDGE_OFFERING}`,
      offeringId: offeringIdFor(KNOWLEDGE_OFFERING),
      serviceType: 'query',
      unit: 'query-unit',
      askPerUnitWei: QUERY_ASK,
      sellerIdentityId: SELLER_IDENTITY,
      sellerPeerId: SELLER_PEER,
      sellerAddress: sellerWallet.address,
    },
  ];

  const dataDir = mkdtempSync(join(tmpdir(), 'dkg-marketplace-test-'));
  const sessionKeyPath = join(dataDir, 'marketplace', 'session-key.json');
  const buyer = new MarketplaceBuyerService({
    messenger: buyerEndpoint.messenger,
    chain: buyerChain,
    resolveBuyerAddress: async () => buyerWallet.address,
    // Design-doc seam: the unit test injects offers; the devnet path reads
    // the marketplace Context Graph through createContextGraphOfferSource.
    offerSource: { discoverOffers: async () => offers },
    log: silentLog(),
    sessionKeyPath,
    nowSeconds: () => NOW_SECONDS,
  });

  const policy: PlanPolicy = {
    totalBudgetWei: 10n * TRAC,
    buckets: [
      {
        match: { serviceType: 'inference' },
        budgetWei: 5n * TRAC,
        priceCapWeiPerUnit: 1_000_000_000_000n,
        maxUnitsPerCall: 10_000_000n,
      },
      {
        match: { serviceType: 'query' },
        budgetWei: 5n * TRAC,
        priceCapWeiPerUnit: 20_000_000_000_000n,
        maxUnitsPerCall: 10_000n,
      },
    ],
  };

  return {
    buyerWallet,
    sellerWallet,
    buyerChain,
    sellerChain,
    buyer,
    seller,
    buyerEndpoint,
    offers,
    policy,
    dataDir,
    sessionKeyPath,
    queryCalls,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

/** Hand-crafted serve request bytes (fault-matrix probes bypass the router). */
async function craftServeRequest(
  harness: Harness,
  overrides: {
    fields?: Partial<AuthorizationFields>;
    signer?: ethers.Wallet;
    version?: number;
    payloadKind?: string;
    payload?: Record<string, unknown>;
  } = {},
): Promise<Uint8Array> {
  const fields: AuthorizationFields = {
    chainId: 31337n,
    marketplaceAddress: MOCK_MARKETPLACE_ADDRESS,
    buyer: harness.buyerWallet.address,
    sellerIdentityId: SELLER_IDENTITY,
    offeringId: offeringIdFor(LLM_OFFERING),
    callId: ethers.hexlify(randomBytes(32)),
    epoch: 1n,
    maxUnits: 64n,
    askPerUnitWei: INFERENCE_ASK,
    expiry: BigInt(NOW_SECONDS + 600),
    ...overrides.fields,
  };
  const signer = overrides.signer ?? sessionKeyWallet(harness.buyer.ensureSessionKey());
  const signature = await eip191SignDigest(signer, computeAuthDigest(fields));
  return encodeMarketplaceServeRequest({
    version: overrides.version ?? MARKETPLACE_SERVE_VERSION,
    buyer: ethers.getBytes(fields.buyer),
    sellerIdentityId: fields.sellerIdentityId.toString(),
    offeringId: ethers.getBytes(fields.offeringId),
    callId: ethers.getBytes(fields.callId),
    epoch: fields.epoch,
    maxUnits: fields.maxUnits,
    askPerUnitWei: fields.askPerUnitWei.toString(),
    expiry: fields.expiry,
    authSignature: ethers.getBytes(signature),
    payloadKind: overrides.payloadKind ?? 'inference',
    payload: new TextEncoder().encode(JSON.stringify(overrides.payload ?? { prompt: 'crafted prompt' })),
  });
}

async function sendCraftedServe(harness: Harness, request: Uint8Array) {
  const sent = await harness.buyerEndpoint.messenger.sendReliable(SELLER_PEER, PROTOCOL_MARKETPLACE_SERVE, request);
  if (!sent.delivered) throw new Error(`crafted serve not delivered: ${'error' in sent ? sent.error : 'unknown'}`);
  return decodeMarketplaceServeResponse(sent.response);
}

describe('marketplace agent runtime — chainless end-to-end flow', () => {
  it('runs subscribe → invoke → receipt → flush → finalize → claim against one shared mock marketplace', async () => {
    const h = createHarness();
    try {
      // 1. Subscribe: fund the epoch-1 bucket and register the session key.
      const subscription = await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      expect(subscription.epoch).toBe(1n);
      const bucket = await h.buyerChain.marketplaceGetBucket(h.buyerWallet.address, 1n);
      expect(bucket.funded).toBe(10n * TRAC);
      expect((await h.buyerChain.marketplaceGetActiveSessionKey(h.buyerWallet.address)).toLowerCase())
        .toBe(subscription.sessionKeyAddress.toLowerCase());

      // 2. Discover (injected source) + invoke a chat-style inference call.
      expect(await h.buyer.discoverOffers()).toHaveLength(2);
      const prompt = 'hello marketplace';
      const inference = await h.buyer.invoke({
        serviceType: 'inference',
        payload: { prompt },
        maxUnits: 100n,
      });
      const promptTokens = countTokens(prompt);
      const inferenceUnits = promptTokens * 2n; // echo stub: prompt + output
      expect((inference.result as { output: string }).output).toBe(prompt);
      expect(inference.servedUnits).toBe(inferenceUnits);
      const inferenceCost = inferenceUnits * INFERENCE_ASK;
      expect(inference.costWei).toBe(inferenceCost);
      expect(inference.seller.identityId).toBe(SELLER_IDENTITY);
      expect(inference.receipt.resultCommitment).toBe(ethers.sha256(inference.resultBytes));

      // 3. Invoke a SPARQL call; units follow the shared static schedule.
      const sparql = 'SELECT * WHERE { ?s ?p ?o } LIMIT 3';
      const query = await h.buyer.invoke({
        serviceType: 'query',
        payload: { sparql },
        maxUnits: 50n,
      });
      const queryUnitCount = queryUnits(sparql, 3);
      expect(query.servedUnits).toBe(queryUnitCount);
      const queryCost = queryUnitCount * QUERY_ASK;
      expect(query.costWei).toBe(queryCost);
      expect(h.queryCalls).toEqual([sparql]);

      // 4. Meter math: both calls settled, nothing left reserved.
      const meter = h.buyer.meterState();
      expect(meter?.buckets[0]).toEqual({ budgetWei: 5n * TRAC, settledWei: inferenceCost, reservedWei: 0n });
      expect(meter?.buckets[1]).toEqual({ budgetWei: 5n * TRAC, settledWei: queryCost, reservedWei: 0n });
      expect(meter?.totalSettledWei).toBe(inferenceCost + queryCost);
      expect(h.buyer.meterSummary()).toContain('remaining');

      // 5. Receipts batched locally, then force-flushed on-chain as one batch.
      expect(h.seller.pendingReceiptCount()).toBe(2);
      const flush = await h.seller.flushReceipts({ all: true });
      expect(flush).toMatchObject({ batches: 1, claims: 2, failedClaims: 0 });
      expect(h.seller.pendingReceiptCount()).toBe(0);
      const claim = await h.sellerChain.marketplaceGetSellerClaim(h.buyerWallet.address, 1n, SELLER_IDENTITY);
      expect(claim.claimed).toBe(inferenceCost + queryCost);

      // 6. Settlement window passes → finalize the bucket (under-claimed:
      // finalized == claimed) and claim the epoch reward.
      h.buyerChain.__advanceEpoch();
      h.sellerChain.__advanceEpoch();
      await h.buyerChain.marketplaceFinalizeBucket(h.buyerWallet.address, 1n);
      const accounting = await h.sellerChain.marketplaceGetNodeEpochAccounting(1n, SELLER_IDENTITY);
      expect(accounting.finalizedValue).toBe(inferenceCost + queryCost);
      expect(accounting.totalFinalizedValue).toBe(inferenceCost + queryCost);
      expect(accounting.pool).toBe(10n * TRAC);

      // Only claimant: QIF = (1−λ)·R/ΣR + λ·Q/ΣQ = 1e18 → the whole pool.
      const reward = await h.sellerChain.marketplaceClaimEpochReward(SELLER_IDENTITY, 1n);
      expect(reward.rewardWei).toBe(10n * TRAC);
      expect(h.buyerChain.__marketplaceState().rewardsPaidWei.get(h.sellerWallet.address.toLowerCase()))
        .toBe(10n * TRAC);
    } finally {
      h.cleanup();
    }
  });

  it('pro-rata finalization caps an over-claimed bucket to its funding (floor mirror)', async () => {
    const servedUnits = 1_400_000n;
    const h = createHarness({
      inferenceExecutor: {
        kind: 'inference',
        execute: async () => ({
          resultBytes: new TextEncoder().encode(JSON.stringify({ output: 'bulk' })),
          unitsServed: servedUnits,
        }),
      },
    });
    try {
      await h.buyer.subscribe({ amountWei: 1n * TRAC, policy: h.policy, epoch: 1n });
      // Two calls at 0.7 TRAC claimed each → 1.4 TRAC over a 1 TRAC bucket.
      for (let i = 0; i < 2; i += 1) {
        const invoked = await h.buyer.invoke({
          serviceType: 'inference',
          payload: { prompt: 'bulk usage' },
          maxUnits: 1_500_000n,
        });
        expect(invoked.costWei).toBe(servedUnits * INFERENCE_ASK);
      }
      await h.seller.flushReceipts({ all: true });
      const claimedWei = 2n * servedUnits * INFERENCE_ASK;
      expect(claimedWei).toBeGreaterThan(1n * TRAC);

      h.buyerChain.__advanceEpoch();
      h.sellerChain.__advanceEpoch();
      await h.buyerChain.marketplaceFinalizeBucket(h.buyerWallet.address, 1n);

      const mirror = proRataFinalize(1n * TRAC, [{ identityId: SELLER_IDENTITY, claimedWei }]);
      const accounting = await h.sellerChain.marketplaceGetNodeEpochAccounting(1n, SELLER_IDENTITY);
      expect(accounting.finalizedValue).toBe(mirror[0].finalizedWei);
      const bucket = await h.buyerChain.marketplaceGetBucket(h.buyerWallet.address, 1n);
      expect(bucket.finalized).toBe(true);
      expect(bucket.totalFinalized).toBe(1n * TRAC);
    } finally {
      h.cleanup();
    }
  });

  it('rejects objective faults on the seller side (auth, replay, expiry, seller binding, units, window)', async () => {
    const h = createHarness();
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });

      // Bad auth: signed by a key that is NOT the registered session key.
      const rogue = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
      expect((await sendCraftedServe(h, await craftServeRequest(h, { signer: rogue }))).errorCode).toBe('BAD_AUTH');

      // Replay: the identical single-use authorization served twice.
      const replayable = await craftServeRequest(h);
      expect((await sendCraftedServe(h, replayable)).ok).toBe(true);
      expect((await sendCraftedServe(h, replayable)).errorCode).toBe('REPLAYED_CALL_ID');

      // Expired authorization.
      expect((await sendCraftedServe(h, await craftServeRequest(h, {
        fields: { expiry: BigInt(NOW_SECONDS - 10) },
      }))).errorCode).toBe('EXPIRED');

      // Authorization bound to a different seller identity.
      expect((await sendCraftedServe(h, await craftServeRequest(h, {
        fields: { sellerIdentityId: 9n },
      }))).errorCode).toBe('WRONG_SELLER');

      // The prompt alone cannot fit the authorized unit ceiling — fail closed.
      expect((await sendCraftedServe(h, await craftServeRequest(h, {
        fields: { maxUnits: 2n },
        payload: { prompt: 'a prompt far longer than two tokens allow' },
      }))).errorCode).toBe('OVER_MAX_UNITS');

      // Settlement window already closed for that epoch.
      expect((await sendCraftedServe(h, await craftServeRequest(h, {
        fields: { epoch: 0n },
      }))).errorCode).toBe('SETTLEMENT_CLOSED');

      // Unknown offering and version mismatch.
      expect((await sendCraftedServe(h, await craftServeRequest(h, {
        fields: { offeringId: offeringIdFor('never-published') },
      }))).errorCode).toBe('UNKNOWN_OFFERING');
      expect((await sendCraftedServe(h, await craftServeRequest(h, { version: 99 }))).errorCode)
        .toBe('UNSUPPORTED_VERSION');

      // Exactly one serve succeeded → exactly one receipt pending.
      expect(h.seller.pendingReceiptCount()).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a call that would cross the soft ceiling and reserves nothing', async () => {
    const h = createHarness();
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      // Worst case 9.8M tokens · 0.5 µTRAC = 4.9 TRAC > 95% of the 5 TRAC bucket.
      const attempt = h.buyer.invoke({
        serviceType: 'inference',
        payload: { prompt: 'huge' },
        maxUnits: 9_800_000n,
      });
      await expect(attempt).rejects.toBeInstanceOf(MarketplaceRouteError);
      const error = await attempt.catch((e: MarketplaceRouteError) => e);
      expect(error.reason).toBe('no-eligible-offer');
      expect(error.rejections.map((r) => r.reason)).toContain('soft-ceiling');
      const meter = h.buyer.meterState();
      expect(meter?.totalReservedWei).toBe(0n);
      expect(meter?.totalSettledWei).toBe(0n);
    } finally {
      h.cleanup();
    }
  });

  it('voids the reservation when the receipt does not verify against the offer seller address', async () => {
    const h = createHarness();
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      // Poison the discovered offer: the receipt will be signed by the real
      // seller wallet, so verification against this address MUST fail.
      h.offers[0].sellerAddress = new ethers.Wallet(ethers.hexlify(randomBytes(32))).address;
      const attempt = h.buyer.invoke({ serviceType: 'inference', payload: { prompt: 'hi there' }, maxUnits: 100n });
      await expect(attempt).rejects.toBeInstanceOf(MarketplaceInvokeError);
      const error = await attempt.catch((e: MarketplaceInvokeError) => e);
      expect(error.code).toBe('BAD_RECEIPT');
      const meter = h.buyer.meterState();
      expect(meter?.totalReservedWei).toBe(0n);
      expect(meter?.totalSettledWei).toBe(0n);
    } finally {
      h.cleanup();
    }
  });

  it('persists the buyer session key under the node data dir and reloads it', async () => {
    const h = createHarness();
    try {
      const first = h.buyer.ensureSessionKey();
      const reloaded = new MarketplaceBuyerService({
        messenger: h.buyerEndpoint.messenger,
        chain: h.buyerChain,
        resolveBuyerAddress: async () => h.buyerWallet.address,
        offerSource: { discoverOffers: async () => [] },
        log: silentLog(),
        sessionKeyPath: h.sessionKeyPath,
      }).ensureSessionKey();
      expect(reloaded.address).toBe(first.address);
      expect(reloaded.privateKey).toBe(first.privateKey);
    } finally {
      h.cleanup();
    }
  });
});
