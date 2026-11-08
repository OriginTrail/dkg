// SPDX-License-Identifier: Apache-2.0
/**
 * The catalog views against MockChainAdapter's marketplace, with the offers
 * a stub reads in place of the Marketplace Context Graph: this epoch's
 * services from sellers in the sharding table, with their next prices, last
 * quotes and measured latency, what the subscription covers, one service with
 * a storefront per seller, and one seller's storefront.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, SERVICE_CLASS_INFERENCE, marketplaceChainOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import {
  AccessKeys,
  BuyerStore,
  Gateway,
  MarketplaceRefusal,
  Router,
  catalogView,
  resolveFx,
  sellerView,
  serviceDetailView,
  serviceIdOf,
  type Offer,
} from '../src/index.js';

const NODE = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const A = serviceIdOf('urn:test:model:catalog-a');
const B = serviceIdOf('urn:test:model:catalog-b');
const OTHER = 9n;
const OUTSIDE = 13n;
const FX = { tracUsd: 0.5, source: 'test', asOf: 1 };

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let router: Router;
let gateway: Gateway;
let own: bigint;
let epoch: number;

const offer = (seller: bigint, serviceId: string, pricePerUnit: bigint, at = epoch): Offer => ({
  seller, serviceId, serviceClass: SERVICE_CLASS_INFERENCE, unit: 'token', pricePerUnit, epoch: at, capacity: null,
  model: serviceId === A ? 'urn:test:model:catalog-a' : 'urn:test:model:catalog-b', provenance: 'upstream-claimed',
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-catalog-'));
  mock = new MockChainAdapter('mock:31337', NODE.address);
  await mock.ensureProfile();
  chain = marketplaceChainOf(mock)!;
  own = await chain.getIdentityId();
  ({ epoch } = await chain.getEpochTimes());
  vi.spyOn(chain, 'isShardingTableMember').mockImplementation(async (id) => id !== OUTSIDE);
  const offers = [
    offer(own, A, 10n), offer(own, A, 12n, epoch + 1),
    offer(OTHER, A, 9n), offer(OTHER, A, 8n), offer(OTHER, B, 5n),
    offer(OUTSIDE, A, 1n),
  ];
  router = new Router({
    chain,
    offers: async () => offers,
    quote: async (_peer, services) => ({ seller: String(OTHER), epoch, offers: services.map((serviceId) => ({ serviceId, pricePerUnit: '8', available: true, capacity: null })) }),
    peers: { peerOf: async (id) => (id === OTHER ? 'peer-9' : null) },
  });
  gateway = new Gateway({
    chain, buyerWallet: NODE.address, store: new BuyerStore(dir), router, keys: new AccessKeys(dir), dir,
    send: async () => { throw new Error('not called'); }, fx: FX,
  });
  // The node's subscription funds A this epoch.
  await chain.approveServiceSubscriptionsWallet(10n ** 24n);
  await chain.fundFromWallet({
    epoch, sessionKey: ethers.Wallet.createRandom().address, planDigest: ethers.ZeroHash,
    budgets: [{ serviceId: A, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 6n, maxPricePerUnit: 100n }],
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the catalog', () => {
  it("lists this epoch's services of sellers in the sharding table, cheapest first, with what the subscription covers", async () => {
    // A quote and a measured call for the other seller.
    expect(await router.pick(A, epoch, 100n)).toMatchObject({ seller: OTHER });
    router.measured(OTHER, 120);
    const catalog = await catalogView(gateway);
    expect(catalog).toMatchObject({ epoch, fx: FX });
    expect(catalog.services.map((s) => s.serviceId)).toEqual([A, B].sort());
    const a = catalog.services.find((s) => s.serviceId === A)!;
    expect(a).toEqual({
      serviceId: A, serviceClass: 'inference', label: 'urn:test:model:catalog-a',
      offers: [
        {
          serviceId: A, seller: Number(OTHER), epoch, unit: 'token', pricePerUnit: '8', pricePerUnitTrac: ethers.formatEther(8n), provenance: 'upstream-claimed',
          available: true, quotedAt: expect.any(Number), measured: { latencyMs: 120, tokensPerSecond: null },
        },
        {
          serviceId: A, seller: Number(own), epoch, unit: 'token', pricePerUnit: '10', pricePerUnitTrac: ethers.formatEther(10n),
          nextPricePerUnit: '12', nextPricePerUnitTrac: ethers.formatEther(12n), provenance: 'upstream-claimed',
          available: null, measured: { latencyMs: null, tokensPerSecond: null },
        },
      ],
      priceMin: '8', priceMinTrac: ethers.formatEther(8n), priceMax: '10', priceMaxTrac: ethers.formatEther(10n),
      covered: { left: String(10n ** 6n), leftTrac: ethers.formatEther(10n ** 6n) },
    });
    expect(catalog.services.find((s) => s.serviceId === B)).not.toHaveProperty('covered');
    // No subscription, nothing covered.
    vi.spyOn(chain, 'subscriptionExists').mockResolvedValue(false);
    expect((await catalogView(gateway)).services.every((s) => !('covered' in s))).toBe(true);
  });

  it('shows one service with a storefront per seller, and refuses one nobody offers', async () => {
    const detail = await serviceDetailView(gateway, A.toUpperCase().replace('0X', '0x'));
    expect(detail).toMatchObject({ serviceId: A, fx: FX, priceMin: '8' });
    expect(detail.sellers.map((s) => s.identityId)).toEqual([Number(OTHER), Number(own)]);
    await expect(serviceDetailView(gateway, `0x${'99'.repeat(32)}`)).rejects.toBeInstanceOf(MarketplaceRefusal);
  });

  it("shows a seller's gate, offers and recent served value, and refuses an identity with no profile and no offers", async () => {
    expect(await sellerView(gateway, own)).toEqual({
      identityId: Number(own),
      gate: { profile: true, shardingTable: true, stake: expect.any(String), stakeTrac: expect.any(String), minimumStake: expect.any(String), minimumStakeTrac: expect.any(String) },
      stakeFactor18: String(10n ** 18n),
      available: null,
      offers: [expect.objectContaining({ serviceId: A, pricePerUnit: '10', nextPricePerUnit: '12' })],
      recent: [{ epoch, servedValue: '0', servedValueTrac: '0.0', weightedValue: '0', weightedValueTrac: '0.0' }],
    });
    await router.pick(A, epoch, 100n);
    expect((await sellerView(gateway, OTHER)).available).toBe(true);
    // Outside the sharding table: no offers listed.
    expect(await sellerView(gateway, OUTSIDE)).toMatchObject({ gate: { shardingTable: false }, offers: [] });
    vi.spyOn(chain, 'profileExists').mockResolvedValue(false);
    await expect(sellerView(gateway, 77n)).rejects.toBeInstanceOf(MarketplaceRefusal);
  });

  it('takes its reference rate from the settings', () => {
    expect(resolveFx(undefined)).toEqual({ tracUsd: null, source: 'none', asOf: null });
    expect(resolveFx({ fx: { tracUsd: 0.25, asOf: 1_900_000_000 } })).toEqual({ tracUsd: 0.25, source: 'config', asOf: 1_900_000_000 });
    expect(resolveFx({ fx: { source: 'a feed' } })).toEqual({ tracUsd: null, source: 'a feed', asOf: null });
    expect(() => resolveFx({ fx: { tracUsd: -1 } })).toThrow(/tracUsd/);
    expect(() => resolveFx({ fx: { tracUsd: 1, asOf: 1.5 } })).toThrow(/asOf/);
    expect(() => resolveFx({ fx: { source: '' } })).toThrow(/source/);
  });
});
