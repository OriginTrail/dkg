/**
 * OT-RFC-27 marketplace hardening — the adversarial-review fixes:
 *
 *  A. UNDERFUNDED serve admission (zero funding; headroom = funded −
 *     on-chain claimed − local unsubmitted exposure) and the
 *     STALE_AUTHORIZATION batching-window margin.
 *  B. No immediate void on an AMBIGUOUS serve failure (the seller may have
 *     served and will claim): the reservation holds until the authorization
 *     expiry passes, then releases; a definitive dial failure still voids
 *     immediately, and a served-but-unverifiable response settles
 *     pessimistically at the worst case.
 *  C. Receipt trust resolved on-chain: the recovered receipt signer must
 *     resolve (IdentityStorage) to the AUTHORIZED sellerIdentityId; the
 *     offer's RDF sellerAddress is a routing hint only.
 *  D. Replay guard + pending claims persist across a seller restart; a cold
 *     cache consults the contract's consumedAuth view; transient submission
 *     failures requeue; batch reverts bisect to isolate the poisoned claim.
 *  E. Session keys mint on ENOENT only — any other load error rethrows.
 *  F. Authorization expiry derives from CHAIN time, not the wall clock.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
import type { ChainAdapter, ReceiptClaimInput } from '@origintrail-official/dkg-chain';
import {
  computeAuthDigest,
  eip191SignDigest,
  offeringIdFor,
  sessionKeyWallet,
  type AuthorizationFields,
  type MarketplaceOffer,
  type PlanPolicy,
} from '@origintrail-official/dkg-marketplace';
import { Messenger } from '../src/p2p/messenger.js';
import {
  MarketplaceSellerService,
  type MarketplaceMessenger,
  type MarketplaceSellerDeps,
} from '../src/marketplace/seller-service.js';
import {
  MarketplaceBuyerService,
  MarketplaceInvokeError,
} from '../src/marketplace/buyer-service.js';
import { createStubInferenceExecutor, type MarketplaceExecutor } from '../src/marketplace/executors.js';

const TRAC = 10n ** 18n;
const NOW_SECONDS = 1_900_000_000;
const SELLER_IDENTITY = 7n;
const SELLER_PEER = '12D3KooWSellerSellerSellerSellerSellerSellerSell';
const BUYER_PEER = '12D3KooWBuyerBuyerBuyerBuyerBuyerBuyerBuyerBuyer';
const INFERENCE_ASK = 500_000_000_000n; // 0.5 µTRAC per token
const LLM_OFFERING = 'devnet-llm';

type InboundHandler = (data: Uint8Array, peerId: { toString(): string; toBytes(): Uint8Array }) => Promise<Uint8Array>;

interface Endpoint {
  peerId: string;
  messenger: Messenger;
  handlers: Map<string, InboundHandler>;
  remote?: Endpoint;
}

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

/** Serve-transport fault injection around a real messenger pair. */
type ServeFault = 'dial' | 'timeout-after-serve' | undefined;

interface Harness {
  buyerWallet: ethers.Wallet;
  sellerWallet: ethers.Wallet;
  buyerChain: MockChainAdapter;
  sellerChain: MockChainAdapter;
  buyer: MarketplaceBuyerService;
  seller: MarketplaceSellerService;
  buyerEndpoint: Endpoint;
  sellerEndpoint: Endpoint;
  offers: MarketplaceOffer[];
  policy: PlanPolicy;
  dataDir: string;
  setServeFault(fault: ServeFault): void;
  setBuyerNowSeconds(seconds: number): void;
  newSellerService(overrides?: Partial<MarketplaceSellerDeps>): MarketplaceSellerService;
  cleanup(): void;
}

function createHarness(opts: {
  inferenceExecutor?: MarketplaceExecutor;
  sellerStateDir?: boolean;
  receiptSigner?: ethers.Wallet;
  sellerChainOverride?: (chain: MockChainAdapter) => ChainAdapter;
} = {}): Harness {
  const buyerWallet = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
  const sellerWallet = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
  const buyerChain = new MockChainAdapter('mock:31337', buyerWallet.address);
  const sellerChain = new MockChainAdapter('mock:31337', sellerWallet.address);
  sellerChain.__attachMarketplaceState(buyerChain.__marketplaceState());
  sellerChain.seedIdentity(sellerWallet.address, SELLER_IDENTITY);
  buyerChain.seedIdentity(sellerWallet.address, SELLER_IDENTITY);
  buyerChain.__marketplaceState().nowSeconds = BigInt(NOW_SECONDS);

  const buyerEndpoint = makeEndpoint(BUYER_PEER);
  const sellerEndpoint = makeEndpoint(SELLER_PEER);
  buyerEndpoint.remote = sellerEndpoint;
  sellerEndpoint.remote = buyerEndpoint;

  const dataDir = mkdtempSync(join(tmpdir(), 'dkg-marketplace-hardening-'));
  const sellerDeps: MarketplaceSellerDeps = {
    messenger: sellerEndpoint.messenger,
    chain: opts.sellerChainOverride ? opts.sellerChainOverride(sellerChain) : sellerChain,
    receiptSigner: opts.receiptSigner ?? sellerWallet,
    receiptSignerAddress: (opts.receiptSigner ?? sellerWallet).address,
    log: silentLog(),
    now: () => NOW_SECONDS * 1000,
    batching: { maxBatchSize: 100, maxDelayMs: 3_600_000, maxBuyerExposureWei: 1_000_000n * TRAC },
    expiryMarginSeconds: 60,
    ...(opts.sellerStateDir ? { stateDir: join(dataDir, 'marketplace') } : {}),
  };
  const newSellerService = (overrides: Partial<MarketplaceSellerDeps> = {}): MarketplaceSellerService => {
    const service = new MarketplaceSellerService({ ...sellerDeps, ...overrides });
    service.setOfferings([{
      offeringLocalId: LLM_OFFERING,
      offeringId: offeringIdFor(LLM_OFFERING),
      serviceType: 'inference',
      unit: 'token',
      askPerUnitWei: INFERENCE_ASK,
      executor: opts.inferenceExecutor ?? createStubInferenceExecutor(),
    }]);
    service.registerProtocolHandlers();
    return service;
  };
  const seller = newSellerService();

  const offers: MarketplaceOffer[] = [{
    offerId: `urn:dkg:marketplace:offer:${SELLER_PEER}:${LLM_OFFERING}`,
    offeringId: offeringIdFor(LLM_OFFERING),
    serviceType: 'inference',
    unit: 'token',
    askPerUnitWei: INFERENCE_ASK,
    sellerIdentityId: SELLER_IDENTITY,
    sellerPeerId: SELLER_PEER,
    sellerAddress: sellerWallet.address,
  }];

  // Buyer messenger wrapper: injectable serve-transport faults, request-owned
  // delegation otherwise.
  let serveFault: ServeFault;
  const buyerMessenger: MarketplaceMessenger = {
    register: (protocolId, handler) => buyerEndpoint.messenger.register(protocolId, handler),
    sendReliable: (peerId, protocolId, payload, sendOpts) =>
      buyerEndpoint.messenger.sendReliable(peerId, protocolId, payload, sendOpts),
    sendRequestOwned: async (peerId, protocolId, payload, sendOpts) => {
      if (protocolId === PROTOCOL_MARKETPLACE_SERVE && serveFault === 'dial') {
        throw new Error(`the dial request has no valid addresses for peer ${peerId}`);
      }
      if (protocolId === PROTOCOL_MARKETPLACE_SERVE && serveFault === 'timeout-after-serve') {
        // The request REACHES the seller (it serves and enqueues a claim)
        // but the response is lost on the way back.
        await buyerEndpoint.messenger.sendRequestOwned(peerId, protocolId, payload, sendOpts);
        throw new Error('request timed out after 5000ms');
      }
      return buyerEndpoint.messenger.sendRequestOwned(peerId, protocolId, payload, sendOpts);
    },
  };

  let buyerNowSeconds = NOW_SECONDS;
  const buyer = new MarketplaceBuyerService({
    messenger: buyerMessenger,
    chain: buyerChain,
    resolveBuyerAddress: async () => buyerWallet.address,
    offerSource: { discoverOffers: async () => offers },
    log: silentLog(),
    sessionKeyPath: join(dataDir, 'marketplace', 'session-key.json'),
    nowSeconds: () => buyerNowSeconds,
  });

  const policy: PlanPolicy = {
    totalBudgetWei: 10n * TRAC,
    buckets: [{
      match: { serviceType: 'inference' },
      budgetWei: 10n * TRAC,
      priceCapWeiPerUnit: 1_000_000_000_000n,
      maxUnitsPerCall: 10_000_000n,
    }],
  };

  return {
    buyerWallet,
    sellerWallet,
    buyerChain,
    sellerChain,
    buyer,
    seller,
    buyerEndpoint,
    sellerEndpoint,
    offers,
    policy,
    dataDir,
    setServeFault: (fault) => { serveFault = fault; },
    setBuyerNowSeconds: (seconds) => { buyerNowSeconds = seconds; },
    newSellerService,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

/** Hand-crafted serve request bytes (admission probes bypass the router). */
async function craftServeRequest(
  harness: Harness,
  overrides: { fields?: Partial<AuthorizationFields> } = {},
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
  const signer = sessionKeyWallet(harness.buyer.ensureSessionKey());
  const signature = await eip191SignDigest(signer, computeAuthDigest(fields));
  return encodeMarketplaceServeRequest({
    version: MARKETPLACE_SERVE_VERSION,
    buyer: ethers.getBytes(fields.buyer),
    sellerIdentityId: fields.sellerIdentityId.toString(),
    offeringId: ethers.getBytes(fields.offeringId),
    callId: ethers.getBytes(fields.callId),
    epoch: fields.epoch,
    maxUnits: fields.maxUnits,
    askPerUnitWei: fields.askPerUnitWei.toString(),
    expiry: fields.expiry,
    authSignature: ethers.getBytes(signature),
    payloadKind: 'inference',
    payload: new TextEncoder().encode(JSON.stringify({ prompt: 'crafted prompt' })),
  });
}

async function sendCraftedServe(harness: Harness, request: Uint8Array) {
  const sent = await harness.buyerEndpoint.messenger.sendReliable(SELLER_PEER, PROTOCOL_MARKETPLACE_SERVE, request);
  if (!sent.delivered) throw new Error(`crafted serve not delivered: ${'error' in sent ? sent.error : 'unknown'}`);
  return decodeMarketplaceServeResponse(sent.response);
}

/** Fault-injecting chain wrapper: scripted submitReceiptBatch failures. */
function chainWithScriptedSubmitFailures(chain: MockChainAdapter, failures: Array<Error | undefined>): ChainAdapter {
  return new Proxy(chain, {
    get(target, prop) {
      if (prop === 'marketplaceSubmitReceiptBatch') {
        return async (claims: ReceiptClaimInput[]) => {
          const failure = failures.shift();
          if (failure) throw failure;
          return target.marketplaceSubmitReceiptBatch(claims);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as ChainAdapter;
}

describe('A — underfunded refusal + stale-authorization margin', () => {
  it('refuses to serve against an unfunded or 1-wei bucket (UNDERFUNDED, voided immediately)', async () => {
    const h = createHarness();
    try {
      // No subscription at all: zero bucket.
      const unfunded = await sendCraftedServe(h, await craftServeRequest(h));
      expect(unfunded.errorCode).toBe('UNDERFUNDED');

      // A 1-wei bucket must not buy a 64-token authorization either.
      await h.buyer.subscribe({ amountWei: 1n, policy: h.policy, epoch: 1n });
      const attempt = h.buyer.invoke({ serviceType: 'inference', payload: { prompt: 'hello' }, maxUnits: 100n });
      await expect(attempt).rejects.toBeInstanceOf(MarketplaceInvokeError);
      const error = await attempt.catch((e: MarketplaceInvokeError) => e);
      expect(error.code).toBe('UNDERFUNDED');
      expect(error.delivery).toBe('not-served');
      // A definitive refusal voids the reservation immediately.
      const meter = h.buyer.meterState();
      expect(meter?.totalReservedWei).toBe(0n);
      expect(meter?.totalSettledWei).toBe(0n);
    } finally {
      h.cleanup();
    }
  });

  it('counts local unsubmitted exposure against the funded headroom', async () => {
    const servedUnits = 1_400_000n; // 0.7 TRAC per bulk call at the 0.5µ ask
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
      // First call serves 0.7 TRAC and stays UNSUBMITTED in the batcher.
      await h.buyer.invoke({ serviceType: 'inference', payload: { prompt: 'bulk' }, maxUnits: 1_500_000n });
      expect(h.seller.pendingReceiptCount()).toBe(1);
      // Second call's worst case (0.75 TRAC) exceeds the remaining headroom
      // (1 − 0.7 = 0.3 TRAC) even though nothing is claimed on-chain yet.
      const attempt = h.buyer.invoke({ serviceType: 'inference', payload: { prompt: 'bulk' }, maxUnits: 1_500_000n });
      const error = await attempt.catch((e: MarketplaceInvokeError) => e);
      expect(error).toBeInstanceOf(MarketplaceInvokeError);
      expect(error.code).toBe('UNDERFUNDED');
      // Only the first call was served and metered.
      expect(h.seller.pendingReceiptCount()).toBe(1);
      expect(h.buyer.meterState()?.totalSettledWei).toBe(servedUnits * INFERENCE_ASK);
    } finally {
      h.cleanup();
    }
  });

  it('refuses an authorization that cannot outlive the batching window (STALE_AUTHORIZATION)', async () => {
    const h = createHarness();
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      // Valid for 30s, but the margin (60s here) covers flush + batch delay +
      // submit allowance — the claim would expire inside the batcher.
      const response = await sendCraftedServe(h, await craftServeRequest(h, {
        fields: { expiry: BigInt(NOW_SECONDS + 30) },
      }));
      expect(response.errorCode).toBe('STALE_AUTHORIZATION');
      // Properly long-lived authorizations still serve.
      expect((await sendCraftedServe(h, await craftServeRequest(h))).ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe('B — reservation settlement follows delivery knowledge', () => {
  it('holds the reservation on an ambiguous timeout (seller DID serve) and voids only after expiry', async () => {
    const h = createHarness();
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      h.setServeFault('timeout-after-serve');
      const attempt = h.buyer.invoke({ serviceType: 'inference', payload: { prompt: 'hello there' }, maxUnits: 100n });
      const error = await attempt.catch((e: MarketplaceInvokeError) => e);
      expect(error).toBeInstanceOf(MarketplaceInvokeError);
      expect(error.code).toBe('DELIVERY_UNKNOWN');
      expect(error.delivery).toBe('ambiguous');
      // The seller served and holds a claimable receipt — the reservation
      // MUST survive (voiding now would let the claim exceed the meter).
      expect(h.seller.pendingReceiptCount()).toBe(1);
      const worstCase = 100n * INFERENCE_ASK;
      expect(h.buyer.meterState()?.totalReservedWei).toBe(worstCase);
      // Still held while the authorization lives...
      expect(h.buyer.releaseExpiredReservations()).toBe(0);
      expect(h.buyer.meterState()?.totalReservedWei).toBe(worstCase);
      // ...and released once chain time passes the expiry.
      h.setBuyerNowSeconds(NOW_SECONDS + 700);
      expect(h.buyer.releaseExpiredReservations()).toBe(1);
      expect(h.buyer.meterState()?.totalReservedWei).toBe(0n);
      expect(h.buyer.meterState()?.totalSettledWei).toBe(0n);
    } finally {
      h.cleanup();
    }
  });

  it('voids immediately on a definitive dial failure (request provably never sent)', async () => {
    const h = createHarness();
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      h.setServeFault('dial');
      const attempt = h.buyer.invoke({ serviceType: 'inference', payload: { prompt: 'hello there' }, maxUnits: 100n });
      const error = await attempt.catch((e: MarketplaceInvokeError) => e);
      expect(error).toBeInstanceOf(MarketplaceInvokeError);
      expect(error.code).toBe('NOT_DELIVERED');
      expect(error.delivery).toBe('not-served');
      expect(h.seller.pendingReceiptCount()).toBe(0);
      expect(h.buyer.meterState()?.totalReservedWei).toBe(0n);
    } finally {
      h.cleanup();
    }
  });
});

describe('C — receipt signer identity resolved on-chain', () => {
  it('rejects a receipt whose signer does not resolve to the authorized seller identity, settling pessimistically', async () => {
    // The seller signs receipts with a wallet that has NO on-chain identity:
    // verification against the recovered signer fails regardless of what the
    // (unauthenticated) offer advertised.
    const rogueSigner = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
    const h = createHarness({ receiptSigner: rogueSigner });
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      const attempt = h.buyer.invoke({ serviceType: 'inference', payload: { prompt: 'hello there' }, maxUnits: 100n });
      const error = await attempt.catch((e: MarketplaceInvokeError) => e);
      expect(error).toBeInstanceOf(MarketplaceInvokeError);
      expect(error.code).toBe('BAD_RECEIPT');
      expect(error.message).toMatch(/resolves to identity 0/);
      expect(error.delivery).toBe('served');
      // The seller served (ok response) → pessimistic worst-case settle.
      const meter = h.buyer.meterState();
      expect(meter?.totalReservedWei).toBe(0n);
      expect(meter?.totalSettledWei).toBe(100n * INFERENCE_ASK);
      // A signature that does not resolve to the AUTHORIZED identity never
      // reaches that identity's standing (no framing by whoever answered).
      expect(error.sellerFault).toBeUndefined();
      expect(h.buyer.recountSnapshot()).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe('D — durable seller state + submission failure isolation', () => {
  it('persists the replay guard and pending claims across a service restart', async () => {
    const h = createHarness({ sellerStateDir: true });
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      const request = await craftServeRequest(h);
      expect((await sendCraftedServe(h, request)).ok).toBe(true);
      expect(h.seller.pendingReceiptCount()).toBe(1);

      // "Restart": a fresh service over the same state dir replaces the
      // protocol handlers. It must refuse the replay AND restore the claim.
      const restarted = h.newSellerService();
      expect(restarted.pendingReceiptCount()).toBe(1);
      expect((await sendCraftedServe(h, request)).errorCode).toBe('REPLAYED_CALL_ID');

      // The restored claim resubmits (requeued as immediately due).
      const flush = await restarted.flushReceipts();
      expect(flush).toMatchObject({ batches: 1, claims: 1, failedClaims: 0, requeuedClaims: 0 });
      const claim = await h.sellerChain.marketplaceGetSellerClaim(h.buyerWallet.address, 1n, SELLER_IDENTITY);
      expect(claim.claimed).toBeGreaterThan(0n);
    } finally {
      h.cleanup();
    }
  });

  it('a COLD replay cache consults the contract consumedAuth view', async () => {
    const h = createHarness(); // no state dir → cold cache on every restart
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      const request = await craftServeRequest(h);
      expect((await sendCraftedServe(h, request)).ok).toBe(true);
      await h.seller.flushReceipts({ all: true }); // the claim settles on-chain

      // Restart with NOTHING persisted: the local guard is empty, but the
      // on-chain consumedAuth pre-check still refuses the replay.
      const restarted = h.newSellerService();
      expect(restarted.pendingReceiptCount()).toBe(0);
      expect((await sendCraftedServe(h, request)).errorCode).toBe('REPLAYED_CALL_ID');
    } finally {
      h.cleanup();
    }
  });

  it('requeues claims on transient submission failures instead of dropping them', async () => {
    const failures: Array<Error | undefined> = [new Error('fetch failed: socket hang up')];
    const h = createHarness({
      sellerChainOverride: (chain) => chainWithScriptedSubmitFailures(chain, failures),
    });
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      await h.buyer.invoke({ serviceType: 'inference', payload: { prompt: 'hello there' }, maxUnits: 100n });
      expect(h.seller.pendingReceiptCount()).toBe(1);

      const failed = await h.seller.flushReceipts({ all: true });
      expect(failed).toMatchObject({ batches: 0, claims: 0, failedClaims: 0, requeuedClaims: 1 });
      expect(failed.errors).toHaveLength(1);
      expect(h.seller.pendingReceiptCount()).toBe(1); // nothing forfeited

      const retried = await h.seller.flushReceipts({ all: true });
      expect(retried).toMatchObject({ batches: 1, claims: 1, failedClaims: 0, requeuedClaims: 0 });
      const claim = await h.sellerChain.marketplaceGetSellerClaim(h.buyerWallet.address, 1n, SELLER_IDENTITY);
      expect(claim.claimed).toBeGreaterThan(0n);
    } finally {
      h.cleanup();
    }
  });

  it('bisects a reverted batch to isolate the poisoned claim; honest receipts still settle', async () => {
    const h = createHarness();
    try {
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      const invocations = [];
      for (const prompt of ['first call', 'second call', 'third call']) {
        invocations.push(await h.buyer.invoke({ serviceType: 'inference', payload: { prompt }, maxUnits: 100n }));
      }
      expect(h.seller.pendingReceiptCount()).toBe(3);
      // Poison the SECOND claim: its authorization is consumed on-chain (as
      // if a duplicate already settled), so any batch containing it reverts.
      h.buyerChain.__marketplaceState().consumedAuth.add(invocations[1].receipt.authDigest);

      const flush = await h.seller.flushReceipts({ all: true });
      // Bisection lands claims 1 and 3 and drops ONLY the poisoned claim.
      expect(flush).toMatchObject({ claims: 2, failedClaims: 1, requeuedClaims: 0 });
      expect(h.seller.pendingReceiptCount()).toBe(0);
      const claim = await h.sellerChain.marketplaceGetSellerClaim(h.buyerWallet.address, 1n, SELLER_IDENTITY);
      expect(claim.claimed).toBe(invocations[0].costWei + invocations[2].costWei);
    } finally {
      h.cleanup();
    }
  });
});

describe('E — session key file handling', () => {
  it('mints ONLY on ENOENT; any other load failure rethrows and preserves the file', async () => {
    const h = createHarness();
    try {
      const path = join(h.dataDir, 'marketplace', 'session-key.json');
      mkdirSync(join(h.dataDir, 'marketplace'), { recursive: true });
      writeFileSync(path, 'not json at all', { mode: 0o600 });
      expect(() => h.buyer.ensureSessionKey()).toThrow(/refusing to mint a replacement/);
      // The corrupted file is untouched — operator intervention decides.
      expect(readFileSync(path, 'utf8')).toBe('not json at all');

      // ENOENT (fresh node) still mints + persists atomically.
      rmSync(path);
      const minted = h.buyer.ensureSessionKey();
      expect(minted.address).toMatch(/^0x/);
      expect(JSON.parse(readFileSync(path, 'utf8')).address).toBe(minted.address);
    } finally {
      h.cleanup();
    }
  });
});

describe('F — chain-time authorization expiry', () => {
  it('derives expiry from the chain clock, so devnet time-warp does not kill every claim', async () => {
    const h = createHarness();
    try {
      // Chain time races 10 000s ahead of the buyer's wall clock (devnet
      // evm_increaseTime). A wall-clock expiry (now + 600) would already be
      // 9 400s in the chain's past — every serve/claim would be EXPIRED.
      const chainNow = BigInt(NOW_SECONDS + 10_000);
      h.buyerChain.__marketplaceState().nowSeconds = chainNow;
      await h.buyer.subscribe({ amountWei: 10n * TRAC, policy: h.policy, epoch: 1n });
      const invoked = await h.buyer.invoke({ serviceType: 'inference', payload: { prompt: 'hello there' }, maxUnits: 100n });
      expect(invoked.authorization.expiry).toBe(chainNow + 600n);
      // The claim settles: it carries a chain-future expiry.
      const flush = await h.seller.flushReceipts({ all: true });
      expect(flush).toMatchObject({ batches: 1, claims: 1, failedClaims: 0 });
    } finally {
      h.cleanup();
    }
  });
});
