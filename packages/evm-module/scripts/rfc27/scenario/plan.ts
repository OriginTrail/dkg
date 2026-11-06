// The scenario's plan: a pure function of the seed and the epoch. Every beacon,
// and the checks, derive the same subscriptions and the same calls, so nothing
// about them is stored: integers only, no clock, no chain, no randomness but the
// seed's. A call is a function of (seed, epoch, buyer, service, time slot), which
// gives its seller, its units and its nonce.

import { ethers } from 'ethers';

import { costOf, subscriptionIdOf } from '../../../test/helpers/conviction-service';

import {
  BUYERS,
  EPOCH_SECONDS,
  FIRST_CALL_SLOT,
  FIRST_EPOCH,
  FIRST_EPOCH_START,
  LAST_CALL_SLOT,
  LAST_STRETCH_SECONDS,
  MAIN_SELLER_SHARE_BPS,
  RACE_BASELINE_BPS,
  RACE_CALL_BPS,
  REQUEST_TTL_SECONDS,
  SELLERS,
  SERVICES,
  SLOT_SECONDS,
  TICK_SECONDS,
  TOP_UP_SHARE_BPS,
  TRAC,
  VALUE_VARIATION_BPS,
  eventOf,
  secondsOfDay,
  sellerNamed,
  serviceNamed,
} from './config';
import type { Buyer, BuyerName, SellerName, ServiceLabel } from './config';

export type PlannedBudget = {
  service: ServiceLabel;
  serviceId: string;
  serviceClass: bigint;
  value: bigint;
  maxPricePerUnit: bigint;
};

export type PlannedTopUp = {
  /** Seconds into the epoch from which it is due. */
  atSecond: number;
  /** In strictly increasing serviceId, as the contract requires. */
  additions: PlannedBudget[];
  value: bigint;
  cost: bigint;
};

export type PlannedSubscription = {
  buyer: BuyerName;
  /** In strictly increasing serviceId, as the contract requires. */
  budgets: PlannedBudget[];
  value: bigint;
  cost: bigint;
  discountBps: number;
  topUp?: PlannedTopUp;
};

export type PlannedCall = {
  buyer: BuyerName;
  service: ServiceLabel;
  slot: number;
  seller: SellerName;
  /** Unique per subscription: (service index << 8) | slot. All of a service's nonces share one word of the seller's bitmap. */
  nonce: bigint;
  units: bigint;
  maxUnits: bigint;
  price: bigint;
  value: bigint;
  issuedAt: number;
  completedAt: number;
  expiry: number;
  resultCommitment: string;
  /** One of the two sellers' calls of the race, past the budget's limit. */
  race: boolean;
  /** Held past the end of the epoch by its seller, so it misses. */
  held: boolean;
};

export type EpochPlan = {
  epoch: number;
  offset: number;
  start: number;
  end: number;
  subscriptions: PlannedSubscription[];
  calls: PlannedCall[];
};

/** A label's bytes under the seed: every draw of the plan is one of these. */
function draw(seed: Uint8Array, label: string): Uint8Array {
  return ethers.getBytes(ethers.keccak256(ethers.concat([seed, ethers.toUtf8Bytes(`rfc27-scenario/plan/${label}`)])));
}

const u16 = (b: Uint8Array, i: number): number => (b[i] << 8) | b[i + 1];
/** Two of a draw's bytes as basis points, 0 to 9,999. */
const bps = (b: Uint8Array, i: number): number => (u16(b, i) * 10_000) >>> 16;
const between = (lo: number, hi: number, b: Uint8Array, i: number): number => lo + Math.floor(((hi - lo) * bps(b, i)) / 10_000);

export const epochStart = (epoch: number): number => FIRST_EPOCH_START + (epoch - FIRST_EPOCH) * EPOCH_SECONDS;

export const serviceIdOf = (label: string): string => ethers.id(label);

const byServiceId = (a: { serviceId: string }, b: { serviceId: string }): number => (BigInt(a.serviceId) < BigInt(b.serviceId) ? -1 : 1);

const servicesOf = (buyer: Buyer): ServiceLabel[] => SERVICES.map((s) => s.label).filter((l) => buyer.budgets[l] !== undefined);

/** The budgets a buyer funds in an epoch, in strictly increasing serviceId. */
function budgetsOf(seed: Uint8Array, epoch: number, buyer: Buyer): PlannedBudget[] {
  return servicesOf(buyer)
    .map((label) => {
      const service = serviceNamed(label);
      const factor = between(VALUE_VARIATION_BPS[0], VALUE_VARIATION_BPS[1], draw(seed, `value/${epoch}/${buyer.name}/${label}`), 0);
      const trac = (BigInt(buyer.budgets[label] ?? 0) * BigInt(factor)) / 10_000n;
      return { service: label, serviceId: serviceIdOf(label), serviceClass: service.serviceClass, value: trac * TRAC, maxPricePerUnit: service.maxPricePerUnit };
    })
    .sort(byServiceId);
}

const sum = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

function topUpOf(offset: number, buyer: Buyer, budgets: PlannedBudget[]): PlannedTopUp | undefined {
  const event = eventOf(offset, 'top-up');
  if (!event || event.who !== buyer.name) return undefined;
  const additions = budgets.map((b) => ({ ...b, value: ((b.value * BigInt(TOP_UP_SHARE_BPS)) / 10_000n / TRAC) * TRAC }));
  const value = sum(additions.map((a) => a.value));
  return { atSecond: secondsOfDay(event.atUtc), additions, value, cost: costOf(value, BigInt(buyer.account?.discountBps ?? 0)) };
}

/** A buyer's calls of one budget in one stretch of slots, sized so that they sum to about `target`, in TRAC wei. */
function callsOfStretch(
  seed: Uint8Array,
  plan: { epoch: number; start: number },
  buyer: Buyer,
  label: ServiceLabel,
  slots: { from: number; to: number },
  activity: number,
  target: bigint,
  force?: { from: number; seller: SellerName },
): PlannedCall[] {
  type Slot = { slot: number; weight: bigint; seller: SellerName; jitter: number; latency: number };
  const active: Slot[] = [];
  const others = SELLERS.map((s) => s.name).filter((n) => n !== buyer.mainSeller);
  for (let slot = slots.from; slot <= slots.to; slot++) {
    const d = draw(seed, `call/${plan.epoch}/${buyer.name}/${label}/${slot}`);
    const forced = force !== undefined && slot >= force.from;
    if (!forced && bps(d, 0) >= activity) continue;
    const pick = bps(d, 4);
    const seller =
      forced ? force.seller : pick < MAIN_SELLER_SHARE_BPS ? buyer.mainSeller : others[Math.floor(((pick - MAIN_SELLER_SHARE_BPS) * others.length) / (10_000 - MAIN_SELLER_SHARE_BPS))];
    active.push({ slot, weight: BigInt(5_000 + bps(d, 2)), seller, jitter: u16(d, 6) % 600, latency: 5 + (u16(d, 8) % 115) });
  }
  const totalWeight = sum(active.map((s) => s.weight));
  const calls: PlannedCall[] = [];
  for (const s of active) {
    const price = sellerNamed(s.seller).prices[label];
    const units = (target * s.weight) / totalWeight / price;
    if (units === 0n) continue;
    calls.push(callOf(seed, plan, buyer, label, s.slot, s.seller, units, price, s.jitter, s.latency, false));
  }
  return calls;
}

function callOf(
  seed: Uint8Array,
  plan: { epoch: number; start: number },
  buyer: Buyer,
  label: ServiceLabel,
  slot: number,
  seller: SellerName,
  units: bigint,
  price: bigint,
  jitter: number,
  latency: number,
  race: boolean,
): PlannedCall {
  const issuedAt = plan.start + slot * SLOT_SECONDS + jitter;
  const serviceIndex = SERVICES.findIndex((s) => s.label === label);
  return {
    buyer: buyer.name,
    service: label,
    slot,
    seller,
    nonce: BigInt((serviceIndex << 8) | slot),
    units,
    maxUnits: units + units / 5n,
    price,
    value: units * price,
    issuedAt,
    completedAt: issuedAt + latency,
    expiry: issuedAt + REQUEST_TTL_SECONDS,
    resultCommitment: ethers.hexlify(draw(seed, `result/${plan.epoch}/${buyer.name}/${label}/${slot}`)),
    race,
    held: false,
  };
}

/** The whole plan of an epoch. */
export function planEpoch(seed: Uint8Array, epoch: number): EpochPlan {
  const offset = epoch - FIRST_EPOCH;
  const start = epochStart(epoch);
  const plan: EpochPlan = { epoch, offset, start, end: start + EPOCH_SECONDS, subscriptions: [], calls: [] };
  const fundingOnly = eventOf(offset, 'funding-only') !== undefined;
  const race = eventOf(offset, 'race');
  const held = eventOf(offset, 'held-batch');
  const heldFrom = held ? Math.floor(secondsOfDay(held.atUtc) / SLOT_SECONDS) : LAST_CALL_SLOT + 1;

  for (const buyer of BUYERS) {
    const budgets = budgetsOf(seed, epoch, buyer);
    const value = sum(budgets.map((b) => b.value));
    const discountBps = buyer.account?.discountBps ?? 0;
    const topUp = topUpOf(offset, buyer, budgets);
    plan.subscriptions.push({ buyer: buyer.name, budgets, value, cost: costOf(value, BigInt(discountBps)), discountBps, topUp });
    if (fundingOnly) continue;

    const activity = between(buyer.activityBps[0], buyer.activityBps[1], draw(seed, `activity/${epoch}/${buyer.name}`), 0);
    for (const budget of budgets) {
      const label = budget.service;
      const util = BigInt(buyer.utilizationBps);
      const stretch = (slots: { from: number; to: number }, target: bigint, force?: { from: number; seller: SellerName }) =>
        callsOfStretch(seed, plan, buyer, label, slots, activity, target, force);
      if (topUp) {
        // The first half of the day uses the budget as funded, and the second half what the top-up adds.
        const split = Math.floor(topUp.atSecond / SLOT_SECONDS);
        const added = topUp.additions.find((a) => a.service === label)?.value ?? 0n;
        plan.calls.push(...stretch({ from: FIRST_CALL_SLOT, to: split - 1 }, (budget.value * util) / 10_000n));
        plan.calls.push(...stretch({ from: split + 1, to: LAST_CALL_SLOT }, (added * util) / 10_000n));
      } else if (race && race.who === buyer.name && race.service === label) {
        // The baseline stops short of the limit, then the two sellers take turns past it.
        const raceFrom = Math.floor(secondsOfDay(race.atUtc) / SLOT_SECONDS);
        plan.calls.push(...stretch({ from: FIRST_CALL_SLOT, to: raceFrom - 1 }, (budget.value * BigInt(RACE_BASELINE_BPS)) / 10_000n));
        const [a, b] = race.sellers ?? [buyer.mainSeller, buyer.mainSeller];
        for (let i = 0; i < 4; i++) {
          const seller = i % 2 === 0 ? a : b;
          const price = sellerNamed(seller).prices[label];
          const d = draw(seed, `race/${epoch}/${buyer.name}/${label}/${i}`);
          const units = (budget.value * BigInt(RACE_CALL_BPS)) / 10_000n / price;
          plan.calls.push(callOf(seed, plan, buyer, label, raceFrom + i, seller, units, price, u16(d, 0) % 600, 5 + (u16(d, 2) % 115), true));
        }
      } else {
        // The one budget the seller that holds its last batch is sure to serve late, so that batch is never empty.
        const force = held && buyer.mainSeller === held.who && label === budgets[0].service ? { from: heldFrom, seller: held.who as SellerName } : undefined;
        plan.calls.push(...stretch({ from: FIRST_CALL_SLOT, to: LAST_CALL_SLOT }, (budget.value * util) / 10_000n, force));
      }
    }
  }
  if (held) {
    for (const c of plan.calls) if (c.seller === held.who && c.slot >= heldFrom) c.held = true;
  }
  return plan;
}

/** When a seller lands in an epoch, in seconds into it: every 30 to 60 minutes, by its own draw, up to the last stretch. */
export function landingTimes(seed: Uint8Array, epoch: number, seller: SellerName): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; ; i++) {
    t += between(1_800, 3_600, draw(seed, `landing/${epoch}/${seller}/${i}`), 0);
    if (t >= EPOCH_SECONDS - LAST_STRETCH_SECONDS) return out;
    out.push(t);
  }
}

/** Whether a seller's tick at `secondsIn` into the epoch lands: at every tick of the last stretch, and otherwise at its landing times. */
export function landingDue(seed: Uint8Array, epoch: number, seller: SellerName, secondsIn: number): boolean {
  if (secondsIn >= EPOCH_SECONDS - LAST_STRETCH_SECONDS) return true;
  return landingTimes(seed, epoch, seller).some((t) => t <= secondsIn && secondsIn < t + TICK_SECONDS);
}

export type ChainSubscription = { startsAt: bigint; grantEnd: bigint };

/**
 * Whether a planned call exists, given what the chain recorded for its
 * subscription: a request is issued from the subscription's start, and before the
 * grant it was funded under ended.
 */
export const callIsLive = (call: PlannedCall, sub: ChainSubscription): boolean => BigInt(call.issuedAt) >= sub.startsAt && BigInt(call.issuedAt) < sub.grantEnd;

/** The commitment a buyer's plan digest makes: its budgets' terms in the epoch. */
export function planDigestOf(epoch: number, buyer: BuyerName, budgets: readonly PlannedBudget[]): string {
  return ethers.id(JSON.stringify({ epoch, buyer, budgets: budgets.map((b) => [b.serviceId, b.serviceClass.toString(), b.value.toString(), b.maxPricePerUnit.toString()]) }));
}

export const subscriptionIdFor = (buyerAddress: string, epoch: number): string => subscriptionIdOf(buyerAddress, BigInt(epoch));

/** The face value of a set of calls. */
export const valueOf = (calls: readonly PlannedCall[]): bigint => sum(calls.map((c) => c.value));
