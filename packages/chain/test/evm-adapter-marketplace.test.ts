// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace mixin (evm-adapter-marketplace.ts) against the contracts on
 * the shared Hardhat node, which the evm-module's development deploy leaves
 * with the query/inference pool active from the deployment epoch:
 *   - the TypeScript digests of a request, a receipt and a grant equal the
 *     contracts' `hashRequest`, `hashReceipt` and `hashGrant`, and their type
 *     strings the contracts' typehashes;
 *   - each write once: a wallet funding and top-up, an account's opt-in,
 *     grant, prefunding of the next epoch, top-up, limits and removal, and a
 *     receipt batch that lands, with its hook before the broadcast, its
 *     outcome, its groups read back from the logs, and a batch mined and
 *     reverted.
 * One snapshot per test, as the other adapter suites take.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Contract, Wallet, ethers } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import {
  BUYER_GRANT_TYPES,
  QUERY_INFERENCE_RECEIPT_TYPES,
  SERVICE_CLASS_INFERENCE,
  SERVICE_CLASS_QUERY,
  SERVICE_REQUEST_TYPES,
  hashBuyerGrant,
  hashQueryInferenceReceipt,
  hashServiceRequest,
  receiptBatchFaultOf,
  receiptItemOf,
  receiptsDigest,
  recoverSigner,
  signServiceRequest,
  subscriptionIdOf,
  type MarketplaceContracts,
  type QueryInferenceReceipt,
  type ServiceBudget,
  type ServiceRequest,
} from '../src/marketplace.js';
import {
  HARDHAT_KEYS,
  createEVMAdapter,
  createProvider,
  getSharedContext,
  makeAdapterConfig,
  revertSnapshot,
  takeSnapshot,
} from './evm-test-context.js';
import { mintTokens } from './hardhat-harness.js';

const TRAC = 10n ** 18n;
const DAY = 86_400;
const SERVICE_A = ethers.id('urn:dkg:model:a');
const SERVICE_B = ethers.id('urn:dkg:model:b');
const [FIRST, SECOND] = BigInt(SERVICE_A) < BigInt(SERVICE_B) ? [SERVICE_A, SERVICE_B] : [SERVICE_B, SERVICE_A];
const PLAN = ethers.id('plan');

const budget = (serviceId: string, value: bigint, serviceClass = SERVICE_CLASS_INFERENCE): ServiceBudget =>
  ({ serviceId, serviceClass, value, maxPricePerUnit: 10n ** 12n });

/** The decoded name of the revert `promise` rejects with. */
async function revertName(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(() => undefined, (e: unknown) => e as { revert?: { name?: string } });
  return err?.revert?.name;
}

let fileSnapshot: string;
let testSnapshot: string;
let contracts: MarketplaceContracts;
let seller: EVMChainAdapter;
let walletBuyer: EVMChainAdapter;

function contractAt(name: string, address: string): Contract {
  return new Contract(address, loadAbi(name), createProvider());
}

describe('the marketplace mixin on Hardhat', () => {
  beforeAll(async () => {
    fileSnapshot = await takeSnapshot();
    seller = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    walletBuyer = createEVMAdapter(HARDHAT_KEYS.EXTRA1);
    contracts = await seller.getMarketplaceContracts();
  }, 120_000);
  afterAll(async () => { await revertSnapshot(fileSnapshot); });
  beforeEach(async () => { testSnapshot = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(testSnapshot); });

  it('reads the contracts from the Hub, the epoch from Chronos and the bounds from the chain', async () => {
    const hub = contractAt('Hub', getSharedContext().hubAddress);
    expect(contracts.queryInferenceStorage).toBe(await hub.getContractAddress('QueryInferenceStorage'));
    expect(contracts.serviceSubscriptionsWallet).toBe(await hub.getContractAddress('ServiceSubscriptionsWallet'));
    expect(contracts.requestDomain).toEqual({ name: 'DKGQueryInference', version: '1', chainId: 31337, verifyingContract: contracts.queryInferenceStorage });
    expect(contracts.grantDomain).toEqual({ name: 'DKGServiceSubscriptions', version: '1', chainId: 31337, verifyingContract: contracts.serviceSubscriptions });

    const times = await seller.getEpochTimes();
    const chronos = contractAt('Chronos', await hub.getContractAddress('Chronos'));
    expect(times.endsAt - times.startsAt).toBe(Number(await chronos.epochLength()));
    expect(times.startsAt <= times.now && times.now < times.endsAt).toBe(true);

    const state = await seller.batchState();
    expect(state.activationEpoch).toBeGreaterThan(0);
    expect(state.activationEpoch).toBeLessThanOrEqual(times.epoch);
    expect(state).toMatchObject({ paused: false, maxGroups: 32, maxItems: 256 });
    expect(await seller.maxBudgetsPerSubscription()).toBe(16);
    // A wired treasury would refuse every opt-in and account funding.
    expect(await seller.getProtocolTreasury()).toBe(ethers.ZeroAddress);
  });

  it('the TypeScript digests equal hashRequest, hashReceipt and hashGrant, and the type strings the typehashes', async () => {
    const qs = contractAt('QueryInferenceSettlement', contracts.queryInferenceSettlement);
    const ss = contractAt('ServiceSubscriptions', contracts.serviceSubscriptions);
    const typeHash = (types: Record<string, Array<{ name: string; type: string }>>, name: string) =>
      ethers.id(ethers.TypedDataEncoder.from(types).encodeType(name));
    expect(typeHash(SERVICE_REQUEST_TYPES, 'ServiceRequest')).toBe(await qs.SERVICE_REQUEST_TYPEHASH());
    expect(typeHash(QUERY_INFERENCE_RECEIPT_TYPES, 'QueryInferenceReceipt')).toBe(await qs.QUERY_INFERENCE_RECEIPT_TYPEHASH());
    expect(typeHash(BUYER_GRANT_TYPES, 'BuyerGrant')).toBe(await ss.BUYER_GRANT_TYPEHASH());
    expect(ethers.TypedDataEncoder.hashDomain(contracts.requestDomain)).toBe(await qs.domainSeparator());
    expect(ethers.TypedDataEncoder.hashDomain(contracts.grantDomain)).toBe(await ss.domainSeparator());

    // The widest value of every field, so a field typed too narrow or too wide differs.
    const request: ServiceRequest = {
      subscriptionId: ethers.id('subscription'),
      serviceId: SERVICE_A,
      seller: (1n << 72n) - 1n,
      nonce: (1n << 64n) - 1n,
      pricePerUnit: (1n << 96n) - 1n,
      maxUnits: (1n << 64n) - 1n,
      maxValueWei: (1n << 96n) - 2n,
      issuedAt: 2 ** 40 - 2,
      expiry: 2 ** 40 - 1,
    };
    const requestDigest = hashServiceRequest(contracts.requestDomain, request);
    expect(requestDigest).toBe(await qs.hashRequest(request));
    const receipt: QueryInferenceReceipt = {
      requestDigest,
      resultCommitment: ethers.id('result'),
      units: (1n << 64n) - 1n,
      valueWei: (1n << 96n) - 1n,
      completedAt: 2 ** 40 - 1,
    };
    expect(hashQueryInferenceReceipt(contracts.requestDomain, receipt)).toBe(await qs.hashReceipt(receipt));
    const terms = {
      accountId: ethers.MaxUint256,
      buyer: ethers.getAddress('0xffffffffffffffffffffffffffffffffffffffff'),
      maxCostPerEpoch: (1n << 96n) - 1n,
      expiresAt: 2 ** 40 - 1,
      nonce: (1n << 64n) - 1n,
    };
    expect(hashBuyerGrant(contracts.grantDomain, terms)).toBe(await ss.hashGrant(terms));
    expect(subscriptionIdOf(terms.buyer, 663)).toBe(await ss.subscriptionIdOf(terms.buyer, 663));
  });

  it('funds the current epoch from a wallet, under the allowance it approves, and tops up', async () => {
    const buyer = walletBuyer.getSignerAddress();
    const before = await walletBuyer.getWalletBalances(buyer);
    await mintTokens(createProvider(), getSharedContext().hubAddress, HARDHAT_KEYS.DEPLOYER, buyer, 1_000n * TRAC);
    expect((await walletBuyer.getWalletBalances(buyer)).trac).toBe(before.trac + 1_000n * TRAC);
    expect(before.eth).toBeGreaterThan(0n);
    const { epoch } = await walletBuyer.getEpochTimes();
    const request = { epoch, sessionKey: Wallet.createRandom().address, planDigest: PLAN, budgets: [budget(FIRST, 100n * TRAC)] };

    expect(await revertName(walletBuyer.fundFromWallet(request))).toBe('ERC20InsufficientAllowance');
    expect((await walletBuyer.approveServiceSubscriptionsWallet(150n * TRAC)).success).toBe(true);
    expect(await walletBuyer.getServiceSubscriptionsWalletAllowance(buyer)).toBe(150n * TRAC);

    const funded = await walletBuyer.fundFromWallet(request);
    const id = subscriptionIdOf(buyer, epoch);
    expect(funded).toMatchObject({ success: true, subscriptionId: id, value: 100n * TRAC, cost: 100n * TRAC });
    expect(await walletBuyer.subscriptionExists(id)).toBe(true);
    expect(await walletBuyer.getSubscription(id)).toMatchObject({
      accountId: 0n, buyer, sessionKey: request.sessionKey, epoch, planDigest: PLAN, budgetCount: 1, value: 100n * TRAC, cost: 100n * TRAC,
    });
    expect(await walletBuyer.getBudgets(id)).toEqual(request.budgets);
    expect(await walletBuyer.fundingIn(epoch)).toEqual({ wallet: 100n * TRAC, account: 0n });
    expect(await revertName(walletBuyer.fundFromWallet(request))).toBe('SubscriptionAlreadyFunded');

    const topUp = await walletBuyer.topUpFromWallet(id, [budget(FIRST, 10n * TRAC), budget(SECOND, 20n * TRAC, SERVICE_CLASS_QUERY)], ethers.id('plan 2'));
    expect(topUp).toMatchObject({ success: true, value: 30n * TRAC, cost: 30n * TRAC });
    expect(await walletBuyer.getBudgets(id)).toEqual([budget(FIRST, 110n * TRAC), budget(SECOND, 20n * TRAC, SERVICE_CLASS_QUERY)]);
    expect(await walletBuyer.getSubscription(id)).toMatchObject({ budgetCount: 2, value: 130n * TRAC, planDigest: ethers.id('plan 2') });
    expect(await walletBuyer.getServiceSubscriptionsWalletAllowance(buyer)).toBe(20n * TRAC);
    expect(await walletBuyer.budgetLeft(id, 1)).toBe(20n * TRAC);
  });

  it('runs an account: opt-in, a grant with the buyer\'s signature, a prefunded next epoch, a top-up, limits and removal', async () => {
    // The node owns the account with its primary wallet and buys with another of its wallets.
    const { rpcUrl, hubAddress } = getSharedContext();
    const node = new EVMChainAdapter(makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.PUBLISHER2, [HARDHAT_KEYS.EXTRA2]));
    const owner = node.getSignerAddress();
    const buyer = new Wallet(HARDHAT_KEYS.EXTRA2).address;
    await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, owner, 50_000n * TRAC);
    const { accountId } = await node.createPublishingConvictionAccount(50_000n * TRAC);

    expect(await node.getServiceSpending(accountId)).toEqual({ enabledAt: 0, owner: ethers.ZeroAddress });
    await node.setServiceSpending(accountId, true);
    const spending = await node.getServiceSpending(accountId);
    expect(spending.owner).toBe(owner);
    expect(spending.enabledAt).toBeGreaterThan(0);

    const { epoch, endsAt } = await node.getEpochTimes();
    const terms = { accountId, buyer, maxCostPerEpoch: 1_000n * TRAC, expiresAt: endsAt + 10 * DAY, nonce: await node.grantNonce(accountId) };
    expect(terms.nonce).toBe(0n);
    const consent = await node.signBuyerGrant(terms);
    expect(consent.digest).toBe(await contractAt('ServiceSubscriptions', contracts.serviceSubscriptions).hashGrant(terms));
    expect(ethers.getBytes(consent.signature)).toHaveLength(64);
    expect(recoverSigner(consent.digest, consent.signature)).toBe(buyer);
    expect(await revertName(node.addBuyer(terms, '0x', '0x'))).toBe('ConsentMissing');
    await node.addBuyer(terms, '0x', consent.signature);
    expect(await node.grantNonce(accountId)).toBe(1n);
    expect(await node.getAccountBuyers(accountId)).toEqual([buyer]);
    expect(await node.listBuyerAccounts(buyer)).toEqual([accountId]);
    expect(await node.listBuyerAccounts(owner)).toEqual([]);
    expect(await node.getGrant(accountId, buyer)).toMatchObject({ maxCostPerEpoch: 1_000n * TRAC, expiresAt: terms.expiresAt, revokedAt: 0, nonce: 0n, owner });

    // Fifty thousand TRAC committed: the 20% tier.
    const value = 500n * TRAC;
    const quote = await node.previewCost(accountId, value);
    expect(quote).toEqual({ cost: 400n * TRAC, discountBps: 2000 });
    const before = await node.currentWindowAllowance(accountId);
    expect(before.expired).toBe(false);
    const request = { accountId, epoch: epoch + 1, sessionKey: Wallet.createRandom().address, planDigest: PLAN, budgets: [budget(FIRST, value)] };
    const funded = await node.fundFromAccount(request, { from: buyer });
    expect(funded).toMatchObject({ success: true, subscriptionId: subscriptionIdOf(buyer, epoch + 1), value, cost: quote.cost });
    expect(await node.getSubscription(funded.subscriptionId)).toMatchObject({
      accountId, buyer, grantNonce: 0n, epoch: epoch + 1, startsAt: endsAt, discountBps: 2000, value, cost: quote.cost,
    });
    expect(await node.fundingIn(epoch + 1)).toEqual({ wallet: 0n, account: quote.cost });
    const after = await node.currentWindowAllowance(accountId);
    expect(before.baseRemaining + before.topUpBuffer - after.baseRemaining - after.topUpBuffer).toBe(quote.cost);

    const topUp = await node.topUpFromAccount(funded.subscriptionId, [budget(FIRST, 100n * TRAC)], PLAN, { from: buyer });
    expect(topUp).toMatchObject({ success: true, value: 100n * TRAC, cost: 80n * TRAC });
    expect(await revertName(node.topUpFromAccount(funded.subscriptionId, [budget(FIRST, 1_000n * TRAC)], PLAN, { from: buyer }))).toBe('LimitExceeded');

    await node.setBuyerLimits(accountId, buyer, { maxCostPerEpoch: 2_000n * TRAC, expiresAt: terms.expiresAt });
    expect((await node.getGrant(accountId, buyer))!.maxCostPerEpoch).toBe(2_000n * TRAC);
    await node.advanceGrantNonce(accountId);
    expect(await node.grantNonce(accountId)).toBe(2n);

    await node.removeBuyer(accountId, buyer);
    const removed = (await node.getGrant(accountId, buyer))!;
    expect(removed.revokedAt).toBeGreaterThan(0);
    expect(await node.grantEnd(accountId, buyer, 0n)).toBe(removed.revokedAt);
    expect(await node.grantNonce(accountId)).toBe(3n);
    expect(await revertName(node.fundFromAccount({ ...request, epoch }, { from: buyer }))).toBe('GrantRevoked');

    await node.setServiceSpending(accountId, false);
    expect((await node.getServiceSpending(accountId)).enabledAt).toBe(0);
    await expect(node.fundFromAccount(request, { from: Wallet.createRandom().address })).rejects.toThrow(/not one of this node's operational wallets/);
  });

  it('lands a receipt batch, recorded before it is sent and read back after, and refuses its nonces a second time', async () => {
    const { hubAddress, coreProfileId } = getSharedContext();
    const sellerId = BigInt(coreProfileId);
    const buyer = walletBuyer.getSignerAddress();
    await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, buyer, 1_000n * TRAC);
    await walletBuyer.approveServiceSubscriptionsWallet(1_000n * TRAC);
    const { epoch } = await walletBuyer.getEpochTimes();
    const session = Wallet.createRandom();
    const { subscriptionId } = await walletBuyer.fundFromWallet({
      epoch, sessionKey: session.address, planDigest: PLAN, budgets: [budget(FIRST, 10n ** 9n), budget(SECOND, 10n ** 6n)],
    });
    const sub = (await walletBuyer.getSubscription(subscriptionId))!;

    // A node lands receipts once it has a node score in the epoch: the Hub owner stands in for RandomSampling.
    expect(await seller.getNodeEpochScore(epoch, sellerId)).toBe(0n);
    const hub = contractAt('Hub', hubAddress);
    const rss = new Contract(
      await hub.getContractAddress('RandomSamplingStorage'),
      loadAbi('RandomSamplingStorage'),
      new Wallet(HARDHAT_KEYS.DEPLOYER, createProvider()),
    );
    await (await rss.addToNodeEpochScore(epoch, sellerId, 10n ** 18n)).wait();
    await (await rss.addToAllNodesEpochScore(epoch, 10n ** 18n)).wait();
    expect(await seller.getNodeEpochScore(epoch, sellerId)).toBe(10n ** 18n);
    // The sender's identity, as the settlement reads it: an operational wallet maps to its node, any other address to 0.
    expect(await walletBuyer.getIdentityIdForAddress(seller.getSignerAddress())).toBe(sellerId);
    expect(await walletBuyer.getIdentityIdForAddress(session.address)).toBe(0n);
    expect(await seller.getShardingTableNodeId(sellerId)).toMatch(/^0x[0-9a-f]+$/);
    expect(await seller.getShardingTableNodeId(9_999n)).toBeNull();
    // Its gate: a profile, and a stake at least the minimum, which put it in the table.
    expect(await seller.profileExists(sellerId)).toBe(true);
    expect(await seller.profileExists(9_999n)).toBe(false);
    expect(await seller.getNodeStake(sellerId)).toBeGreaterThanOrEqual(await seller.getMinimumStake());
    expect(await seller.getNodeStake(9_999n)).toBe(0n);

    const domain = contracts.requestDomain;
    const requestOf = (serviceId: string, nonce: bigint, units: bigint): ServiceRequest => ({
      subscriptionId, serviceId, seller: sellerId, nonce, pricePerUnit: 1_000n, maxUnits: units, maxValueWei: units * 1_000n,
      issuedAt: sub.startsAt, expiry: sub.startsAt + 600,
    });
    const served = [
      { budgetIndex: 0, request: requestOf(FIRST, 0n, 300n) },
      { budgetIndex: 0, request: requestOf(FIRST, 1n, 200n) },
      { budgetIndex: 1, request: requestOf(SECOND, 2n, 2_000n) },
    ].map(({ budgetIndex, request }) => {
      const receipt: QueryInferenceReceipt = {
        requestDigest: hashServiceRequest(domain, request),
        resultCommitment: ethers.id(`result ${request.nonce}`),
        units: request.maxUnits,
        valueWei: request.maxValueWei,
        completedAt: request.issuedAt,
      };
      const item = receiptItemOf(request, receipt, signServiceRequest(session.privateKey, domain, request));
      return { budgetIndex, item, digest: hashQueryInferenceReceipt(domain, receipt) };
    });
    const groups = [0, 1].map((budgetIndex) => ({
      subscriptionId, budgetIndex, minCounted: 0n, items: served.filter((s) => s.budgetIndex === budgetIndex).map((s) => s.item),
    }));

    // The hook runs once the batch is signed, before it is sent: nothing of it is on chain yet.
    const signals: Array<{ txHash: string; nonce?: number; wallet: string; signedTx: string; mined: unknown }> = [];
    const batch = await seller.submitReceiptBatch(groups, {
      onBroadcast: async (s) => { signals.push({ ...s, mined: await seller.getReceiptBatchOutcome(s.txHash) }); },
    });
    expect(signals).toEqual([{ txHash: batch.hash, nonce: expect.any(Number), wallet: seller.getSignerAddress(), signedTx: expect.any(String), mined: null }]);
    expect(ethers.Transaction.from(signals[0]!.signedTx).hash).toBe(batch.hash);
    expect(await seller.getMinedNonce(seller.getSignerAddress())).toBe(signals[0]!.nonce! + 1);
    expect(batch.gasUsed).toBeGreaterThan(0n);
    expect(await seller.getReceiptBatchOutcome(batch.hash)).toEqual({ landed: batch });
    const landed = await walletBuyer.listReceiptsLanded(subscriptionId);
    expect(landed.groups).toEqual(batch.groups.map((g) => ({ ...g, txHash: batch.hash, blockNumber: batch.blockNumber })));
    expect(landed.toBlock).toBeGreaterThanOrEqual(batch.blockNumber);
    expect((await walletBuyer.listReceiptsLanded(subscriptionId, batch.blockNumber + 1)).groups).toEqual([]);
    expect(await seller.getBaseFee()).toBeGreaterThan(0n);
    expect(batch).toMatchObject({
      success: true, seller: sellerId, itemCount: 3, value: 500_000n + 2_000_000n, counted: 500_000n + 10n ** 6n,
      batchDigest: receiptsDigest(served.map((s) => s.digest)),
    });
    expect(batch.stakeFactor18).toBe(await seller.stakeFactor(sellerId));
    expect(batch.groups).toEqual([
      { subscriptionId, budgetIndex: 0, seller: sellerId, itemCount: 2, value: 500_000n, counted: 500_000n, stakeFactor18: batch.stakeFactor18, groupDigest: receiptsDigest(served.slice(0, 2).map((s) => s.digest)) },
      // The second budget had 10^6 wei left: the group counts that much, and its nonce is used.
      { subscriptionId, budgetIndex: 1, seller: sellerId, itemCount: 1, value: 2_000_000n, counted: 10n ** 6n, stakeFactor18: batch.stakeFactor18, groupDigest: receiptsDigest([served[2]!.digest]) },
    ]);
    expect(await seller.budgetUsed(subscriptionId, 0)).toBe(500_000n);
    expect(await seller.budgetLeft(subscriptionId, 0)).toBe(10n ** 9n - 500_000n);
    expect(await seller.budgetLeft(subscriptionId, 1)).toBe(0n);
    expect(await seller.nonceWord(subscriptionId, sellerId, 0n)).toBe(0b111n);
    const node = await seller.getNodeEpoch(sellerId, epoch);
    expect(node.servedValue).toBe(batch.counted);
    expect((await seller.getEpochTotals(epoch)).totalServed).toBe(batch.counted);
    const pool = await seller.epochPool(epoch);
    expect(pool).toBeGreaterThanOrEqual((await seller.fundingIn(epoch)).wallet);
    const gross = await seller.queryInferenceGross(epoch, sellerId);
    expect(gross <= pool && gross >= pool - 2n).toBe(true);

    const again = await seller.submitReceiptBatch(groups).catch((e: unknown) => e);
    expect(receiptBatchFaultOf(again)).toEqual({ groupIndex: 0, itemIndex: 0, fault: 'DuplicateNonce' });

    // A node that stops once a batch is signed, before it is sent, has sent nothing. The signed transaction it was
    // given lands as signed when sent again, under its own hash and nonce; once its nonce is used, it is not sent.
    const late = requestOf(FIRST, 3n, 100n);
    const lateReceipt = { requestDigest: hashServiceRequest(domain, late), resultCommitment: ethers.id('result 3'), units: 100n, valueWei: 100_000n, completedAt: late.issuedAt };
    const lateGroup = { subscriptionId, budgetIndex: 0, minCounted: 0n, items: [receiptItemOf(late, lateReceipt, signServiceRequest(session.privateKey, domain, late))] };
    const nonceBefore = await seller.getMinedNonce(seller.getSignerAddress());
    const stopped: Array<{ txHash: string; signedTx: string }> = [];
    await expect(seller.submitReceiptBatch([lateGroup], {
      onBroadcast: (s) => {
        stopped.push(s);
        throw new Error('the node stopped');
      },
    })).rejects.toThrow(/the node stopped/);
    expect(await seller.getMinedNonce(seller.getSignerAddress())).toBe(nonceBefore);
    expect(await seller.getReceiptBatchOutcome(stopped[0]!.txHash)).toBeNull();
    await seller.rebroadcastReceiptBatch(stopped[0]!.signedTx);
    expect(await seller.getReceiptBatchOutcome(stopped[0]!.txHash)).toMatchObject({ landed: { hash: stopped[0]!.txHash, itemCount: 1, value: 100_000n } });
    expect(await seller.getMinedNonce(seller.getSignerAddress())).toBe(nonceBefore + 1);
    await seller.rebroadcastReceiptBatch(stopped[0]!.signedTx);
    expect(await seller.getMinedNonce(seller.getSignerAddress())).toBe(nonceBefore + 1);

    // A batch mined and reverted: sent past the simulation, with its own gas limit, by a wallet that is no node's.
    const sender = new Wallet(HARDHAT_KEYS.EXTRA2, createProvider());
    const data = new ethers.Interface(loadAbi('QueryInferenceSettlement')).encodeFunctionData('submitReceiptBatch', [groups]);
    const signed = await sender.signTransaction(await sender.populateTransaction({ to: contracts.queryInferenceSettlement, data, gasLimit: 1_000_000 }));
    await createProvider().broadcastTransaction(signed).catch(() => undefined);
    expect(await seller.getReceiptBatchOutcome(ethers.keccak256(signed))).toEqual({ reverted: true });
  });
});
