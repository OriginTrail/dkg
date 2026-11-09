// SPDX-License-Identifier: Apache-2.0
/**
 * An account owner's actions through the node, and the buyer's consent,
 * against MockChainAdapter's marketplace: the node's primary wallet owns the
 * account, and the buyer wallet is the primary itself or a second node wallet.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, hashBuyerGrant, marketplaceChainOf, recoverSigner, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import {
  Buyer,
  BuyerStore,
  addBuyer,
  buyerConsent,
  refusalOf,
  removeBuyer,
  setBuyerLimits,
  setServiceSpending,
} from '../src/index.js';

const TRAC = 10n ** 18n;
const DAY = 86_400;
const OWNER = ethers.getAddress(`0x${'0e'.repeat(20)}`);
// The mock signs typed data only as its ACK signer: the node's second wallet, the buyer.
const SECOND = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const OUTSIDER = new ethers.Wallet(`0x${'44'.repeat(32)}`);

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let accountId: bigint;

function buyerFor(buyerWallet: string, nodeWallets: string[] = [OWNER, SECOND.address]): Buyer {
  return new Buyer({
    chain,
    store: new BuyerStore(dir),
    config: { enabled: true, buyerWallet, prefundLeadSeconds: 7_200, tickSeconds: 300 },
    nodeWallets,
  });
}

async function refusal(promise: Promise<unknown>) {
  return promise.then(() => null, (err: unknown) => refusalOf(err));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-accounts-'));
  mock = new MockChainAdapter('mock:31337', OWNER);
  mock.setMockACKSigner(SECOND);
  chain = marketplaceChainOf(mock)!;
  ({ accountId } = await mock.createPublishingConvictionAccount(120_000n * TRAC));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("an account owner's actions", () => {
  it('opts in, then adds the primary as its own buyer with two empty signatures', async () => {
    const buyer = buyerFor(OWNER);
    await setServiceSpending(buyer, accountId, true);
    expect((await chain.getServiceSpending(accountId)).owner).toBe(OWNER);
    const send = vi.spyOn(chain, 'addBuyer');
    const { now } = await chain.getEpochTimes();
    await addBuyer(buyer, accountId, { maxCostPerEpoch: 100n * TRAC, expiresAt: now + 30 * DAY });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ buyer: OWNER, nonce: 0n }), '0x', '0x', { from: OWNER });
    expect(await chain.getGrant(accountId, OWNER)).toMatchObject({ maxCostPerEpoch: 100n * TRAC, owner: OWNER });
  });

  it('adds a second node wallet with its signed consent, sets its limits and removes it', async () => {
    const buyer = buyerFor(SECOND.address);
    await setServiceSpending(buyer, accountId, true);
    const { now } = await chain.getEpochTimes();
    await addBuyer(buyer, accountId, { maxCostPerEpoch: 100n * TRAC, expiresAt: now + 30 * DAY });
    expect(await chain.getAccountBuyers(accountId)).toEqual([SECOND.address]);

    await setBuyerLimits(buyer, accountId, SECOND.address, { maxCostPerEpoch: 200n * TRAC, expiresAt: now + 60 * DAY });
    expect((await chain.getGrant(accountId, SECOND.address))!.maxCostPerEpoch).toBe(200n * TRAC);
    await removeBuyer(buyer, accountId, SECOND.address);
    expect((await chain.getGrant(accountId, SECOND.address))!.revokedAt).toBeGreaterThan(0);
  });

  it('adds an outside buyer only with its signature', async () => {
    const buyer = buyerFor(SECOND.address);
    await setServiceSpending(buyer, accountId, true);
    const { now } = await chain.getEpochTimes();
    const limits = { maxCostPerEpoch: 100n * TRAC, expiresAt: now + 30 * DAY };
    expect(await refusal(addBuyer(buyer, accountId, { ...limits, buyer: OUTSIDER.address })))
      .toEqual({ code: 'ConsentMissing', args: [OUTSIDER.address] });

    const { grantDomain } = await chain.getMarketplaceContracts();
    const digest = hashBuyerGrant(grantDomain, { accountId, buyer: OUTSIDER.address, ...limits, nonce: 0n });
    const signature = ethers.Signature.from(OUTSIDER.signingKey.sign(digest)).compactSerialized;
    await addBuyer(buyer, accountId, { ...limits, buyer: OUTSIDER.address, buyerSignature: signature });
    expect(await chain.getAccountBuyers(accountId)).toEqual([OUTSIDER.address]);
  });

  it('refuses an account the node does not own, and one that does not exist', async () => {
    const buyer = buyerFor(SECOND.address, [SECOND.address]);
    expect(await refusal(setServiceSpending(buyer, accountId, true))).toEqual({ code: 'NotAccountOwner', args: [String(accountId), OWNER] });
    expect(await refusal(removeBuyer(buyer, 99n, SECOND.address))).toEqual({ code: 'ERC721NonexistentToken', args: ['99'] });
  });
});

describe("the buyer's consent", () => {
  it('signs the grant terms at the current nonce for the owner to send', async () => {
    const buyer = buyerFor(SECOND.address);
    const { now } = await chain.getEpochTimes();
    const consent = await buyerConsent(buyer, accountId, { maxCostPerEpoch: 100n * TRAC, expiresAt: now + 30 * DAY });
    expect(consent.terms).toEqual({
      accountId: String(accountId), buyer: SECOND.address, maxCostPerEpoch: String(100n * TRAC), expiresAt: now + 30 * DAY, nonce: '0',
    });
    expect(ethers.getBytes(consent.buyerSignature)).toHaveLength(64);
    expect(recoverSigner(consent.digest, consent.buyerSignature)).toBe(SECOND.address);

    // The owner sends it with its own consent by sending.
    await chain.setServiceSpending(accountId, true);
    await chain.addBuyer({ accountId, buyer: SECOND.address, maxCostPerEpoch: 100n * TRAC, expiresAt: now + 30 * DAY, nonce: 0n }, '0x', consent.buyerSignature);
    expect(await chain.getAccountBuyers(accountId)).toEqual([SECOND.address]);
    await expect(buyerConsent(buyer, 99n, { maxCostPerEpoch: 1n, expiresAt: now + DAY })).rejects.toMatchObject({ code: 'ERC721NonexistentToken' });
  });
});
