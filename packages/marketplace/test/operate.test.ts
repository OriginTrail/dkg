// SPDX-License-Identifier: Apache-2.0
/**
 * The seller's Operate views against MockChainAdapter's marketplace, on a
 * clock the tests set: its epoch, gate, score and wallets, its offerings with
 * their backends' state and prices, the next epoch's price set ahead while
 * this one's stays frozen and refused once that epoch has started, landing
 * now, the epoch's ledger and next landing, its batches, and its ended epochs'
 * pool and gross.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  SERVICE_CLASS_INFERENCE,
  marketplaceChainOf,
  signServiceRequest,
  type EpochTimes,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import {
  DEFAULT_LANDING,
  MarketplaceRefusal,
  Seller,
  UpstreamError,
  gateView,
  landNowView,
  nextLandingAt,
  requestToWire,
  sellerStatusView,
  serviceIdOf,
  setNextPriceView,
  type Completion,
  type Connector,
} from '../src/index.js';

const SELLER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const SESSION = new ethers.Wallet(`0x${'33'.repeat(32)}`);
const BUYER = ethers.getAddress(`0x${'b1'.repeat(20)}`);
const MODEL = 'urn:test:model:operate';
const A = serviceIdOf(MODEL);
const PRICE = 10n;
const HOUR = 3_600;
const EPOCH = 30 * 86_400;
const BODY = { messages: [{ role: 'user' as const, content: 'synthetic question' }], max_tokens: 50 };

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
let subscriptionId: string;
let clock: number;
let next: Completion | Error;

const backend: Connector = {
  kind: 'openai',
  async complete() {
    if (next instanceof Error) throw next;
    return next;
  },
};

async function started(): Promise<Seller> {
  const seller = new Seller({
    chain, dir, signer: SELLER.address, peerId: 'seller-peer', wallets: [SELLER.address], stopServingSeconds: 180, tickSeconds: 300,
    services: [{ model: MODEL, serviceId: A, pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed', connector: backend }],
  });
  await seller.load();
  await seller.tick();
  return seller;
}

async function serve(seller: Seller, n: number, from = 0): Promise<string[]> {
  const { now } = await chain.getEpochTimes();
  const codes = [];
  for (let i = 0; i < n; i++) {
    const request: ServiceRequest = {
      subscriptionId, serviceId: A, seller: seller.gate.identityId, nonce: BigInt(from + i), pricePerUnit: PRICE,
      maxUnits: 1_000n, maxValueWei: 10_000n, issuedAt: now, expiry: now + 600,
    };
    const answer = await seller.serve({ request: requestToWire(request), signature: signServiceRequest(SESSION.privateKey, domain, request), body: BODY });
    codes.push(answer.ok ? 'ok' : answer.code);
  }
  return codes;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-operate-'));
  mock = new MockChainAdapter('mock:31337', SELLER.address);
  mock.setMockACKSigner(SELLER);
  await mock.ensureProfile();
  chain = marketplaceChainOf(mock)!;
  const real = chain.getEpochTimes.bind(chain);
  vi.spyOn(chain, 'getEpochTimes').mockImplementation(async (): Promise<EpochTimes> => {
    const t = await real();
    return { ...t, now: t.startsAt + clock };
  });
  domain = (await chain.getMarketplaceContracts()).requestDomain;
  next = { content: 'synthetic answer', promptTokens: 12, completionTokens: 8 };
  clock = HOUR;
  const { epoch } = await chain.getEpochTimes();
  await chain.approveServiceSubscriptionsWallet(10n ** 24n, { from: BUYER });
  subscriptionId = (await chain.fundFromWallet({
    epoch, sessionKey: SESSION.address, planDigest: ethers.ZeroHash,
    budgets: [{ serviceId: A, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 6n, maxPricePerUnit: 100n }],
  }, { from: BUYER })).subscriptionId;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('Operate', () => {
  it('shows the epoch, the gate, the score, the wallets and the offerings, and sets the next epoch\'s price while this one\'s stays frozen', async () => {
    const seller = await started();
    const status = await sellerStatusView(seller);
    const { epoch, startsAt, endsAt } = await chain.getEpochTimes();
    expect(status).toMatchObject({
      identityId: Number(seller.gate.identityId),
      epoch,
      startsAt,
      endsAt,
      gate: { profile: true, shardingTable: true, stakeTrac: '50000.0', minimumStakeTrac: '50000.0' },
      scoredThisEpoch: true,
      wallets: [{ address: SELLER.address, ethEther: '100.0' }],
      offerings: [{ serviceId: A, connector: 'up', price: '10', nextPrice: '10' }],
      ledger: { served: 0, sent: 0, landed: 0, refused: 0, missed: 0, heldValue: '0', landedValue: '0', counted: '0' },
      batches: [],
      thisEpoch: { servedValue: '0', weightedValue: '0' },
      ended: [],
      lastLanding: { stopped: 'not-due' },
    });
    // The next landing time: two hours from the epoch's start.
    expect(status.nextLandingAt - (await chain.getEpochTimes()).startsAt).toBe(2 * HOUR);

    expect(await setNextPriceView(seller, A, 25n)).toMatchObject({ serviceId: A, price: '10', nextPrice: '25', nextPriceTrac: ethers.formatEther(25n) });
    await expect(setNextPriceView(seller, `0x${'99'.repeat(32)}`, 1n)).rejects.toBeInstanceOf(MarketplaceRefusal);
    // A call this epoch still pays this epoch's price; the next epoch's is the one set, frozen once it starts.
    expect(await serve(seller, 1)).toEqual(['ok']);
    mock.__advanceEpoch();
    expect(await seller.pricesOf(A)).toEqual({ price: 25n, nextPrice: 10n });
    expect((await chain.getEpochTimes()).epoch).toBe(epoch + 1);
  });

  it('refuses the next price once its epoch has started, and keeps the price that epoch froze', async () => {
    const seller = await started();
    const stale = await chain.getEpochTimes();
    mock.__advanceEpoch();
    expect(await seller.pricesOf(A)).toEqual({ price: PRICE, nextPrice: PRICE });
    // The setting's first read is from before the epoch turned; the read under the prices lock is not.
    vi.mocked(chain.getEpochTimes).mockResolvedValueOnce(stale);
    await expect(seller.setNextPrice(A, 25n)).rejects.toMatchObject({ code: 'EpochStarted', args: [A, String(stale.epoch + 1)] });
    expect(await seller.pricesOf(A)).toEqual({ price: PRICE, nextPrice: PRICE });
    // Set again, it is the new next epoch's.
    await seller.setNextPrice(A, 25n);
    expect(await seller.pricesOf(A)).toEqual({ price: PRICE, nextPrice: 25n });
  });

  it('lands now, lists the batch with its gas, counts it in the ledger and the served value, and shows a failing backend', async () => {
    const seller = await started();
    expect(await serve(seller, 2)).toEqual(['ok', 'ok']);
    clock += 31;
    const landed = await landNowView(seller);
    expect(landed).toMatchObject({ batches: [{ items: 2, value: '400', counted: '400', countedTrac: ethers.formatEther(400n) }], refused: 0, waiting: false });
    expect(landed.batches[0]!.gasUsed).toBeGreaterThan(0);
    expect(landed.batches[0]!.at).toBe((await chain.getEpochTimes()).now);
    expect((await sellerStatusView(seller)).lastLanding).toEqual({
      sent: [{ txHash: landed.batches[0]!.tx, items: 2, value: '400', valueTrac: ethers.formatEther(400n), counted: '400', countedTrac: ethers.formatEther(400n) }],
      refused: 0, waiting: false,
    });
    expect(await landNowView(seller)).toEqual({ batches: [], stopped: 'nothing-ready' });

    next = new UpstreamError('the backend answered 500');
    expect(await serve(seller, 1, 2)).toEqual(['UpstreamError']);
    const status = await sellerStatusView(seller);
    expect(status).toMatchObject({
      offerings: [{ connector: 'down' }],
      ledger: { served: 0, landed: 2, landedValue: '400', counted: '400' },
      batches: [{ tx: landed.batches[0]!.tx, items: 2 }],
      thisEpoch: { servedValue: '400' },
      lastLanding: { stopped: 'nothing-ready' },
    });
    next = { content: 'synthetic answer', promptTokens: 12, completionTokens: 8 };
    expect(await serve(seller, 1, 3)).toEqual(['ok']);
    clock += 31;
    const again = await landNowView(seller);
    // The newest batch first.
    expect((await sellerStatusView(seller))).toMatchObject({ offerings: [{ connector: 'up' }], batches: [{ tx: again.batches[0]!.tx, items: 1 }, { tx: landed.batches[0]!.tx }] });
  });

  it("lists each ended epoch's pool and gross, newest first", async () => {
    const seller = await started();
    await serve(seller, 1);
    clock += 31;
    await landNowView(seller);
    const { epoch } = await chain.getEpochTimes();
    mock.__advanceEpoch();
    clock = HOUR;
    await seller.tick();
    const status = await sellerStatusView(seller);
    const [pool, gross] = [await chain.epochPool(epoch), await chain.queryInferenceGross(epoch, seller.gate.identityId)];
    expect(gross).toBeGreaterThan(0n);
    expect(status.ended).toEqual([{ epoch, pool: String(pool), poolTrac: ethers.formatEther(pool), gross: String(gross), grossTrac: ethers.formatEther(gross) }]);
    expect(status.ledger).toMatchObject({ served: 0, landed: 0 });
  });

  it('shows a node without an identity as outside the gate', async () => {
    expect(await gateView(chain, 0n)).toMatchObject({ profile: false, shardingTable: false, stake: '0', minimumStakeTrac: '50000.0' });
  });

  it('times the next landing: the next landing time, the last stretch, the final tick', () => {
    const times = { epoch: 1, startsAt: 0, endsAt: EPOCH, now: HOUR };
    expect(nextLandingAt(times, DEFAULT_LANDING, 300)).toBe(2 * HOUR);
    expect(nextLandingAt({ ...times, now: EPOCH - 50 * 60 }, DEFAULT_LANDING, 300)).toBe(EPOCH - 20 * 60);
    expect(nextLandingAt({ ...times, now: EPOCH - 10 * 60 + 1 }, DEFAULT_LANDING, 300)).toBe(EPOCH - 5 * 60);
    expect(nextLandingAt({ ...times, now: EPOCH - 100 }, DEFAULT_LANDING, 300)).toBe(EPOCH - 60);
    expect(nextLandingAt({ ...times, now: EPOCH - 50 * 60 }, { ...DEFAULT_LANDING, lastStretchMinutes: 0 }, 300)).toBe(EPOCH - 60);
    expect(nextLandingAt({ ...times, now: EPOCH - 50 * 60 }, { ...DEFAULT_LANDING, lastStretchMinutes: 0, finalLandingSeconds: 0 }, 300)).toBe(EPOCH);
  });
});
