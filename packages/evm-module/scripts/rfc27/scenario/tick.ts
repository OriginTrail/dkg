// One tick of one beacon: first its buyers' duties, as their home, then its
// seller's. Every duty is decided from what the chain says now, so a crash or a
// rerun does nothing twice, and a failed tick heals at the next one. Requests are
// simulated: this process signs them with the buyers' session keys, derived from
// the seed, which stands in for the buyer's hop to the seller.

import { ethers } from 'ethers';

import { BUYER_GRANT_TYPES } from '../../../test/helpers/conviction-service';
import type { Domain } from '../../../test/helpers/conviction-service';
import { Fault, fullReceipt, itemOf, requestDigestOf, signCompact } from '../../../test/helpers/query-inference';
import type { ReceiptGroup, ServiceRequest } from '../../../test/helpers/query-inference';
import { errorMessage } from '../contracts';

import { chainNow, send, revertOf } from './chain';
import type { Contracts, Fields, Landed, Log, Revert, Sender, SendOutcome } from './chain';
import {
  BUYERS,
  COMPLETED_MARGIN_SECONDS,
  EPOCH_SECONDS,
  FIRST_EPOCH,
  GRANT_MAX_COST_TRAC,
  LAST_STRETCH_SECONDS,
  TRAC,
  eventOf,
  secondsOfDay,
  sellerNamed,
} from './config';
import type { Buyer, BuyerName, SellerName } from './config';
import { buyerWallet, ownerWallet, sessionWallet } from './keys';
import { callIsLive, landingDue, planDigestOf, planEpoch, serviceIdOf, subscriptionIdFor } from './plan';
import type { EpochPlan, PlannedBudget, PlannedCall, PlannedSubscription } from './plan';
import type { PublicFile } from './public';

const MAX_UINT = ethers.MaxUint256;
/** Nothing is sent this close to the epoch's end: it might land in the next. */
const END_MARGIN_SECONDS = 30;
/** Batches per tick, past which the rest waits for the next tick. */
const MAX_BATCHES_PER_TICK = 3;
/** Faulty items dropped from one batch, past which the batch waits for the next tick. */
const MAX_FAULT_DROPS = 8;
/** The gas limit of the held batch, which goes out unsimulated: its first group is refused before any item is read, well under this. */
export const HELD_BATCH_GAS_LIMIT = 500_000n;
/** Below this, a key's balance is logged as low. */
const LOW_ETH = 50_000_000_000_000n;

/** What a tick keeps between runs. Losing it costs one extra landing at most, and at worst a second failed send of the held batch. */
export interface TickState {
  retryLanding(epoch: number): boolean;
  setRetryLanding(epoch: number, on: boolean): void;
  heldDone(epoch: number): boolean;
  markHeldDone(epoch: number): void;
  unmarkHeldDone(epoch: number): void;
}

export type LandedGroup = { subscriptionId: string; budgetIndex: number; seller: number; itemCount: number; value: bigint; counted: bigint; stakeFactor18: bigint };

export type TickDeps = {
  provider: ethers.JsonRpcProvider;
  c: Contracts;
  seed: Uint8Array;
  pub: PublicFile;
  beacon: SellerName;
  /** This beacon's seller: its operational key. */
  seller: ethers.Signer;
  /** A derived key, as a signer on the provider. */
  signerOf: (wallet: ethers.Wallet) => ethers.Signer;
  log: Log;
  state: TickState;
  sender: Sender;
  /** Told of each batch that lands, with what its own receipt says. */
  onLanded?: (seller: SellerName, epoch: number, groups: LandedGroup[], receipt: Landed) => void;
  /** Told of the call the seller left out, and why. */
  onDropped?: (seller: SellerName, epoch: number, why: string, count: number) => void;
};

export type Times = { now: number; epoch: number; offset: number; start: number; secondsIn: number; secondsLeft: number };

let qiDomainCache: Domain | undefined;
let ssDomainCache: Domain | undefined;

const qiDomain = async (d: TickDeps): Promise<Domain> => {
  qiDomainCache ??= { name: 'DKGQueryInference', version: '1', chainId: (await d.provider.getNetwork()).chainId, verifyingContract: await d.c.qis.getAddress() };
  return qiDomainCache;
};

const ssDomain = async (d: TickDeps): Promise<Domain> => {
  ssDomainCache ??= { name: 'DKGServiceSubscriptions', version: '1', chainId: (await d.provider.getNetwork()).chainId, verifyingContract: await d.c.ss.getAddress() };
  return ssDomainCache;
};

const budgetTerms = (budgets: readonly PlannedBudget[]) => budgets.map((b) => ({ serviceId: b.serviceId, serviceClass: b.serviceClass, value: b.value, maxPricePerUnit: b.maxPricePerUnit }));

function accountIdOf(d: TickDeps, buyer: BuyerName): bigint {
  const id = d.pub.buyers.find((b) => b.name === buyer)?.accountId;
  if (id === null || id === undefined) throw new Error(`no account id for ${buyer} in the public file`);
  return BigInt(id);
}

/** The EIP-712 consent of a party to a grant. */
export const signGrant = async (wallet: ethers.Wallet, domain: Domain, terms: Record<string, unknown>): Promise<string> => wallet.signTypedData(domain, BUYER_GRANT_TYPES, terms);

export const domainOfGrants = ssDomain;

// ---------------------------------------------------------------------------
// A buyer's duties, on its home beacon
// ---------------------------------------------------------------------------

async function ensureAllowance(d: TickDeps, buyer: Buyer, signer: ethers.Signer, amount: bigint): Promise<boolean> {
  const address = await signer.getAddress();
  const spender = await d.c.ssw.getAddress();
  const allowance = (await d.c.token.allowance(address, spender)) as bigint;
  if (allowance >= amount) return true;
  const balance = (await d.c.token.balanceOf(address)) as bigint;
  const out = await send(d.sender, {
    label: `${buyer.name}: approve the wallet contract`,
    signer,
    to: await d.c.token.getAddress(),
    data: d.c.token.interface.encodeFunctionData('approve', [spender, balance > amount ? balance : amount]),
    fields: { buyer: buyer.name },
  });
  return out.sent;
}

async function fund(d: TickDeps, buyer: Buyer, plan: EpochPlan, sub: PlannedSubscription, signer: ethers.Signer): Promise<SendOutcome | undefined> {
  const request = {
    epoch: BigInt(plan.epoch),
    sessionKey: sessionWallet(d.seed, buyer.name, plan.epoch).address,
    planDigest: planDigestOf(plan.epoch, buyer.name, sub.budgets),
    budgets: budgetTerms(sub.budgets),
  };
  const fields: Fields = { buyer: buyer.name, epoch: plan.epoch, valueWei: sub.value.toString(), costWei: sub.cost.toString() };
  if (buyer.pays === 'wallet') {
    if (!(await ensureAllowance(d, buyer, signer, sub.value))) return undefined;
    return send(d.sender, { label: `${buyer.name}: fund from its wallet`, signer, to: await d.c.ssw.getAddress(), data: d.c.ssw.interface.encodeFunctionData('fundFromWallet', [request]), fields });
  }
  return send(d.sender, {
    label: `${buyer.name}: fund from its account`,
    signer,
    to: await d.c.ss.getAddress(),
    data: d.c.ss.interface.encodeFunctionData('fundFromAccount', [{ accountId: accountIdOf(d, buyer.name), ...request }]),
    fields,
  });
}

async function topUp(d: TickDeps, buyer: Buyer, plan: EpochPlan, sub: PlannedSubscription, signer: ethers.Signer, subscriptionId: string): Promise<void> {
  const t = sub.topUp;
  if (!t) return;
  const all = sub.budgets.map((b) => ({ ...b, value: b.value + (t.additions.find((a) => a.service === b.service)?.value ?? 0n) }));
  const planDigest = planDigestOf(plan.epoch, buyer.name, all);
  const fields: Fields = { buyer: buyer.name, epoch: plan.epoch, valueWei: t.value.toString(), costWei: t.cost.toString(), event: 'top-up' };
  if (buyer.pays === 'wallet') {
    if (!(await ensureAllowance(d, buyer, signer, t.value))) return;
    await send(d.sender, { label: `${buyer.name}: top up from its wallet`, signer, to: await d.c.ssw.getAddress(), data: d.c.ssw.interface.encodeFunctionData('topUpFromWallet', [subscriptionId, budgetTerms(t.additions), planDigest]), fields });
  } else {
    await send(d.sender, { label: `${buyer.name}: top up from its account`, signer, to: await d.c.ss.getAddress(), data: d.c.ss.interface.encodeFunctionData('topUpFromAccount', [subscriptionId, budgetTerms(t.additions), planDigest]), fields });
  }
}

async function buyerDuties(d: TickDeps, buyer: Buyer, t: Times, plan: EpochPlan): Promise<void> {
  const wallet = buyerWallet(d.seed, buyer.name);
  const signer = d.signerOf(wallet);
  const sub = plan.subscriptions.find((s) => s.buyer === buyer.name);
  if (!sub) return;
  const subscriptionId = subscriptionIdFor(wallet.address, plan.epoch);

  const balance = await d.provider.getBalance(wallet.address);
  if (balance < LOW_ETH) d.log.event('low-eth', { who: buyer.name, address: wallet.address, wei: balance.toString() });

  let grantRevokedAt = 0n;
  if (buyer.account) {
    const accountId = accountIdOf(d, buyer.name);
    const account = await d.c.pcs.getAccount(accountId);
    if (BigInt(t.now) >= (account.expiresAtTimestamp as bigint)) {
      d.log.event('account-expired', { buyer: buyer.name, accountId: accountId.toString() });
      return;
    }
    const grant = await d.c.sss.getGrant(accountId, wallet.address);
    grantRevokedAt = grant.revokedAt as bigint;
    // A grant removed in an earlier epoch comes back at the first tick of a later one, before the funding.
    if (grantRevokedAt !== 0n && Number(await d.c.chronos.epochAtTimestamp(grantRevokedAt)) < t.epoch) {
      const owner = ownerWallet(d.seed, buyer.name);
      const terms = {
        accountId,
        buyer: wallet.address,
        maxCostPerEpoch: BigInt(GRANT_MAX_COST_TRAC) * TRAC,
        expiresAt: account.expiresAtTimestamp as bigint,
        nonce: (await d.c.sss.grantNonce(accountId)) as bigint,
      };
      const consent = await signGrant(wallet, await ssDomain(d), terms);
      const out = await send(d.sender, {
        label: `${buyer.name}: its owner adds it again`,
        signer: d.signerOf(owner),
        to: await d.c.ss.getAddress(),
        data: d.c.ss.interface.encodeFunctionData('addBuyer', [terms, '0x', consent]),
        fields: { buyer: buyer.name, accountId: accountId.toString(), event: 'add-buyer' },
      });
      if (!out.sent) return;
      grantRevokedAt = 0n;
    }
  }

  // The epoch's subscription, whenever it does not exist yet.
  if (!((await d.c.sss.subscriptionExists(subscriptionId)) as boolean)) {
    if (t.secondsLeft < END_MARGIN_SECONDS) return;
    const out = await fund(d, buyer, plan, sub, signer);
    if (!out?.sent) return;
  }

  // The top-up, while the subscription is still what it was funded for.
  if (sub.topUp && t.secondsIn >= sub.topUp.atSecond && t.secondsLeft >= END_MARGIN_SECONDS) {
    const onChain = await d.c.sss.getSubscription(subscriptionId);
    if ((onChain.value as bigint) === sub.value) await topUp(d, buyer, plan, sub, signer, subscriptionId);
  }

  // The owner removes the buyer, once, at the time scripted.
  const removal = eventOf(t.offset, 'remove-buyer');
  if (buyer.account && removal?.who === buyer.name && t.secondsIn >= secondsOfDay(removal.atUtc) && grantRevokedAt === 0n && t.secondsLeft >= END_MARGIN_SECONDS) {
    await send(d.sender, {
      label: `${buyer.name}: its owner removes it`,
      signer: d.signerOf(ownerWallet(d.seed, buyer.name)),
      to: await d.c.ss.getAddress(),
      data: d.c.ss.interface.encodeFunctionData('removeBuyer', [accountIdOf(d, buyer.name), wallet.address]),
      fields: { buyer: buyer.name, event: 'remove-buyer' },
    });
  }
}

// ---------------------------------------------------------------------------
// The seller's duties
// ---------------------------------------------------------------------------

type Ready = { call: PlannedCall; subscriptionId: string; budgetIndex: number; order: number };

/** The calls that can be on the chain: the seller's own, of live subscriptions, and not landed yet. */
async function readyCalls(d: TickDeps, plan: EpochPlan, calls: readonly PlannedCall[], sellerId: number, seller: SellerName, checkNonces: boolean): Promise<Ready[]> {
  const ready: Ready[] = [];
  const dropped: Record<string, number> = {};
  for (let order = 0; order < BUYERS.length; order++) {
    const buyer = BUYERS[order];
    const own = calls.filter((c) => c.buyer === buyer.name);
    if (own.length === 0) continue;
    const address = buyerWallet(d.seed, buyer.name).address;
    const subscriptionId = subscriptionIdFor(address, plan.epoch);
    const s = await d.c.sss.getSubscription(subscriptionId);
    if ((s.startsAt as bigint) === 0n) {
      d.log.event('no-subscription', { seller, buyer: buyer.name, epoch: plan.epoch, calls: own.length });
      continue;
    }
    if (ethers.getAddress(s.sessionKey as string) !== sessionWallet(d.seed, buyer.name, plan.epoch).address) {
      d.log.event('unexpected-session-key', { seller, buyer: buyer.name, epoch: plan.epoch });
      continue;
    }
    const budgets = (await d.c.sss.getBudgets(subscriptionId)) as { serviceId: string }[];
    const grantEnd = (s.accountId as bigint) === 0n ? MAX_UINT : ((await d.c.sss.grantEnd(s.accountId, s.buyer, s.grantNonce)) as bigint);
    const words = new Map<bigint, bigint>();
    for (const call of own) {
      const budgetIndex = budgets.findIndex((b) => b.serviceId === serviceIdOf(call.service));
      if (budgetIndex < 0) {
        dropped['no budget for the service'] = (dropped['no budget for the service'] ?? 0) + 1;
        continue;
      }
      if (!callIsLive(call, { startsAt: s.startsAt as bigint, grantEnd })) {
        const why = BigInt(call.issuedAt) < (s.startsAt as bigint) ? 'issued before the subscription started' : 'issued after the grant ended';
        dropped[why] = (dropped[why] ?? 0) + 1;
        continue;
      }
      if (checkNonces) {
        const word = call.nonce >> 8n;
        let bits = words.get(word);
        if (bits === undefined) {
          bits = (await d.c.qis.nonceWord(subscriptionId, sellerId, word)) as bigint;
          words.set(word, bits);
        }
        if ((bits >> (call.nonce & 0xffn)) & 1n) continue;
      }
      ready.push({ call, subscriptionId, budgetIndex, order });
    }
  }
  for (const [why, count] of Object.entries(dropped)) {
    d.log.event('calls-left-out', { seller, epoch: plan.epoch, why, count });
    d.onDropped?.(seller, plan.epoch, why, count);
  }
  ready.sort((a, b) => a.order - b.order || a.budgetIndex - b.budgetIndex || (a.call.nonce < b.call.nonce ? -1 : 1));
  return ready;
}

/** One group per budget: its request signed by the session key, its receipt the seller's. minCounted is always 0: a group lands for whatever the budget has left. */
function groupsOf(d: TickDeps, domain: Domain, epoch: number, sellerId: number, ready: readonly Ready[]): ReceiptGroup[] {
  const groups: ReceiptGroup[] = [];
  for (const r of ready) {
    let group = groups[groups.length - 1];
    if (!group || group.subscriptionId !== r.subscriptionId || group.budgetIndex !== BigInt(r.budgetIndex)) {
      group = { subscriptionId: r.subscriptionId, budgetIndex: BigInt(r.budgetIndex), minCounted: 0n, items: [] };
      groups.push(group);
    }
    const c = r.call;
    const request: ServiceRequest = {
      subscriptionId: r.subscriptionId,
      serviceId: serviceIdOf(c.service),
      seller: BigInt(sellerId),
      nonce: c.nonce,
      pricePerUnit: c.price,
      maxUnits: c.maxUnits,
      maxValueWei: c.maxUnits * c.price,
      issuedAt: BigInt(c.issuedAt),
      expiry: BigInt(c.expiry),
    };
    const session = sessionWallet(d.seed, c.buyer, epoch);
    const receipt = fullReceipt(request, { resultCommitment: c.resultCommitment, units: c.units, valueWei: c.value, completedAt: BigInt(c.completedAt) });
    group.items.push(itemOf(request, receipt, signCompact(session as unknown as ethers.HDNodeWallet, requestDigestOf(domain, request))));
  }
  return groups;
}

/** As many calls as one batch takes, in order. */
function takeBatch(ready: readonly Ready[], maxGroups: number, maxItems: number): Ready[] {
  const out: Ready[] = [];
  let groups = 0;
  let last = '';
  for (const r of ready) {
    const key = `${r.subscriptionId}/${r.budgetIndex}`;
    if (key !== last) {
      if (groups === maxGroups) break;
      groups++;
      last = key;
    }
    if (out.length === maxItems) break;
    out.push(r);
  }
  return out;
}

function landedGroups(d: TickDeps, receipt: Landed): LandedGroup[] {
  const out: LandedGroup[] = [];
  const qs = d.c.qs.target as string;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== qs.toLowerCase()) continue;
    const parsed = d.c.qs.interface.parseLog({ topics: log.topics, data: log.data });
    if (parsed?.name !== 'ReceiptsLanded') continue;
    out.push({
      subscriptionId: parsed.args.subscriptionId as string,
      budgetIndex: Number(parsed.args.budgetIndex),
      seller: Number(parsed.args.seller),
      itemCount: Number(parsed.args.itemCount),
      value: parsed.args.value as bigint,
      counted: parsed.args.counted as bigint,
      stakeFactor18: parsed.args.stakeFactor18 as bigint,
    });
  }
  return out;
}

/** One batch, its faulty items and groups left out and simulated again: any fault would refuse the whole of it. The calls it leaves out are logged with the reason. */
async function landBatch(d: TickDeps, seller: SellerName, sellerId: number, t: Times, batch: Ready[], domain: Domain): Promise<{ landed: Ready[]; outcome: SendOutcome }> {
  let current = batch;
  const to = await d.c.qs.getAddress();
  for (let tries = 0; ; tries++) {
    const groups = groupsOf(d, domain, t.epoch, sellerId, current);
    const outcome = await send(d.sender, {
      label: `${seller}: land a batch`,
      signer: d.seller,
      to,
      data: d.c.qs.interface.encodeFunctionData('submitReceiptBatch', [groups]),
      lastStretch: t.secondsIn >= EPOCH_SECONDS - LAST_STRETCH_SECONDS,
      fields: { seller, epoch: t.epoch, groups: groups.length, items: current.length, faultDrops: tries },
    });
    if (outcome.sent || outcome.why !== 'reverted' || tries >= MAX_FAULT_DROPS) return { landed: outcome.sent ? current : [], outcome };
    const dropped = withoutFaulty(current, groups, outcome.revert);
    if (!dropped) return { landed: [], outcome };
    d.log.event('fault-left-out', { seller, epoch: t.epoch, why: outcome.revert.text, left: dropped.length });
    if (dropped.length === 0) return { landed: [], outcome };
    current = dropped;
  }
}

/** The batch without what `revert` faults, or undefined if the revert names no item or group. */
function withoutFaulty(current: readonly Ready[], groups: readonly ReceiptGroup[], revert: Revert): Ready[] | undefined {
  const keyOf = (g: ReceiptGroup) => `${g.subscriptionId}/${g.budgetIndex}`;
  const keyOfReady = (r: Ready) => `${r.subscriptionId}/${r.budgetIndex}`;
  if (revert.name === 'GroupFault') {
    const key = keyOf(groups[Number(revert.args[0])]);
    return current.filter((r) => keyOfReady(r) !== key);
  }
  if (revert.name === 'ReceiptFault') {
    const group = groups[Number(revert.args[0])];
    const item = group.items[Number(revert.args[1])];
    return current.filter((r) => !(keyOfReady(r) === keyOf(group) && r.call.nonce === item.nonce));
  }
  return undefined;
}

async function land(d: TickDeps, seller: SellerName, sellerId: number, t: Times, plan: EpochPlan): Promise<void> {
  const score = (await d.c.rss.getNodeEpochScore(t.epoch, sellerId)) as bigint;
  if (score === 0n) {
    // A real node proves regularly: the next tick tries again.
    d.log.event('no-node-score', { seller, epoch: t.epoch });
    d.state.setRetryLanding(t.epoch, true);
    return;
  }
  const own = plan.calls.filter((c) => c.seller === seller && !c.held && c.completedAt <= t.now - COMPLETED_MARGIN_SECONDS);
  let ready = await readyCalls(d, plan, own, sellerId, seller, true);
  d.log.event('landing', { seller, epoch: t.epoch, secondsIn: t.secondsIn, assignedSoFar: own.length, ready: ready.length });
  const state = await d.c.qis.batchState();
  const domain = await qiDomain(d);
  let failed = false;
  for (let n = 0; n < MAX_BATCHES_PER_TICK && ready.length > 0; n++) {
    const batch = takeBatch(ready, Number(state.maxGroups), Number(state.maxItems));
    const { landed, outcome } = await landBatch(d, seller, sellerId, t, batch, domain);
    if (!outcome.sent) {
      failed = true;
      if (outcome.why === 'reverted' && outcome.revert.name === 'NoNodeScore') d.log.event('no-node-score', { seller, epoch: t.epoch });
      break;
    }
    const groups = landedGroups(d, outcome.receipt);
    const value = groups.reduce((a, g) => a + g.value, 0n);
    const counted = groups.reduce((a, g) => a + g.counted, 0n);
    d.log.event('batch-landed', { seller, epoch: t.epoch, hash: outcome.receipt.hash, items: landed.length, groups: groups.length, valueWei: value.toString(), countedWei: counted.toString(), gasUsed: outcome.receipt.gasUsed.toString() });
    for (const g of groups) {
      if (g.counted < g.value) {
        d.log.event('budget-limit', { seller, epoch: t.epoch, subscriptionId: g.subscriptionId, budgetIndex: g.budgetIndex, valueWei: g.value.toString(), countedWei: g.counted.toString(), hash: outcome.receipt.hash });
      }
    }
    d.onLanded?.(seller, t.epoch, groups, outcome.receipt);
    const done = new Set(batch);
    ready = ready.filter((r) => !done.has(r));
  }
  d.state.setRetryLanding(t.epoch, failed);
}

/**
 * The batch held past the epoch's end, sent once that epoch has ended, so that the
 * chain records a failed transaction: it goes out unsimulated, with a fixed gas
 * limit, once the node has a score in the new epoch, as NoNodeScore would otherwise
 * come first. It is marked before it goes out, so a crash loses the send rather than
 * repeating it. The chain keeps no reason, so it is read by calling the same batch at
 * that block, and logged as expected.
 */
export async function heldBatch(d: TickDeps, seller: SellerName, sellerId: number, t: Times): Promise<void> {
  const previous = t.epoch - 1;
  if (previous < FIRST_EPOCH || eventOf(previous - FIRST_EPOCH, 'held-batch')?.who !== seller) return;
  if (d.state.heldDone(previous)) return;
  const plan = planEpoch(d.seed, previous);
  const held = plan.calls.filter((c) => c.seller === seller && c.held);
  const ready = await readyCalls(d, plan, held, sellerId, seller, false);
  if (ready.length === 0) {
    d.log.event('held-batch-empty', { seller, epoch: previous });
    d.state.markHeldDone(previous);
    return;
  }
  if (((await d.c.rss.getNodeEpochScore(t.epoch, sellerId)) as bigint) === 0n) {
    d.log.event('held-batch-waits', { seller, epoch: previous, note: 'it goes out once the node has proved in this epoch' });
    return;
  }
  const domain = await qiDomain(d);
  const groups = groupsOf(d, domain, previous, sellerId, ready);
  const value = ready.reduce((a, r) => a + r.call.value, 0n);
  const from = await d.seller.getAddress();
  const to = await d.c.qs.getAddress();
  const data = d.c.qs.interface.encodeFunctionData('submitReceiptBatch', [groups]);
  const fields: Fields = { seller, epoch: previous, items: ready.length, valueWei: value.toString() };

  d.state.markHeldDone(previous);
  const outcome = await send(d.sender, { label: `${seller}: send the held batch, past its epoch`, signer: d.seller, to, data, unsimulatedGasLimit: HELD_BATCH_GAS_LIMIT, fields: { ...fields, event: 'held-batch' } });
  if (outcome.sent) {
    d.log.event('held-batch-unexpected', { ...fields, hash: outcome.receipt.hash, note: 'the held batch landed' });
  } else if (outcome.why === 'reverted-on-chain') {
    let revert: Revert | undefined;
    try {
      await d.provider.call({ from, to, data, blockTag: outcome.receipt.block });
    } catch (e: unknown) {
      revert = revertOf(e);
    }
    const expected = revert?.name === 'GroupFault' && revert.args[1] === Fault.OutsideEpoch;
    d.log.event('held-batch-missed', { ...fields, expected, why: revert?.text ?? 'the reason could not be read', hash: outcome.receipt.hash, gasUsed: outcome.receipt.gasUsed.toString(), feeWei: outcome.receipt.fee.toString(), block: outcome.receipt.block });
  } else if (outcome.why !== 'reverted' && !outcome.attempted) {
    // Nothing went out, so the next tick sends it.
    d.state.unmarkHeldDone(previous);
  } else {
    d.log.event('held-batch-unknown', { ...fields, note: 'it may have gone out, so it is not sent again' });
  }
}

async function sellerDuties(d: TickDeps, t: Times, plan: EpochPlan): Promise<void> {
  const seller = sellerNamed(d.beacon);
  await heldBatch(d, seller.name, seller.identityId, t);
  if (t.secondsLeft < END_MARGIN_SECONDS) return;
  if (!landingDue(d.seed, t.epoch, seller.name, t.secondsIn) && !d.state.retryLanding(t.epoch)) return;
  const address = await d.seller.getAddress();
  const balance = await d.provider.getBalance(address);
  if (balance < LOW_ETH) d.log.event('low-eth', { who: seller.name, address, wei: balance.toString() });
  await land(d, seller.name, seller.identityId, t, plan);
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/** Before the first epoch: the whole read path, and one funding only simulated, whose refusal shows the endpoint, the keys and the decoding work. */
async function waiting(d: TickDeps, t: Times): Promise<void> {
  const seller = sellerNamed(d.beacon);
  const address = await d.seller.getAddress();
  const identity = Number(await d.c.ids.getIdentityId(address));
  d.log.event('waiting-for-first-epoch', {
    seller: seller.name,
    epoch: t.epoch,
    secondsToFirst: FIRST_EPOCH_START_OF(t) - t.now,
    identity,
    identityMatches: identity === seller.identityId,
    ethWei: (await d.provider.getBalance(address)).toString(),
    nodeScore: ((await d.c.rss.getNodeEpochScore(t.epoch, seller.identityId)) as bigint).toString(),
  });
  const plan = planEpoch(d.seed, FIRST_EPOCH);
  for (const buyer of BUYERS.filter((b) => b.home === d.beacon)) {
    const sub = plan.subscriptions.find((s) => s.buyer === buyer.name);
    if (!sub) continue;
    const wallet = buyerWallet(d.seed, buyer.name);
    const request = { epoch: BigInt(FIRST_EPOCH), sessionKey: sessionWallet(d.seed, buyer.name, FIRST_EPOCH).address, planDigest: planDigestOf(FIRST_EPOCH, buyer.name, sub.budgets), budgets: budgetTerms(sub.budgets) };
    const data =
      buyer.pays === 'wallet'
        ? d.c.ssw.interface.encodeFunctionData('fundFromWallet', [request])
        : d.c.ss.interface.encodeFunctionData('fundFromAccount', [{ accountId: BigInt(d.pub.buyers.find((b) => b.name === buyer.name)?.accountId ?? 0), ...request }]);
    const to = buyer.pays === 'wallet' ? await d.c.ssw.getAddress() : await d.c.ss.getAddress();
    try {
      await d.provider.estimateGas({ from: wallet.address, to, data });
      d.log.event('simulated-funding', { buyer: buyer.name, outcome: 'would succeed' });
    } catch (e: unknown) {
      const revert = revertOf(e);
      d.log.event('simulated-funding', { buyer: buyer.name, outcome: revert ? revert.text : errorMessage(e).slice(0, 200) });
    }
  }
}

const FIRST_EPOCH_START_OF = (t: Times): number => t.start + (FIRST_EPOCH - t.epoch) * EPOCH_SECONDS;

export async function runTick(d: TickDeps): Promise<void> {
  const now = await chainNow(d.provider);
  const epoch = Number(await d.c.chronos.getCurrentEpoch());
  const start = Number(await d.c.chronos.timestampForEpoch(epoch));
  const t: Times = { now, epoch, offset: epoch - FIRST_EPOCH, start, secondsIn: now - start, secondsLeft: start + EPOCH_SECONDS - now };
  d.log.event('tick', { beacon: d.beacon, epoch, offset: t.offset, chainTime: now, secondsIn: t.secondsIn });
  if (epoch < FIRST_EPOCH) {
    await waiting(d, t);
    return;
  }
  const plan = planEpoch(d.seed, epoch);
  for (const buyer of BUYERS.filter((b) => b.home === d.beacon)) {
    try {
      await buyerDuties(d, buyer, t, plan);
    } catch (e: unknown) {
      d.log.event('duty-error', { beacon: d.beacon, buyer: buyer.name, error: errorMessage(e).slice(0, 300), revert: revertOf(e)?.text });
    }
  }
  try {
    await sellerDuties(d, t, plan);
  } catch (e: unknown) {
    d.state.setRetryLanding(epoch, true);
    d.log.event('duty-error', { beacon: d.beacon, seller: d.beacon, error: errorMessage(e).slice(0, 300), revert: revertOf(e)?.text });
  }
}

