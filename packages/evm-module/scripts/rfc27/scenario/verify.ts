// What the chain says of an epoch, against the plan and the rollover rule. It
// reads only state, never logs: the public endpoint limits them. A ledger of the
// batches' own receipts, where there is one, makes the checks of each node exact.

import { ethers } from 'ethers';

import type { Contracts } from './chain';
import { FIRST_EPOCH, SELLERS, buyerNamed } from './config';
import type { SellerName } from './config';
import { buyerWallet, sessionWallet } from './keys';
import { callIsLive, planEpoch, serviceIdOf, subscriptionIdFor, valueOf } from './plan';
import type { PublicFile } from './public';
import type { LandedGroup } from './tick';

export type Check = { ok: boolean; what: string; detail?: string };

/** The receipts of every batch that landed, by epoch. */
export class Ledger {
  readonly groups = new Map<number, (LandedGroup & { sellerName: SellerName })[]>();

  add(seller: SellerName, epoch: number, groups: readonly LandedGroup[]): void {
    const list = this.groups.get(epoch) ?? [];
    for (const g of groups) list.push({ ...g, sellerName: seller });
    this.groups.set(epoch, list);
  }
}

export type NodeNumbers = { seller: string; identityId: number; served: bigint; weighted: bigint; gross: bigint };
export type EpochNumbers = {
  epoch: number;
  offset: number;
  walletFunding: bigint;
  accountFunding: bigint;
  money: bigint;
  totalServed: bigint;
  totalWeighted: bigint;
  lambdaBps: number;
  pool: bigint;
  nodes: NodeNumbers[];
};

export async function readEpoch(c: Contracts, epoch: number): Promise<EpochNumbers> {
  const [walletFunding, accountFunding] = (await c.qis.fundingIn(epoch)) as [bigint, bigint];
  const totals = await c.qis.getEpochTotals(epoch);
  const nodes: NodeNumbers[] = [];
  for (const s of SELLERS) {
    const n = await c.qis.getNodeEpoch(s.identityId, epoch);
    nodes.push({ seller: s.name, identityId: s.identityId, served: n.servedValue as bigint, weighted: n.weightedValue as bigint, gross: (await c.qs.queryInferenceGross(epoch, s.identityId)) as bigint });
  }
  return {
    epoch,
    offset: epoch - FIRST_EPOCH,
    walletFunding,
    accountFunding,
    money: walletFunding + accountFunding,
    totalServed: totals.totalServed as bigint,
    totalWeighted: totals.totalWeighted as bigint,
    lambdaBps: Number(totals.lambdaBps),
    pool: (await c.qs.epochPool(epoch)) as bigint,
    nodes,
  };
}

const eq = (a: bigint, b: bigint): boolean => a === b;
const show = (v: bigint): string => ethers.formatEther(v);

/** The pool the rollover rule gives: the epoch's money, plus that of the unbroken run of epochs before it with no served value, back to the activation epoch. 0 with no served value. */
export async function poolByRule(c: Contracts, epoch: number, activation: number): Promise<bigint> {
  const totals = await c.qis.getEpochTotals(epoch);
  if ((totals.totalServed as bigint) === 0n) return 0n;
  let [w, a] = (await c.qis.fundingIn(epoch)) as [bigint, bigint];
  let pool = w + a;
  for (let e = epoch - 1; e >= activation; e--) {
    const t = await c.qis.getEpochTotals(e);
    if ((t.totalServed as bigint) !== 0n) break;
    [w, a] = (await c.qis.fundingIn(e)) as [bigint, bigint];
    pool += w + a;
  }
  return pool;
}

/**
 * The checks of one epoch. `ended` says its numbers are final, and every call the
 * plan has should then be settled one way or the other.
 */
export async function checkEpoch(c: Contracts, seed: Uint8Array, pub: PublicFile, epoch: number, ended: boolean, now: number, ledger?: Ledger): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (ok: boolean, what: string, detail?: string) => checks.push({ ok, what, detail });
  const plan = planEpoch(seed, epoch);
  const activation = Number(await c.qis.activationEpoch());

  let expectedWallet = 0n;
  let expectedAccount = 0n;
  /** A node's served value, by the plan, from the budgets no race can clip. */
  const servedByPlan = new Map<string, bigint>();
  let servedOfBudgets = 0n;
  let raceBudgets = 0;

  for (const sub of plan.subscriptions) {
    const buyer = buyerNamed(sub.buyer);
    const address = buyerWallet(seed, sub.buyer).address;
    const id = subscriptionIdFor(address, epoch);
    const s = await c.sss.getSubscription(id);
    if ((s.startsAt as bigint) === 0n) {
      // Without a subscription, the buyer's money and its calls are simply absent.
      check(!ended, `${sub.buyer}: subscription of epoch ${epoch} exists`, 'absent');
      continue;
    }
    check(ethers.getAddress(s.buyer as string) === address, `${sub.buyer}: subscription's buyer`);
    check(ethers.getAddress(s.sessionKey as string) === sessionWallet(seed, sub.buyer, epoch).address, `${sub.buyer}: session key is the derived one`);
    check(Number(s.discountBps) === sub.discountBps, `${sub.buyer}: discount`, `${s.discountBps} vs ${sub.discountBps}`);

    const toppedUp = sub.topUp !== undefined && (s.value as bigint) === sub.value + sub.topUp.value;
    const value = sub.value + (toppedUp && sub.topUp ? sub.topUp.value : 0n);
    const cost = sub.cost + (toppedUp && sub.topUp ? sub.topUp.cost : 0n);
    check(eq(s.value as bigint, value), `${sub.buyer}: subscription value`, `${show(s.value as bigint)} vs ${show(value)}`);
    check(eq(s.cost as bigint, cost), `${sub.buyer}: subscription cost, at its discount`, `${show(s.cost as bigint)} vs ${show(cost)}`);
    if (buyer.pays === 'wallet') {
      expectedWallet += cost;
      check((s.accountId as bigint) === 0n, `${sub.buyer}: wallet subscription under account 0`);
    } else {
      expectedAccount += cost;
      const accountId = pub.buyers.find((b) => b.name === sub.buyer)?.accountId;
      check(String(s.accountId) === String(accountId), `${sub.buyer}: funded from its account`, `${s.accountId} vs ${accountId}`);
    }

    const grantEnd = (s.accountId as bigint) === 0n ? ethers.MaxUint256 : ((await c.sss.grantEnd(s.accountId, s.buyer, s.grantNonce)) as bigint);
    const live = { startsAt: s.startsAt as bigint, grantEnd };
    const budgets = (await c.sss.getBudgets(id)) as { serviceId: string; serviceClass: bigint; value: bigint; maxPricePerUnit: bigint }[];
    check(budgets.length === sub.budgets.length, `${sub.buyer}: budget count`);
    for (let i = 0; i < sub.budgets.length; i++) {
      const b = sub.budgets[i];
      const onChain = budgets[i];
      if (!onChain) continue;
      const added = toppedUp ? (sub.topUp?.additions.find((a) => a.service === b.service)?.value ?? 0n) : 0n;
      check(onChain.serviceId === serviceIdOf(b.service), `${sub.buyer}/${b.service}: budget ${i} is this service`);
      check(eq(onChain.value, b.value + added), `${sub.buyer}/${b.service}: budget value`, `${show(onChain.value)} vs ${show(b.value + added)}`);
      check(eq(onChain.maxPricePerUnit, b.maxPricePerUnit), `${sub.buyer}/${b.service}: price cap`);

      // Which calls landed, by the seller's nonce bits, and what the budget has used.
      const calls = plan.calls.filter((x) => x.buyer === sub.buyer && x.service === b.service);
      const done = ended ? calls : calls.filter((x) => x.completedAt < now);
      const words = new Map<string, bigint>();
      const isSet = async (x: (typeof calls)[number]): Promise<boolean> => {
        const seller = SELLERS.find((n) => n.name === x.seller);
        const key = `${x.seller}/${x.nonce >> 8n}`;
        let bits = words.get(key);
        if (bits === undefined) {
          bits = (await c.qis.nonceWord(id, seller?.identityId ?? 0, x.nonce >> 8n)) as bigint;
          words.set(key, bits);
        }
        return ((bits >> (x.nonce & 0xffn)) & 1n) === 1n;
      };
      let landedValue = 0n;
      let wronglyLanded = 0;
      let unlanded = 0;
      for (const x of done) {
        const set = await isSet(x);
        const shouldExist = callIsLive(x, live) && !x.held;
        if (set && !shouldExist) wronglyLanded++;
        if (!set && shouldExist && ended) unlanded++;
        if (set) landedValue += x.value;
      }
      check(wronglyLanded === 0, `${sub.buyer}/${b.service}: no call landed that should not have`, `${wronglyLanded} did`);
      if (ended) check(unlanded === 0, `${sub.buyer}/${b.service}: every call that should land did`, `${unlanded} did not`);
      const used = (await c.qis.budgetUsed(id, i)) as bigint;
      const left = (await c.qs.budgetLeft(id, i)) as bigint;
      check(eq(left, onChain.value - used), `${sub.buyer}/${b.service}: budgetLeft reads value less used`);
      const expectedUsed = landedValue < onChain.value ? landedValue : onChain.value;
      check(eq(used, expectedUsed), `${sub.buyer}/${b.service}: used is the landed value, up to the budget`, `${show(used)} vs ${show(expectedUsed)}`);
      servedOfBudgets += (used * BigInt(10_000 - sub.discountBps)) / 10_000n;

      const raced = calls.some((x) => x.race);
      if (raced) {
        raceBudgets++;
        if (ended) {
          check(valueOf(calls.filter((x) => callIsLive(x, live) && !x.held)) > onChain.value, `${sub.buyer}/${b.service}: the race's demand is past the budget's limit`);
          check(eq(used, onChain.value), `${sub.buyer}/${b.service}: the race fills the budget exactly`, `${show(used)} of ${show(onChain.value)}`);
        }
      } else {
        for (const x of done) {
          if (await isSet(x)) servedByPlan.set(x.seller, (servedByPlan.get(x.seller) ?? 0n) + (x.value * BigInt(10_000 - sub.discountBps)) / 10_000n);
        }
      }
    }
  }

  const n = await readEpoch(c, epoch);
  check(eq(n.walletFunding, expectedWallet), `epoch ${epoch}: wallet funding is the plan's`, `${show(n.walletFunding)} vs ${show(expectedWallet)}`);
  check(eq(n.accountFunding, expectedAccount), `epoch ${epoch}: account funding is the plan's, at each discount`, `${show(n.accountFunding)} vs ${show(expectedAccount)}`);

  const sumServed = n.nodes.reduce((a, x) => a + x.served, 0n);
  const sumWeighted = n.nodes.reduce((a, x) => a + x.weighted, 0n);
  check(eq(sumServed, n.totalServed), `epoch ${epoch}: the nodes' served value sums to the epoch's`);
  check(eq(sumWeighted, n.totalWeighted), `epoch ${epoch}: the nodes' weighted value sums to the epoch's`);
  check(eq(n.totalServed, servedOfBudgets), `epoch ${epoch}: served value is what the budgets counted, at each discount`, `${show(n.totalServed)} vs ${show(servedOfBudgets)}`);

  for (const node of n.nodes) {
    const fromPlan = servedByPlan.get(node.seller) ?? 0n;
    // A race's value is split by landing order, so the racers read at least the rest.
    if (raceBudgets === 0) check(eq(node.served, fromPlan), `epoch ${epoch}: ${node.seller}'s served value is the plan's`, `${show(node.served)} vs ${show(fromPlan)}`);
    else check(node.served >= fromPlan, `epoch ${epoch}: ${node.seller}'s served value holds the plan's unraced calls`, `${show(node.served)} vs ${show(fromPlan)}`);
  }

  if (n.totalServed > 0n) check(n.lambdaBps === 5_000, `epoch ${epoch}: λ is 5000`, `${n.lambdaBps}`);
  const rule = await poolByRule(c, epoch, activation);
  check(eq(n.pool, rule), `epoch ${epoch}: the pool is the rollover rule's`, `${show(n.pool)} vs ${show(rule)}`);
  if (n.pool > 0n) {
    let sumGross = 0n;
    for (const node of n.nodes) {
      const lam = BigInt(n.lambdaBps);
      const expected =
        n.totalServed === 0n
          ? 0n
          : (n.pool * (10_000n - lam) * node.served) / (10_000n * n.totalServed) + (n.totalWeighted === 0n ? 0n : (n.pool * lam * node.weighted) / (10_000n * n.totalWeighted));
      check(eq(node.gross, expected), `epoch ${epoch}: ${node.seller}'s gross is pool × QIF`, `${show(node.gross)} vs ${show(expected)}`);
      sumGross += node.gross;
    }
    const withValue = BigInt(n.nodes.filter((x) => x.served > 0n).length);
    check(sumGross <= n.pool && sumGross > n.pool - 2n * withValue - 1n, `epoch ${epoch}: the gross rewards sum to the pool, less under 2 wei per node`, `${show(sumGross)} of ${show(n.pool)}`);
  }

  if (ledger) {
    const groups = ledger.groups.get(epoch) ?? [];
    const servedOf = new Map<number, bigint>();
    const weightedOf = new Map<number, bigint>();
    const usedOf = new Map<string, bigint>();
    const subs = new Map<string, bigint>();
    for (const g of groups) {
      let d = subs.get(g.subscriptionId);
      if (d === undefined) {
        d = BigInt((await c.sss.getSubscription(g.subscriptionId)).discountBps as bigint);
        subs.set(g.subscriptionId, d);
      }
      const served = (g.counted * (10_000n - d)) / 10_000n;
      const weighted = (served * g.stakeFactor18) / 10n ** 18n;
      servedOf.set(g.seller, (servedOf.get(g.seller) ?? 0n) + served);
      weightedOf.set(g.seller, (weightedOf.get(g.seller) ?? 0n) + weighted);
      const key = `${g.subscriptionId}/${g.budgetIndex}`;
      usedOf.set(key, (usedOf.get(key) ?? 0n) + g.counted);
    }
    for (const node of n.nodes) {
      check(eq(node.served, servedOf.get(node.identityId) ?? 0n), `epoch ${epoch}: ${node.seller}'s served value, by each group's floor of its own receipt`, `${show(node.served)} vs ${show(servedOf.get(node.identityId) ?? 0n)}`);
      check(eq(node.weighted, weightedOf.get(node.identityId) ?? 0n), `epoch ${epoch}: ${node.seller}'s weighted value, by each group's stake factor and floor`, `${show(node.weighted)} vs ${show(weightedOf.get(node.identityId) ?? 0n)}`);
    }
    for (const [key, counted] of usedOf) {
      const [id, index] = key.split('/');
      const used = (await c.qis.budgetUsed(id, Number(index))) as bigint;
      check(eq(used, counted), `epoch ${epoch}: a budget's used is the sum its batches counted`, `${show(used)} vs ${show(counted)}`);
    }
  }
  return checks;
}

