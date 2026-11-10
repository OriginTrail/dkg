// SPDX-License-Identifier: Apache-2.0
/**
 * The router's demotion of a seller that refuses a call for good: behind
 * every other seller for ten minutes, still tried when no other can serve.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { requestDomain, type MarketplaceContracts } from '@origintrail-official/dkg-chain';
import { Router, hashServiceOffer, serviceIdOf, type ServiceOffer } from '../src/index.js';

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
