// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace on MockChainAdapter (mock-adapter-marketplace.ts): fundings
 * from a wallet and from an account, top-ups, grants and receipt batches, with
 * the contracts' refusals as decoded reverts (`err.revert.name`), as the EVM
 * adapter throws them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '../src/mock-adapter.js';
import {
  SERVICE_CLASS_INFERENCE,
  SERVICE_CLASS_QUERY,
  hashBuyerGrant,
  hashQueryInferenceReceipt,
  hashServiceRequest,
  receiptBatchFaultOf,
  receiptItemOf,
  receiptsDigest,
  recoverSigner,
  signServiceRequest,
  subscriptionIdOf,
  type ServiceBudget,
  type ServiceRequest,
} from '../src/marketplace.js';

const TRAC = 10n ** 18n;
const DAY = 86_400;
const SIGNER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const SESSION = new ethers.Wallet(`0x${'33'.repeat(32)}`);
const SERVICE_A = `0x${'0a'.repeat(32)}`;
const SERVICE_B = `0x${'0b'.repeat(32)}`;
const PLAN = ethers.keccak256('0x01');

const budget = (serviceId: string, value: bigint, serviceClass = SERVICE_CLASS_INFERENCE): ServiceBudget =>
  ({ serviceId, serviceClass, value, maxPricePerUnit: 10n ** 9n });

/** The decoded name of the revert `promise` rejects with. */
async function revertName(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(() => undefined, (e: unknown) => e as { revert?: { name?: string } });
  return err?.revert?.name;
}

let chain: MockChainAdapter;

beforeEach(() => {
  chain = new MockChainAdapter('mock:31337', SIGNER.address);
  chain.setMockACKSigner(SIGNER);
});

describe('mock marketplace: wallet subscriptions', () => {
  it('funds the current epoch under the allowance, once per buyer and epoch, and tops up', async () => {
    const { epoch, startsAt, endsAt } = await chain.getEpochTimes();
    expect(endsAt - startsAt).toBe(30 * DAY);
    const request = { epoch, sessionKey: SESSION.address, planDigest: PLAN, budgets: [budget(SERVICE_A, 100n * TRAC)] };

    expect(await revertName(chain.fundFromWallet(request))).toBe('ERC20InsufficientAllowance');
    await chain.approveServiceSubscriptionsWallet(150n * TRAC);
    const funded = await chain.fundFromWallet(request);
    expect(funded).toMatchObject({ subscriptionId: subscriptionIdOf(SIGNER.address, epoch), value: 100n * TRAC, cost: 100n * TRAC, success: true });
    expect(await chain.getServiceSubscriptionsWalletAllowance(SIGNER.address)).toBe(50n * TRAC);
    expect(await revertName(chain.fundFromWallet(request))).toBe('SubscriptionAlreadyFunded');
    expect(await chain.fundingIn(epoch)).toEqual({ wallet: 100n * TRAC, account: 0n });

    const s = await chain.getSubscription(funded.subscriptionId);
    expect(s).toMatchObject({ accountId: 0n, buyer: SIGNER.address, sessionKey: SESSION.address, epoch, endsAt, value: 100n * TRAC });
    expect(s!.startsAt).toBeGreaterThanOrEqual(startsAt);

    const topUp = await chain.topUpFromWallet(funded.subscriptionId, [budget(SERVICE_A, 10n * TRAC), budget(SERVICE_B, 20n * TRAC, SERVICE_CLASS_QUERY)], PLAN);
    expect(topUp).toMatchObject({ value: 30n * TRAC, cost: 30n * TRAC });
    expect((await chain.getBudgets(funded.subscriptionId)).map((b) => b.value)).toEqual([110n * TRAC, 20n * TRAC]);
    expect(await chain.budgetLeft(funded.subscriptionId, 1)).toBe(20n * TRAC);
    expect(await revertName(chain.topUpFromWallet(funded.subscriptionId, [{ ...budget(SERVICE_A, TRAC), maxPricePerUnit: 1n }], PLAN)))
      .toBe('BudgetTermsChanged');
  });

  it('refuses what the funding rules refuse', async () => {
    const { epoch } = await chain.getEpochTimes();
    await chain.approveServiceSubscriptionsWallet(1_000n * TRAC);
    const base = { epoch, sessionKey: SESSION.address, planDigest: PLAN, budgets: [budget(SERVICE_A, TRAC)] };
    expect(await revertName(chain.fundFromWallet({ ...base, sessionKey: ethers.ZeroAddress }))).toBe('ZeroSessionKey');
    expect(await revertName(chain.fundFromWallet({ ...base, epoch: epoch + 2 }))).toBe('InvalidFundingRequest');
    expect(await revertName(chain.fundFromWallet({ ...base, budgets: [budget(SERVICE_B, TRAC), budget(SERVICE_A, TRAC)] }))).toBe('InvalidFundingRequest');
    expect(await revertName(chain.topUpFromWallet(ethers.ZeroHash, [budget(SERVICE_A, TRAC)], PLAN))).toBe('SubscriptionNotFound');
  });
});

describe('mock marketplace: Conviction Account subscriptions', () => {
  it('opts in, adds the buyer, prefunds the next epoch at the discount, tops up, and removes the buyer', async () => {
    const { accountId } = await chain.createPublishingConvictionAccount(50_000n * TRAC);
    const { epoch, endsAt, now } = await chain.getEpochTimes();
    const terms = { accountId, buyer: SIGNER.address, maxCostPerEpoch: 1_000n * TRAC, expiresAt: endsAt + 10 * DAY, nonce: 0n };

    expect(await revertName(chain.addBuyer(terms, '0x', '0x'))).toBe('ServiceSpendingDisabled');
    await chain.setServiceSpending(accountId, true);
    expect((await chain.getServiceSpending(accountId)).owner).toBe(SIGNER.address);
    expect(await revertName(chain.setServiceSpending(accountId, true))).toBe('ServiceSpendingUnchanged');
    expect(await revertName(chain.addBuyer({ ...terms, nonce: 1n }, '0x', '0x'))).toBe('InvalidGrantNonce');
    expect(await revertName(chain.addBuyer(terms, '0x', '0x00'))).toBe('InvalidConsentSignature');
    await chain.addBuyer(terms, '0x', '0x');
    expect(await chain.grantNonce(accountId)).toBe(1n);
    expect(await chain.getGrant(accountId, SIGNER.address)).toMatchObject({ maxCostPerEpoch: terms.maxCostPerEpoch, nonce: 0n, owner: SIGNER.address });

    const request = { accountId, epoch: epoch + 1, sessionKey: SESSION.address, planDigest: PLAN, budgets: [budget(SERVICE_A, 500n * TRAC)] };
    const quote = await chain.previewCost(accountId, 500n * TRAC);
    expect(quote).toEqual({ cost: 400n * TRAC, discountBps: 2000 });
    const funded = await chain.fundFromAccount(request);
    expect(funded).toMatchObject({ subscriptionId: subscriptionIdOf(SIGNER.address, epoch + 1), value: 500n * TRAC, cost: 400n * TRAC });
    expect(await chain.getSubscription(funded.subscriptionId)).toMatchObject({ accountId, startsAt: endsAt, epoch: epoch + 1, discountBps: 2000 });
    expect(await chain.fundingIn(epoch + 1)).toEqual({ wallet: 0n, account: 400n * TRAC });
    expect((await chain.currentWindowAllowance(accountId)).baseRemaining).toBe((50_000n * TRAC) / 12n - 400n * TRAC);

    expect(await revertName(chain.topUpFromAccount(funded.subscriptionId, [budget(SERVICE_A, 1_000n * TRAC)], PLAN))).toBe('LimitExceeded');
    expect(await chain.topUpFromAccount(funded.subscriptionId, [budget(SERVICE_A, 100n * TRAC)], PLAN)).toMatchObject({ cost: 80n * TRAC });

    await chain.setBuyerLimits(accountId, SIGNER.address, { maxCostPerEpoch: 2_000n * TRAC, expiresAt: terms.expiresAt });
    expect((await chain.getGrant(accountId, SIGNER.address))!.maxCostPerEpoch).toBe(2_000n * TRAC);
    await chain.advanceGrantNonce(accountId);
    expect(await chain.grantNonce(accountId)).toBe(2n);
    await chain.removeBuyer(accountId, SIGNER.address);
    const revoked = await chain.getGrant(accountId, SIGNER.address);
    expect(revoked!.revokedAt).toBeGreaterThanOrEqual(now);
    expect(await chain.grantEnd(accountId, SIGNER.address, 0n)).toBe(revoked!.revokedAt);
    expect(await revertName(chain.topUpFromAccount(funded.subscriptionId, [budget(SERVICE_A, TRAC)], PLAN))).toBe('GrantRevoked');
  });

  it('owner actions need the owner, and the buyer consents by signing when it does not send', async () => {
    const { accountId } = await chain.createPublishingConvictionAccount(10_000n * TRAC);
    const { endsAt } = await chain.getEpochTimes();
    const stranger = ethers.Wallet.createRandom().address;
    expect(await revertName(chain.setServiceSpending(accountId, true, { from: stranger }))).toBe('NotAccountOwner');
    expect(await revertName(chain.setServiceSpending(999n, true))).toBe('ERC721NonexistentToken');
    await chain.setServiceSpending(accountId, true);

    const buyer = new ethers.Wallet(`0x${'44'.repeat(32)}`);
    const terms = { accountId, buyer: buyer.address, maxCostPerEpoch: TRAC, expiresAt: endsAt + DAY, nonce: 0n };
    expect(await revertName(chain.addBuyer(terms, '0x', '0x'))).toBe('ConsentMissing');
    const { grantDomain } = await chain.getMarketplaceContracts();
    const consent = await buyer.signTypedData(grantDomain, { BuyerGrant: [
      { name: 'accountId', type: 'uint256' }, { name: 'buyer', type: 'address' }, { name: 'maxCostPerEpoch', type: 'uint96' },
      { name: 'expiresAt', type: 'uint40' }, { name: 'nonce', type: 'uint64' },
    ] }, terms);
    await chain.addBuyer(terms, '0x', consent);
    expect((await chain.getGrant(accountId, buyer.address))!.owner).toBe(SIGNER.address);
    expect(await chain.getAccountBuyers(accountId)).toEqual([buyer.address]);
    expect(await chain.listBuyerAccounts(buyer.address)).toEqual([accountId]);
    expect(await chain.listBuyerAccounts(SIGNER.address)).toEqual([]);
    expect(await chain.getProtocolTreasury()).toBe(ethers.ZeroAddress);
    expect((await chain.getWalletBalances(buyer.address)).trac).toBeGreaterThan(0n);
  });

  it('signBuyerGrant signs as the buyer, 64 bytes over the grant digest', async () => {
    const { grantDomain } = await chain.getMarketplaceContracts();
    const terms = { accountId: 1n, buyer: SIGNER.address, maxCostPerEpoch: TRAC, expiresAt: 2_000_000_000, nonce: 0n };
    const { digest, signature } = await chain.signBuyerGrant(terms);
    expect(digest).toBe(hashBuyerGrant(grantDomain, terms));
    expect(ethers.getBytes(signature)).toHaveLength(64);
    expect(recoverSigner(digest, signature)).toBe(SIGNER.address);
    await expect(chain.signBuyerGrant({ ...terms, buyer: SESSION.address })).rejects.toThrow();
  });
});

describe('mock marketplace: receipt batches', () => {
  it('lands a batch that counts up to the budget, and refuses a nonce that landed', async () => {
    chain.seedIdentity(SIGNER.address, 7n);
    const { epoch } = await chain.getEpochTimes();
    await chain.approveServiceSubscriptionsWallet(TRAC);
    const { subscriptionId } = await chain.fundFromWallet({ epoch, sessionKey: SESSION.address, planDigest: PLAN, budgets: [budget(SERVICE_A, 15_000n)] });
    const sub = (await chain.getSubscription(subscriptionId))!;
    const { requestDomain } = await chain.getMarketplaceContracts();

    const requests: ServiceRequest[] = [0n, 1n].map((nonce) => ({
      subscriptionId, serviceId: SERVICE_A, seller: 7n, nonce, pricePerUnit: 10n, maxUnits: 1_000n, maxValueWei: 10_000n,
      issuedAt: sub.startsAt, expiry: sub.startsAt + 600,
    }));
    const receipts = requests.map((r) => ({
      requestDigest: hashServiceRequest(requestDomain, r), resultCommitment: ethers.keccak256(ethers.toBeHex(r.nonce + 1n, 32)),
      units: 1_000n, valueWei: 10_000n, completedAt: r.issuedAt,
    }));
    const items = requests.map((r, i) => receiptItemOf(r, receipts[i]!, signServiceRequest(SESSION.privateKey, requestDomain, r)));
    const groups = [{ subscriptionId, budgetIndex: 0, minCounted: 0n, items }];

    const batch = await chain.submitReceiptBatch(groups);
    const digests = receipts.map((r) => hashQueryInferenceReceipt(requestDomain, r));
    expect(batch).toMatchObject({ seller: 7n, itemCount: 2, value: 20_000n, counted: 15_000n, batchDigest: receiptsDigest(digests) });
    expect(batch.groups).toEqual([{
      subscriptionId, budgetIndex: 0, seller: 7n, itemCount: 2, value: 20_000n, counted: 15_000n, stakeFactor18: 10n ** 18n,
      groupDigest: receiptsDigest(digests),
    }]);
    expect(await chain.budgetLeft(subscriptionId, 0)).toBe(0n);
    expect(await chain.nonceWord(subscriptionId, 7n, 0n)).toBe(0b11n);
    expect(await chain.getNodeEpoch(7n, epoch)).toEqual({ servedValue: 15_000n, weightedValue: 15_000n });
    expect(await chain.epochPool(epoch)).toBe(15_000n);
    expect(await chain.queryInferenceGross(epoch, 7n)).toBe(15_000n);

    const again = await chain.submitReceiptBatch(groups).catch((e: unknown) => e);
    expect(receiptBatchFaultOf(again)).toEqual({ groupIndex: 0, itemIndex: 0, fault: 'DuplicateNonce' });
    expect(await chain.nonceWord(subscriptionId, 7n, 0n)).toBe(0b11n);
  });

  it('refuses a request the session key did not sign, and a subscription of another epoch', async () => {
    chain.seedIdentity(SIGNER.address, 7n);
    const { epoch } = await chain.getEpochTimes();
    await chain.approveServiceSubscriptionsWallet(TRAC);
    const { subscriptionId } = await chain.fundFromWallet({ epoch, sessionKey: SESSION.address, planDigest: PLAN, budgets: [budget(SERVICE_A, 10_000n)] });
    const sub = (await chain.getSubscription(subscriptionId))!;
    const { requestDomain } = await chain.getMarketplaceContracts();
    const r: ServiceRequest = {
      subscriptionId, serviceId: SERVICE_A, seller: 7n, nonce: 0n, pricePerUnit: 10n, maxUnits: 10n, maxValueWei: 100n,
      issuedAt: sub.startsAt, expiry: sub.startsAt + 600,
    };
    const receipt = { requestDigest: hashServiceRequest(requestDomain, r), resultCommitment: ethers.keccak256('0x02'), units: 10n, valueWei: 100n, completedAt: r.issuedAt };
    const forged = receiptItemOf(r, receipt, signServiceRequest(SIGNER.privateKey, requestDomain, r));
    const fault = await chain.submitReceiptBatch([{ subscriptionId, budgetIndex: 0, minCounted: 0n, items: [forged] }]).catch((e: unknown) => e);
    expect(receiptBatchFaultOf(fault)).toEqual({ groupIndex: 0, itemIndex: 0, fault: 'BadSignature' });

    chain.__advanceEpoch();
    const item = receiptItemOf(r, receipt, signServiceRequest(SESSION.privateKey, requestDomain, r));
    const late = await chain.submitReceiptBatch([{ subscriptionId, budgetIndex: 0, minCounted: 0n, items: [item] }]).catch((e: unknown) => e);
    expect(receiptBatchFaultOf(late)).toEqual({ groupIndex: 0, itemIndex: null, fault: 'OutsideEpoch' });
  });

  it('records a batch before it lands, and reads back its outcome, its groups, the wallet nonce and the base fee', async () => {
    chain.seedIdentity(SIGNER.address, 7n);
    const { epoch } = await chain.getEpochTimes();
    await chain.approveServiceSubscriptionsWallet(TRAC);
    const { subscriptionId } = await chain.fundFromWallet({ epoch, sessionKey: SESSION.address, planDigest: PLAN, budgets: [budget(SERVICE_A, 10_000n)] });
    const sub = (await chain.getSubscription(subscriptionId))!;
    const { requestDomain } = await chain.getMarketplaceContracts();
    const r: ServiceRequest = {
      subscriptionId, serviceId: SERVICE_A, seller: 7n, nonce: 0n, pricePerUnit: 10n, maxUnits: 10n, maxValueWei: 100n,
      issuedAt: sub.startsAt, expiry: sub.startsAt + 600,
    };
    const receipt = { requestDigest: hashServiceRequest(requestDomain, r), resultCommitment: ethers.keccak256('0x02'), units: 10n, valueWei: 100n, completedAt: r.issuedAt };
    const groups = [{ subscriptionId, budgetIndex: 0, minCounted: 0n, items: [receiptItemOf(r, receipt, signServiceRequest(SESSION.privateKey, requestDomain, r))] }];

    // A hook that fails sends nothing.
    await expect(chain.submitReceiptBatch(groups, { onBroadcast: () => { throw new Error('the ledger is full'); } })).rejects.toThrow(/ledger/);
    expect(await chain.nonceWord(subscriptionId, 7n, 0n)).toBe(0n);
    expect(await chain.getMinedNonce(SIGNER.address)).toBe(0);
    // No score in the epoch, no batch.
    const score = vi.spyOn(chain, 'getNodeEpochScore').mockResolvedValueOnce(0n);
    expect(await revertName(chain.submitReceiptBatch(groups))).toBe('NoNodeScore');
    score.mockRestore();

    const signals: unknown[] = [];
    const batch = await chain.submitReceiptBatch(groups, { onBroadcast: async (s) => { signals.push({ ...s, used: await chain.nonceWord(subscriptionId, 7n, 0n) }); } });
    expect(signals).toEqual([{ txHash: batch.hash, nonce: 0, wallet: SIGNER.address, signedTx: expect.stringMatching(/^0x/), used: 0n }]);
    expect(batch.gasUsed).toBeGreaterThan(0n);
    expect(await chain.getReceiptBatchOutcome(batch.hash)).toEqual({ landed: batch });
    expect(await chain.getReceiptBatchOutcome(ethers.ZeroHash)).toBeNull();
    const landed = await chain.listReceiptsLanded(subscriptionId);
    expect(landed).toEqual({ groups: [{ ...batch.groups[0], txHash: batch.hash, blockNumber: batch.blockNumber }], toBlock: batch.blockNumber });
    expect(await chain.listReceiptsLanded(subscriptionId, batch.blockNumber + 1)).toEqual({ groups: [], toBlock: batch.blockNumber });
    expect((await chain.listReceiptsLanded(ethers.ZeroHash)).groups).toEqual([]);
    expect(await chain.getMinedNonce(SIGNER.address)).toBe(1);
    expect(await chain.getBaseFee()).toBe(10n ** 6n);
  });

  it('sends a batch signed but never sent again as it was signed: once, and mined reverted when it would revert', async () => {
    chain.seedIdentity(SIGNER.address, 7n);
    const { epoch } = await chain.getEpochTimes();
    await chain.approveServiceSubscriptionsWallet(TRAC);
    const { subscriptionId } = await chain.fundFromWallet({ epoch, sessionKey: SESSION.address, planDigest: PLAN, budgets: [budget(SERVICE_A, 10_000n)] });
    const sub = (await chain.getSubscription(subscriptionId))!;
    const { requestDomain } = await chain.getMarketplaceContracts();
    const groupOf = (nonce: bigint) => {
      const r: ServiceRequest = {
        subscriptionId, serviceId: SERVICE_A, seller: 7n, nonce, pricePerUnit: 10n, maxUnits: 10n, maxValueWei: 100n,
        issuedAt: sub.startsAt, expiry: sub.startsAt + 600,
      };
      const receipt = { requestDigest: hashServiceRequest(requestDomain, r), resultCommitment: ethers.keccak256('0x02'), units: 10n, valueWei: 100n, completedAt: r.issuedAt };
      return [{ subscriptionId, budgetIndex: 0, minCounted: 0n, items: [receiptItemOf(r, receipt, signServiceRequest(SESSION.privateKey, requestDomain, r))] }];
    };
    // Signed, its hook stops the node: nothing sent, its nonce unused.
    const stopped = async (nonce: bigint) => {
      let signal: { txHash: string; signedTx: string } | undefined;
      await expect(chain.submitReceiptBatch(groupOf(nonce), { onBroadcast: (s) => { signal = s; throw new Error('the node stopped'); } })).rejects.toThrow(/stopped/);
      return signal!;
    };
    const first = await stopped(0n);
    expect(await chain.getReceiptBatchOutcome(first.txHash)).toBeNull();
    await chain.rebroadcastReceiptBatch(first.signedTx);
    expect(await chain.getReceiptBatchOutcome(first.txHash)).toMatchObject({ landed: { hash: first.txHash, itemCount: 1 } });
    expect(await chain.getMinedNonce(SIGNER.address)).toBe(1);
    await expect(chain.rebroadcastReceiptBatch(first.signedTx)).rejects.toThrow(/nonce too low/);
    await expect(chain.rebroadcastReceiptBatch('0x00')).rejects.toThrow(/not a receipt batch/);
    // One that would revert now, its epoch over, is mined reverted: its nonce used, its receipt not landed.
    const late = await stopped(1n);
    chain.__advanceEpoch();
    await chain.rebroadcastReceiptBatch(late.signedTx);
    expect(await chain.getReceiptBatchOutcome(late.txHash)).toEqual({ reverted: true });
    expect(await chain.getMinedNonce(SIGNER.address)).toBe(2);
    expect(await chain.nonceWord(subscriptionId, 7n, 0n)).toBe(1n);
  });

  it('refuses a batch from a node with no profile, and one out of bounds', async () => {
    expect(await revertName(chain.submitReceiptBatch([]))).toBe('ProfileDoesntExist');
    chain.seedIdentity(SIGNER.address, 7n);
    expect(await revertName(chain.submitReceiptBatch([]))).toBe('BatchOutOfBounds');
    // The sender's identity, as the settlement reads it: an operational wallet maps to its node, any other address to 0.
    expect(await chain.getIdentityIdForAddress(SIGNER.address)).toBe(7n);
    expect(await chain.getIdentityIdForAddress(ethers.Wallet.createRandom().address)).toBe(0n);
    expect(await chain.batchState()).toEqual({ activationEpoch: 1, paused: false, maxGroups: 32, maxItems: 256 });
    // The gate: a node with an identity has a profile and the minimum stake.
    expect([await chain.profileExists(7n), await chain.profileExists(0n)]).toEqual([true, false]);
    expect(await chain.getNodeStake(7n)).toBe(await chain.getMinimumStake());
    expect(await chain.getNodeStake(0n)).toBe(0n);
    expect(await chain.maxBudgetsPerSubscription()).toBe(16);
  });
});
