// The operations the rehearsal's phases repeat, as the fork's actors send
// them: claims, publishes, TRAC from the Hub owner, a Conviction Account opened
// for services with a buyer added, funding requests, and receipt batches
// of requests signed by session keys. The shapes, digests and builders are
// test/helpers'.

import { ethers } from 'ethers';
import type { Signer } from 'ethers';

import type { Domain, Request, Terms, WalletRequest } from '../../../test/helpers/conviction-service';
import { DAY, BUYER_GRANT_TYPES, domainOf, requestOf, walletRequestOf } from '../../../test/helpers/conviction-service';
import type { ReceiptGroup, ReceiptItem, ServiceRequest } from '../../../test/helpers/query-inference';
import { REQUEST_TYPES, fullReceipt, itemOf, queryInferenceDomain } from '../../../test/helpers/query-inference';
import type { PublishingConviction, PublishingConvictionStorage } from '../../../typechain';
import { Contracts, eventsIn } from '../contracts';
import { SERVICE0, UNIT_PRICE, inference } from '../plans';
import { fmt } from '../report';
import { Ctx, Sent, send } from './context';
import { impersonate } from './plumbing';
import { stakerCredits } from './reads';
import type { ClaimResult, Position, PublishResult } from './results';

/**
 * Claim every position as its owner, through the staking NFT. The reward is
 * what the claim adds to the cumulative-rewards statistic; a check of its own
 * requires the claim to credit the same to the raw stake, which is what the
 * position owns.
 */
export async function claimAll(ctx: Ctx, pos: Position[], tag: string): Promise<ClaimResult[]> {
  const { snft, css } = ctx.base;
  const out: ClaimResult[] = [];
  for (const p of pos) {
    const owner = await impersonate(ctx, p.owner);
    const before = await css.getPosition(p.tokenId);
    const { gasUsed } = await send(ctx, `${tag} claim token ${p.tokenId} (node ${p.node})`, owner, await snft.getAddress(), snft.interface.encodeFunctionData('claim', [p.tokenId]));
    const after = await css.getPosition(p.tokenId);
    const reward = after.cumulativeRewardsClaimed - before.cumulativeRewardsClaimed;
    const rawDelta = after.raw - before.raw;
    ctx.report.check(`${tag} token ${p.tokenId}: the claim credits its reward to the raw stake`, rawDelta === reward, `raw +${fmt(rawDelta)}, rewards +${fmt(reward)} TRAC`);
    out.push({ tokenId: p.tokenId, node: p.node, reward, rawDelta, lastClaimedEpoch: after.lastClaimedEpoch, gasUsed });
  }
  return out;
}

/**
 * FORK-ONLY: coverPublishingCost through the publishing NFT, as
 * KnowledgeAssetsLifecycle (impersonated) calls it in a publish, without the
 * publish's node signatures. `pc` is the PublishingConviction the Hub holds.
 */
export async function publishAs(ctx: Ctx, pc: PublishingConviction, accountId: bigint, agent: string, baseCost: bigint, kaEpochs: bigint, tag: string): Promise<PublishResult> {
  const { nft, pcs, chronos } = ctx.base;
  const kal = await impersonate(ctx, await ctx.stack.addr('KnowledgeAssetsLifecycle'));
  // anvil stamps a block with the wall clock: mine one first, so the views
  // below and the publish read the same billing window and epoch.
  await ctx.fork.mine();
  const E = await chronos.getCurrentEpoch();
  const discounted = await nft.connect(kal).coverPublishingCost.staticCall(agent, baseCost, E, kaEpochs);
  const { receipt, gasUsed } = await send(
    ctx,
    `${tag} publish ${fmt(baseCost)} TRAC base from account ${accountId}`,
    kal,
    await nft.getAddress(),
    nft.interface.encodeFunctionData('coverPublishingCost', [agent, baseCost, E, kaEpochs]),
  );
  // The window and the spends as of the publish's own block.
  const block = await ctx.hre.ethers.provider.getBlock(receipt.blockNumber);
  if (!block) throw new Error(`no block ${receipt.blockNumber}`);
  const a = await pcs.getAccount(accountId);
  const w = (BigInt(block.timestamp) - a.createdAtTimestamp) / (await chronos.epochLength());
  const prior = { blockTag: receipt.blockNumber - 1 };
  const [cc] = eventsIn(receipt, pc, pc.getEvent('CostCovered'));
  return {
    epoch: cc ? cc.epoch : E,
    window: w,
    discountedCost: discounted,
    windowSpentDelta: (await pcs.windowSpent(accountId, w)) - (await pcs.windowSpent(accountId, w, prior)),
    topUpDelta: (await pcs.topUpBalance(accountId)) - (await pcs.topUpBalance(accountId, prior)),
    spentFromEpoch: cc?.spentFromEpoch,
    spentFromTopUp: cc?.spentFromTopUp,
    stakerCredits: stakerCredits(receipt, ctx.base),
    gasUsed,
  };
}

/** FORK-ONLY: TRAC from the Hub owner's balance. */
export async function fundTrac(ctx: Ctx, hubOwner: Signer, to: string, amount: bigint, label: string): Promise<Sent> {
  const { token } = ctx.base;
  return send(ctx, label, hubOwner, await token.getAddress(), token.interface.encodeFunctionData('transfer', [to, amount]));
}

export async function approve(ctx: Ctx, label: string, holder: Signer, spender: string, amount: bigint): Promise<Sent> {
  const { token } = ctx.base;
  return send(ctx, label, holder, await token.getAddress(), token.interface.encodeFunctionData('approve', [spender, amount]));
}

export type NewAccount = { accountId: bigint; created: Sent; account: PublishingConvictionStorage.AccountStructOutput };

/** A new Conviction Account of `committed` TRAC with no designated node: the approval, then createAccount. */
export async function createAccount(ctx: Ctx, c: Contracts, who: string, owner: Signer, committed: bigint): Promise<NewAccount> {
  const nft = await c.nft.getAddress();
  await approve(ctx, `${who}: approve the publishing NFT`, owner, nft, committed);
  const created = await send(ctx, `${who}: createAccount(${fmt(committed)} TRAC)`, owner, nft, c.nft.interface.encodeFunctionData('createAccount', [committed, 0]));
  const [ev] = eventsIn(created.receipt, c.pc, c.pc.getEvent('AccountCreated'));
  if (!ev) throw new Error('createAccount emitted no AccountCreated');
  return { accountId: ev.accountId, created, account: await c.pcs.getAccount(ev.accountId) };
}

/**
 * A new Conviction Account opened for services: created, opted in, and
 * `buyer` added over it by the owner's transaction, with the buyer's
 * consent by an EIP-712 signature over the same terms, at the account's
 * current nonce, up to `maxCostPerEpoch` a subscription, until the account
 * expires.
 */
export async function openServiceAccount(
  ctx: Ctx,
  c: Contracts,
  o: { owner: Signer; committed: bigint; buyer: Signer & { address: string }; maxCostPerEpoch: bigint; addBuyerLabel: string },
): Promise<NewAccount & { terms: Terms }> {
  const a = await createAccount(ctx, c, 'account owner', o.owner, o.committed);
  const ss = await c.ss.getAddress();
  await send(ctx, `account owner: setServiceSpending(${a.accountId}, true)`, o.owner, ss, c.ss.interface.encodeFunctionData('setServiceSpending', [a.accountId, true]));
  const terms: Terms = {
    accountId: a.accountId,
    buyer: o.buyer.address,
    maxCostPerEpoch: o.maxCostPerEpoch,
    expiresAt: a.account.expiresAtTimestamp,
    nonce: await c.sss.grantNonce(a.accountId),
  };
  const consent = await o.buyer.signTypedData(await domainOf(c.ss), BUYER_GRANT_TYPES, terms);
  await send(ctx, o.addBuyerLabel, o.owner, ss, c.ss.interface.encodeFunctionData('addBuyer', [terms, '0x', consent]));
  return { ...a, terms };
}

/** A wallet-funded request for the subscription of `epoch`: one inference budget of `value`, under the plan named `plan`. */
export const walletRequest = (epoch: bigint, sessionKey: string, value: bigint, plan: string): WalletRequest =>
  walletRequestOf(epoch, { sessionKey, planDigest: ethers.id(plan), budgets: inference(value) });

/** A Conviction Account request for the subscription of `epoch`: one inference budget of `value`, under the plan named `plan`. */
export const accountRequest = (accountId: bigint, epoch: bigint, sessionKey: string, value: bigint, plan: string): Request =>
  requestOf(accountId, epoch, { sessionKey, planDigest: ethers.id(plan), budgets: inference(value) });

/** The signing domain of the pool's requests and receipts. */
export const requestDomain = (c: Contracts): Promise<Domain> => queryInferenceDomain(c.qis);

/**
 * Requests of budget 0 of one subscription, one per value, each served in full,
 * signed by the subscription's session key (eth_signTypedData_v4 on anvil), as the
 * items of one group of a receipt batch, which lands for at least `minCounted`,
 * or for whatever the budget has left without one. Each result commitment names
 * the subscription, the seller and the nonce, so the sellers' items differ.
 */
export async function signedGroup(o: {
  domain: Domain;
  session: Signer;
  subscriptionId: string;
  seller: bigint;
  firstNonce: bigint;
  values: bigint[];
  issuedAt: bigint;
  minCounted?: bigint;
}): Promise<ReceiptGroup> {
  const items: ReceiptItem[] = [];
  for (let i = 0; i < o.values.length; i++) {
    const units = o.values[i] / UNIT_PRICE;
    const r: ServiceRequest = {
      subscriptionId: o.subscriptionId,
      serviceId: SERVICE0,
      seller: o.seller,
      nonce: o.firstNonce + BigInt(i),
      pricePerUnit: UNIT_PRICE,
      maxUnits: units,
      maxValueWei: units * UNIT_PRICE,
      issuedAt: o.issuedAt,
      expiry: o.issuedAt + DAY,
    };
    const sig = ethers.Signature.from(await o.session.signTypedData(o.domain, REQUEST_TYPES, r));
    const resultCommitment = ethers.keccak256(ethers.toUtf8Bytes(`result ${o.subscriptionId} ${o.seller} ${r.nonce}`));
    items.push(itemOf(r, fullReceipt(r, { resultCommitment }), { sigR: sig.r, sigVS: sig.yParityAndS }));
  }
  return { subscriptionId: o.subscriptionId, budgetIndex: 0n, minCounted: o.minCounted ?? 0n, items };
}

/** A receipt batch, submitted from the seller node's operational key. */
export async function submitBatch(ctx: Ctx, qs: Contracts['qs'], operational: Signer, label: string, groups: ReceiptGroup[]): Promise<Sent> {
  return send(ctx, label, operational, await qs.getAddress(), qs.interface.encodeFunctionData('submitReceiptBatch', [groups]));
}
