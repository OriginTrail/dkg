/**
 * OT-RFC-27 marketplace — DKGAgent mixin + lifecycle wiring. A real agent
 * boots with `config.marketplace.enabled` over a `MockChainAdapter`, and the
 * runtime comes up through `startMarketplaceRuntimeV1`: the mixin surface is
 * callable, offer KAs publish through the agent's real Context Graph APIs
 * (`createContextGraph` + `share`), and discovery finds them back via the
 * agent's local SPARQL entry point — the production (non-injected) offer
 * source. A node without the config block stays dormant.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { offeringIdFor } from '@origintrail-official/dkg-marketplace';
import { DKGAgent } from '../src/dkg-agent.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const TRAC = 10n ** 18n;
const agents: DKGAgent[] = [];
afterEach(async () => { await Promise.all(agents.splice(0).map((agent) => agent.stop())); });

describe('marketplace agent wiring', () => {
  it('wires the runtime at start, publishes offer KAs into the CG, and discovers them locally', async () => {
    const wallet = Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    chain.setMockACKSigner(wallet);
    chain.seedIdentity(wallet.address, 7n);
    const agent = await DKGAgent.create({
      name: 'MarketplaceSeller', listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'edge',
      chainAdapter: chain, kaNumberAllocator: makeTestKaNumberAllocator(),
      rfc64CatalogActivation: { enabled: false },
      marketplace: {
        enabled: true,
        seller: {
          offerings: [{
            offeringLocalId: 'devnet-llm',
            serviceType: 'inference',
            unit: 'token',
            askPerUnitWei: 500_000_000_000n,
          }],
        },
      },
    });
    agents.push(agent);
    await agent.start();

    const status = await agent.marketplaceStatus();
    expect(status).toMatchObject({ enabled: true, sellerReady: true, buyerReady: true });
    expect(status.epoch).toBe(1n);
    expect(status.seller?.offerings).toBe(1);

    // Offer publication through the agent's real CG APIs...
    const { published } = await agent.marketplacePublishOfferings();
    expect(published).toEqual([`urn:dkg:marketplace:offer:${agent.peerId}:devnet-llm`]);

    // ...and discovery back through the agent's local SPARQL entry point.
    const offers = await agent.marketplaceDiscoverOffers();
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      offeringId: offeringIdFor('devnet-llm'),
      serviceType: 'inference',
      unit: 'token',
      askPerUnitWei: 500_000_000_000n,
      sellerIdentityId: 7n,
      sellerPeerId: agent.peerId,
      sellerAddress: wallet.address,
    });

    // Buyer surface: subscribe funds the mock bucket under this wallet.
    const subscription = await agent.marketplaceSubscribe({
      amountWei: 2n * TRAC,
      policy: {
        totalBudgetWei: 2n * TRAC,
        buckets: [{
          match: { serviceType: 'inference' },
          budgetWei: 2n * TRAC,
          priceCapWeiPerUnit: 1_000_000_000_000n,
          maxUnitsPerCall: 10_000n,
        }],
      },
    });
    expect(subscription.epoch).toBe(1n);
    const bucket = await chain.marketplaceGetBucket(wallet.address, 1n);
    expect(bucket.funded).toBe(2n * TRAC);
    expect(agent.marketplaceMeter().summary).toContain('remaining 2 TRAC');
  });

  it('stays dormant without the config block', async () => {
    const wallet = Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    chain.setMockACKSigner(wallet);
    const agent = await DKGAgent.create({
      name: 'NoMarketplace', listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'edge',
      chainAdapter: chain, kaNumberAllocator: makeTestKaNumberAllocator(),
      rfc64CatalogActivation: { enabled: false },
    });
    agents.push(agent);
    await agent.start();
    expect(await agent.marketplaceStatus()).toMatchObject({ enabled: false, sellerReady: false, buyerReady: false });
    await expect(agent.marketplaceDiscoverOffers()).rejects.toThrow(/marketplace is not running/);
  });
});
