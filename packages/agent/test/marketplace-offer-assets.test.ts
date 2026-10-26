/**
 * OT-RFC-27 marketplace offer Knowledge Assets on a real chain (the shared
 * Hardhat deployment), through the agent's real KA lifecycle:
 *
 *  - the first seller anchors the `marketplace` CG on-chain; a second seller
 *    ADOPTS that anchor instead of registering another graph under the same
 *    name (two registrations split the network: nodes bind different slots,
 *    RFC-64 policy digests diverge and the name's reverse lookup fails
 *    closed — the split that kept sellers from seeing each other's offers);
 *  - a reprice is an on-chain UPDATE of the same offer KA (same UAL, next
 *    version): discovery returns only the new ask, and an unchanged republish
 *    sends no transaction.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { offeringIdFor } from '@origintrail-official/dkg-marketplace';
import type { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import {
  createMarketplaceOfferAssetPort,
  ensureMarketplaceContextGraphAnchor,
  resolveMarketplaceAnchorOnChain,
} from '../src/marketplace/offer-assets.js';
import {
  createContextGraphOfferSource,
  publishMarketplaceOfferings,
} from '../src/marketplace/offer-publisher.js';
import { createStubInferenceExecutor } from '../src/marketplace/executors.js';
import type { MarketplaceSellerOffering } from '../src/marketplace/seller-service.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';
import {
  HARDHAT_KEYS,
  createEVMAdapter,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

const CG = 'marketplace';
const log = { info: () => {}, warn: () => {} };
const agents: DKGAgent[] = [];
let snapshot: string;

beforeAll(async () => {
  snapshot = await takeSnapshot();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(createProvider(), getSharedContext().hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => { await revertSnapshot(snapshot); });
afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best-effort */ }
  }
});

async function startAgent(name: string, chain: EVMChainAdapter, nodeRole: 'core' | 'edge'): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name,
    listenPort: 0,
    chainAdapter: chain,
    nodeRole,
    kaNumberAllocator: makeTestKaNumberAllocator(),
    rfc64CatalogActivation: { enabled: false },
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

function llmOffering(askPerUnitWei: bigint): MarketplaceSellerOffering {
  return {
    offeringLocalId: 'devnet-llm',
    offeringId: offeringIdFor('devnet-llm'),
    serviceType: 'inference',
    unit: 'token',
    askPerUnitWei,
    executor: createStubInferenceExecutor(),
  };
}

describe('marketplace offer Knowledge Assets (on-chain)', () => {
  it('anchors the CG once, lets a second seller adopt it, and updates an offer KA in place', async () => {
    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const sellerA = await startAgent('MarketplaceSellerA', chainA, 'core');
    await installHardhatACKProvider(sellerA, chainA);
    const author = sellerA.defaultAgentAddress!;
    expect(author.toLowerCase()).toBe(new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address.toLowerCase());

    // Nothing anchors the name yet: the first seller registers it.
    expect(await resolveMarketplaceAnchorOnChain(sellerA, chainA)).toBeNull();
    const port = createMarketplaceOfferAssetPort(sellerA, author);
    const seller = { sellerIdentityId: 1n, sellerPeerId: sellerA.peerId, sellerAddress: author };
    const ensureAnchor = () => ensureMarketplaceContextGraphAnchor(sellerA, chainA, log);
    const first = await publishMarketplaceOfferings(port, [llmOffering(800_000_000_000n)], seller, { ensureAnchor });
    const anchored = await resolveMarketplaceAnchorOnChain(sellerA, chainA);
    expect(anchored).not.toBeNull();
    expect(await sellerA.getContextGraphOnChainId(CG)).toBe(anchored!.toString());
    expect(first.assets).toMatchObject([{ outcome: 'published' }]);
    const offers = createContextGraphOfferSource(sellerA);
    expect((await offers.discoverOffers()).map((offer) => offer.askPerUnitWei)).toEqual([800_000_000_000n]);

    // A second seller adopts the existing anchor — it never registers again.
    const chainB = createEVMAdapter(HARDHAT_KEYS.PUBLISHER);
    const sellerB = await startAgent('MarketplaceSellerB', chainB, 'edge');
    const register = vi.spyOn(sellerB, 'registerContextGraph');
    await ensureMarketplaceContextGraphAnchor(sellerB, chainB, log);
    expect(register).not.toHaveBeenCalled();
    expect(await sellerB.getContextGraphOnChainId(CG)).toBe(anchored!.toString());
    // Still exactly one slot behind the name (an ambiguous name would throw).
    expect(await resolveMarketplaceAnchorOnChain(sellerB, chainB)).toBe(anchored);

    // Reprice: an on-chain update of the SAME KA; only the new ask remains.
    const repriced = await publishMarketplaceOfferings(port, [llmOffering(450_000_000_000n)], seller, { ensureAnchor });
    expect(repriced.assets).toMatchObject([{ outcome: 'published', ual: first.assets[0].ual }]);
    expect(BigInt(repriced.assets[0].revision)).toBeGreaterThan(BigInt(first.assets[0].revision));
    const afterUpdate = await offers.discoverOffers();
    expect(afterUpdate.map((offer) => offer.askPerUnitWei)).toEqual([450_000_000_000n]);
    const history = await sellerA.assertion.history(CG, 'marketplace-offer-devnet-llm');
    expect(history?.status).toBe('vm-confirmed');

    // An unchanged republish is a no-op: no lifecycle step, no transaction.
    const publish = vi.spyOn(sellerA, 'publishFromFinalizedAssertion');
    const unchanged = await publishMarketplaceOfferings(port, [llmOffering(450_000_000_000n)], seller, { ensureAnchor });
    expect(unchanged.assets).toMatchObject([{ outcome: 'unchanged', revision: repriced.assets[0].revision }]);
    expect(publish).not.toHaveBeenCalled();
  });
});
