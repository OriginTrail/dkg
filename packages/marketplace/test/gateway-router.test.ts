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

  /**
   * A router over sellers 1..`count`; those in `tools` take tool calls, those in `down` do not answer, and those in
   * `unavailable` answer that they cannot serve now; `asked` counts quotes.
   */
  function routerOf(count: number, tools: Set<bigint>, down = new Set<bigint>(), clock?: () => number, unavailable = new Set<bigint>()) {
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
          offers: services.map((s) => ({
            serviceId: s, pricePerUnit: seller.toString(), available: !unavailable.has(seller), capacity: null, ...(tools.has(seller) ? { tools: true } : {}),
          })),
        };
      },
      ...(clock ? { clock } : {}),
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

  it('reaches a demoted seller that takes tools past twelve that do not, once their quotes are kept: kept ones are not searched', async () => {
    // The one that takes tools is the cheapest, but a refusal for good put it behind every other.
    const { router, asked } = routerOf(QUOTES_PER_PICK + 1, new Set([1n]));
    router.demote(1n);
    // The first pick asks the twelve ahead of it and stops at the bound: no route for now, not "none takes tools".
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'no_seller' });
    expect(asked).toHaveLength(QUOTES_PER_PICK);
    expect(asked).not.toContain(1n);
    // Their kept quotes say they take none, so the next pick does not search them, and asks the one that does.
    asked.length = 0;
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toMatchObject({ route: { seller: 1n } });
    expect(asked).toEqual([1n]);
    // A text call still goes past the demoted seller, to the cheapest of the others.
    expect(await router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 2n });
  });

  it('says none takes tools only once every seller said so, and not while one that may is unreachable', async () => {
    expect(await routerOf(3, new Set()).router.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'tools_unsupported' });
    expect(await routerOf(3, new Set([2n]), new Set([2n])).router.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'no_seller' });
    // A text call is served by any of them.
    expect(await routerOf(3, new Set()).router.pickFor(SERVICE, 1, 100n)).toMatchObject({ route: { seller: 1n } });
  });

  it('is no route for now, not "none takes tools", while the seller that takes them cannot serve: from new quotes, from kept ones, and with none available', async () => {
    // Seller 1 serves, without tools; seller 2 takes tools, but answers that it cannot serve now.
    const { router, asked } = routerOf(2, new Set([2n]), new Set(), undefined, new Set([2n]));
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'no_seller' });
    expect(asked).toEqual([1n, 2n]);
    // At once again, from the quotes kept: the same, and nothing asked.
    asked.length = 0;
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'no_seller' });
    expect(asked).toEqual([]);
    // A text call goes to the one that serves.
    expect(await router.pick(SERVICE, 1, 100n)).toMatchObject({ seller: 1n });
    // No seller can serve now: no route for now, with tools or without.
    const none = routerOf(2, new Set([2n]), new Set(), undefined, new Set([1n, 2n])).router;
    expect(await none.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'no_seller' });
    expect(await none.pickFor(SERVICE, 1, 100n)).toEqual({ route: null, reason: 'no_seller' });
  });

  it('stays no route for now while a seller that may take tools is held out after its quote failed, and goes to it once it is back', async () => {
    let clock = 0;
    const down = new Set([2n]);
    const { router, asked } = routerOf(2, new Set([2n]), down, () => clock);
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'no_seller' });
    // At once again: seller 2 is held out for ten minutes, not asked, and may still take tools.
    asked.length = 0;
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toEqual({ route: null, reason: 'no_seller' });
    expect(asked).not.toContain(2n);
    // Ten minutes on, it answers, and serves the call.
    down.clear();
    clock += 10 * 60_000;
    expect(await router.pickFor(SERVICE, 1, 100n, { tools: true })).toMatchObject({ route: { seller: 2n } });
  });
});
