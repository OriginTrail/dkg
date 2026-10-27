/**
 * OT-RFC-27 marketplace — DKGAgent mixin + lifecycle wiring. A real agent
 * boots with `config.marketplace.enabled` over a `MockChainAdapter`, and the
 * runtime comes up through `startMarketplaceRuntimeV1`: the mixin surface is
 * callable, the first publish anchors the `marketplace` CG on-chain and
 * publishes each offering as its own Knowledge Asset to Verifiable Memory
 * through the agent's real KA lifecycle (a republish of unchanged offerings
 * is a no-op), and discovery finds them back via the agent's local SPARQL
 * entry point — the production (non-injected) offer source. A node without
 * the config block stays dormant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { STUB_WORDS_DIGEST, offeringIdFor } from '@origintrail-official/dkg-marketplace';
import {
  assertionLifecycleUri,
  contextGraphAssertionUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import type { MarketplaceConnectorConfig, MarketplaceOfferingConfig } from '../src/marketplace/config.js';
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
    // A core self-acknowledges its own VM publish on the mock chain; the
    // operational key makes the receipt signer the node's default agent, the
    // author of its offer KAs.
    const agent = await DKGAgent.create({
      name: 'MarketplaceSeller', listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'core',
      chainAdapter: chain, kaNumberAllocator: makeTestKaNumberAllocator(),
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:1', hubAddress: '0x0000000000000000000000000000000000000001',
        operationalKeys: [wallet.privateKey],
      },
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

    // The runtime subscribes every marketplace node to the `marketplace` CG
    // (always-on, like the system CGs) so offer shares from OTHER nodes sync
    // here — a buyer never creates the CG, so without this it sees no offers.
    expect(agent.getSyncContextGraphIds()).toContain('marketplace');

    // Offer publication through the agent's real KA lifecycle: the first
    // publish anchors the CG on-chain, then mints the offer KA in VM...
    const first = await agent.marketplacePublishOfferings();
    expect(first.published).toEqual([`urn:dkg:marketplace:offer:${agent.peerId}:devnet-llm`]);
    expect(first.assets).toMatchObject([{ assetName: 'marketplace-offer-devnet-llm', outcome: 'published' }]);
    expect(await agent.getContextGraphOnChainId('marketplace')).toBe('1');
    const history = await agent.assertion.history('marketplace', 'marketplace-offer-devnet-llm');
    expect(history?.status).toBe('vm-confirmed');
    expect(history?.agentAddress.toLowerCase()).toBe(wallet.address.toLowerCase());

    // ...and a republish of the same offerings adopts the existing anchor
    // (never a second registration) and leaves the unchanged KA alone.
    const again = await agent.marketplacePublishOfferings();
    expect(again.assets).toMatchObject([{ assetName: 'marketplace-offer-devnet-llm', outcome: 'unchanged' }]);
    expect(await chain.resolveContextGraphIdsByNameHashes([agent.contextGraphNameCommitment('marketplace')]))
      .toEqual(new Map([[agent.contextGraphNameCommitment('marketplace'), 1n]]));

    // A node whose store did not keep the offer's lifecycle record (an
    // in-memory store across a restart) still recognises its own confirmed
    // offer in Verifiable Memory: an unchanged republish stays a no-op.
    const author = history!.agentAddress;
    const lostRecords = [
      assertionLifecycleUri('marketplace', author, 'marketplace-offer-devnet-llm'),
      contextGraphAssertionUri('marketplace', author, 'marketplace-offer-devnet-llm'),
    ];
    for (const prefix of lostRecords) {
      await agent.store.deleteBySubjectPrefix(contextGraphMetaUri('marketplace'), prefix);
    }
    expect(await agent.assertion.history('marketplace', 'marketplace-offer-devnet-llm')).toBeNull();
    const afterLoss = await agent.marketplacePublishOfferings();
    expect(afterLoss.assets).toMatchObject([{ outcome: 'unchanged', revision: first.assets[0].revision }]);

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

  it('holds a failing connector offering out of the served set, mounts all-or-nothing, and publishes the chat pin', async () => {
    const wallet = Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    chain.setMockACKSigner(wallet);
    chain.seedIdentity(wallet.address, 7n);
    const llm = { offeringLocalId: 'devnet-llm', serviceType: 'inference' as const, unit: 'token' as const, askPerUnitWei: 500_000_000_000n };
    const chat = (connector: MarketplaceConnectorConfig, extra: Partial<MarketplaceOfferingConfig> = {}): MarketplaceOfferingConfig => ({
      offeringLocalId: 'devnet-chat', serviceType: 'inference', unit: 'token', modelId: 'stub-chat',
      askPerUnitWei: 500_000_000_000n, connector, metering: { tokenizer: { kind: 'stub-words-v1' } }, ...extra,
    });
    const agent = await DKGAgent.create({
      name: 'MarketplaceChatSeller', listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'core',
      chainAdapter: chain, kaNumberAllocator: makeTestKaNumberAllocator(),
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:1', hubAddress: '0x0000000000000000000000000000000000000001',
        operationalKeys: [wallet.privateKey],
      },
      rfc64CatalogActivation: { enabled: false },
      marketplace: {
        enabled: true,
        seller: {
          offerings: [llm, chat({
            kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:18080/v1', upstreamModel: 'stub-chat',
            secretEnvFile: '/nonexistent/dkg-marketplace/llm-stub.env',
          })],
        },
      },
    });
    agents.push(agent);
    await agent.start();

    // Boot mounts in the background: the connector offering is held `failed`, not served, not published.
    await vi.waitFor(async () => {
      expect((await agent.marketplaceConnectorStatus())[0]?.state).toBe('failed');
    });
    const [failed] = await agent.marketplaceConnectorStatus();
    expect(failed).toMatchObject({
      offeringLocalId: 'devnet-chat', kind: 'openai-compatible', modelId: 'stub-chat',
      upstreamOrigin: 'http://127.0.0.1:18080', secretConfigured: true,
      metering: { basis: 'pinned', tokenizerKind: 'stub-words-v1' },
    });
    expect(failed.detail).toContain('secretEnvFile');
    expect((await agent.marketplaceStatus()).seller).toMatchObject({ offerings: 1, connectors: { mounted: 0, failed: 1, mounting: 0 } });
    const published = await agent.marketplacePublishOfferings();
    expect(published.assets.map((asset) => asset.offeringLocalId)).toEqual(['devnet-llm']);

    // All-or-nothing: a set with an unmountable connector throws and the old set stays in force.
    await expect(agent.marketplaceSetOfferings([llm, chat({
      kind: 'codex-oauth', upstreamModel: 'gpt-5-codex', authFile: '/nonexistent/codex-auth.json', acknowledgeSubscriptionScope: true,
    }, { metering: { tokenizer: { kind: 'stub-words-v1' } } })])).rejects.toMatchObject({
      name: 'MarketplaceConnectorMountError', offeringLocalId: 'devnet-chat',
    });
    expect((await agent.marketplaceStatus()).seller?.offerings).toBe(1);

    // A mountable connector (no secret file → no Authorization header; no upstream call at mount).
    const buyer = '0x00000000000000000000000000000000000000Aa';
    const set = await agent.marketplaceSetOfferings([llm, chat(
      { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:18080/v1', upstreamModel: 'stub-chat' },
      { allowedBuyers: [buyer], model: { displayName: 'Stub Chat', contextLength: 32_768n } },
    )]);
    expect(set.assets?.map((asset) => [asset.offeringLocalId, asset.outcome])).toEqual([
      ['devnet-llm', 'unchanged'], ['devnet-chat', 'published'],
    ]);
    const [mounted] = await agent.marketplaceConnectorStatus();
    expect(mounted).toMatchObject({ state: 'mounted', secretConfigured: false, metering: { basis: 'pinned', tokenizerDigest: STUB_WORDS_DIGEST } });
    const offers = await agent.marketplaceDiscoverOffers();
    const offer = offers.find((o) => o.offeringId === offeringIdFor('devnet-chat'));
    expect(offer).toMatchObject({
      modelId: 'stub-chat', apiShape: 'openai-chat/v1', toolTransport: 'native', access: 'restricted',
      metering: { basis: 'pinned', tokenizer: { kind: 'stub-words-v1', digest: STUB_WORDS_DIGEST } },
      model: { provenanceClass: 'upstream-claimed', upstreamModel: 'stub-chat', displayName: 'Stub Chat', contextLength: 32_768n },
    });
    // The allow list itself is never published.
    expect(JSON.stringify(offer, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase()).not.toContain(buyer.toLowerCase());
    expect(agent.marketplaceMeter().recount).toEqual([]);
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
    expect(agent.getSyncContextGraphIds()).not.toContain('marketplace');
  });
});
