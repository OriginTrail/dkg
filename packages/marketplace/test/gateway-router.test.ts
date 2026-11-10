// SPDX-License-Identifier: Apache-2.0
/**
 * The router's demotion of a seller that refuses a call for good: behind
 * every other seller for ten minutes, still tried when no other can serve.
 * And a call with tools among sellers that take them and sellers that do not:
 * which it goes to, in what order, and when it is told none takes them.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { requestDomain, type MarketplaceContracts } from '@origintrail-official/dkg-chain';
import { QUOTES_PER_PICK, Router, hashServiceOffer, serviceIdOf, type ServiceOffer } from '../src/index.js';

const MODEL = 'urn:test:model:router-demotion';
const SERVICE = serviceIdOf(MODEL);

describe('a seller that refuses for good', () => {
  const domain = requestDomain(31337, ethers.Wallet.createRandom().address);
  const wallets = new Map<bigint, ethers.HDNodeWallet>([[1n, ethers.Wallet.createRandom()], [2n, ethers.Wallet.createRandom()]]);
  const offer = (seller: bigint, price: bigint): ServiceOffer => {
    const unsigned = {
      seller, serviceId: SERVICE, serviceClass: 1, unit: 'token' as const, model: MODEL, provenance: 'upstream-claimed' as const, capacity: null,
      peerId: `peer-${seller}`, pricePerUnit: price, priceEpoch: 1, validUntilEpoch: 12, withdrawn: false, signedAt: 1,
    };
    return { ...unsigned, signature: wallets.get(seller)!.signingKey.sign(hashServiceOffer(domain, unsigned)).serialized };
  };

  it('goes behind every other seller for ten minutes, and serves when no other can', async () => {
    let clock = 0;
    let list = [offer(1n, 10n), offer(2n, 20n)];
    const router = new Router({
      chain: {
        isShardingTableMember: async () => true,
        getMarketplaceContracts: async () => ({ requestDomain: domain }) as MarketplaceContracts,
        getIdentityIdForAddress: async (address) => [...wallets].find(([, w]) => w.address === address)?.[0] ?? 0n,
      },
      offers: async () => list,
      quote: async (peer, services) => ({
        seller: peer.slice(5), epoch: 1,
        offers: services.map((s) => ({ serviceId: s, pricePerUnit: peer === 'peer-1' ? '10' : '20', available: true, capacity: null })),
      }),
      clock: () => clock,
    });
    expect(await router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 1n });
    router.demote(1n);
    expect(await router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 2n });
    // Alone, it still serves.
    list = [offer(1n, 10n)];
    expect(await router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 1n });
    // Ten minutes on, it is back in its place.
    list = [offer(1n, 10n), offer(2n, 20n)];
    router.demote(1n);
    clock += 10 * 60_000;
    expect(await router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 1n });
  });
});

describe('a call with tools among sellers that take them and sellers that do not', () => {
  const domain = requestDomain(31337, ethers.Wallet.createRandom().address);
  const wallets = new Map<bigint, ethers.HDNodeWallet>();
  /** Seller `n` at price `n`: the lower the number, the earlier the router asks it. */
  const offer = (seller: bigint): ServiceOffer => {
    if (!wallets.has(seller)) wallets.set(seller, ethers.Wallet.createRandom());
    const unsigned = {
      seller, serviceId: SERVICE, serviceClass: 1, unit: 'token' as const, model: MODEL, provenance: 'upstream-claimed' as const, capacity: null,
      peerId: `peer-${seller}`, pricePerUnit: seller, priceEpoch: 1, validUntilEpoch: 12, withdrawn: false, signedAt: 1,
    };
    return { ...unsigned, signature: wallets.get(seller)!.signingKey.sign(hashServiceOffer(domain, unsigned)).serialized };
  };

  /** A router over sellers 1..`count`; those in `tools` take tool calls, those in `down` do not answer; `asked` counts quotes. */
  function routerOf(count: number, tools: Set<bigint>, down = new Set<bigint>()) {
    const offers = Array.from({ length: count }, (_, i) => offer(BigInt(i + 1)));
    const asked: bigint[] = [];
    const router = new Router({
      chain: {
        isShardingTableMember: async () => true,
        getMarketplaceContracts: async () => ({ requestDomain: domain }) as MarketplaceContracts,
        getIdentityIdForAddress: async (address) => [...wallets].find(([, w]) => w.address === address)?.[0] ?? 0n,
      },
      offers: async () => offers,
      quote: async (peer, services) => {
        const seller = BigInt(peer.slice(5));
        asked.push(seller);
        if (down.has(seller)) throw new Error('unreachable');
        return {
          seller: seller.toString(), epoch: 1,
          offers: services.map((s) => ({ serviceId: s, pricePerUnit: seller.toString(), available: true, capacity: null, ...(tools.has(seller) ? { tools: true } : {}) })),
        };
      },
    });
    return { router, asked };
  }

  it('reads past cheaper sellers that take no tools, even with no quote kept, and a text call still goes to the cheapest', async () => {
    const { router, asked } = routerOf(4, new Set([4n]));
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toMatchObject({ route: { seller: 4n } });
    expect(asked).toEqual([1n, 2n, 3n, 4n]);
    expect(await router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 4n });
    // The seller it stays with takes tools; a text call with no seller kept goes to the cheapest.
    const text = routerOf(4, new Set([4n]));
    expect(await text.router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 1n });
  });

  it('skips the seller it stays with when that one takes no tools, and goes back to it for text', async () => {
    const { router } = routerOf(3, new Set([3n]));
    expect(await router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 1n });
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toMatchObject({ route: { seller: 3n } });
  });

  it('puts a seller whose kept quote takes tools ahead of cheaper ones that do not, once their quotes are kept', async () => {
    // More cheaper sellers without tools than one pick reads: the first pick stops short of the one that takes them.
    const count = QUOTES_PER_PICK + 2;
    const { router, asked } = routerOf(count, new Set([BigInt(count)]));
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'no_seller' });
    expect(asked).toHaveLength(QUOTES_PER_PICK);
    // Their quotes kept say they take none, so they go behind the rest: the next pick reaches the one that does.
    asked.length = 0;
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toMatchObject({ route: { seller: BigInt(count) } });
    expect(asked).toEqual([BigInt(QUOTES_PER_PICK + 1), BigInt(count)]);
  });

  it('says none takes tools only once every seller said so, and not while one that may is unreachable', async () => {
    expect(await routerOf(3, new Set()).router.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'tools_unsupported' });
    expect(await routerOf(3, new Set([2n]), new Set([2n])).router.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'no_seller' });
    // A text call is served by any of them.
    expect(await routerOf(3, new Set()).router.pickFor(SERVICE, 1, 100n)).toMatchObject({ route: { seller: 1n } });
  });
});
