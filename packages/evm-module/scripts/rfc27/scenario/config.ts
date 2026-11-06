// OT-RFC-27 marketplace scenario on Base Sepolia: who takes part, what they buy,
// and what is scripted for each epoch. Public data only. Everything here is an
// input of the pure plan in plan.ts.

import { CLASS_INFERENCE, CLASS_QUERY, TRAC } from '../../../test/helpers/conviction-service';

export { TRAC };

export const CHAIN_ID = 84532;
export const HUB = '0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6';
export const PUBLIC_RPC = 'https://sepolia.base.org';
export const EXPLORER = 'https://sepolia.basescan.org';
export const BLOCKSCOUT = 'https://base-sepolia.blockscout.com';

/** The first epoch whose subscriptions can be funded, and the scenario's first epoch: offset 0. */
export const ACTIVATION_EPOCH = 663;
export const FIRST_EPOCH = 663;

export const EPOCH_SECONDS = 86_400;
/** How often a beacon ticks. */
export const TICK_SECONDS = 300;
/** A call is planned per buyer, service and slot of this length. */
export const SLOT_SECONDS = 900;
export const SLOTS_PER_EPOCH = EPOCH_SECONDS / SLOT_SECONDS;
/** No call in slot 0: the first tick of the epoch funds, and a request needs its subscription's startsAt. */
export const FIRST_CALL_SLOT = 1;
/** The last slot with calls: 23:30 to 23:45 UTC, so the last batches land in the epoch's last 20 minutes. */
export const LAST_CALL_SLOT = 94;
/** The epoch's last stretch, in which a seller lands at every tick. */
export const LAST_STRETCH_SECONDS = 1_200;
/** How long a request stays open after it is issued. */
export const REQUEST_TTL_SECONDS = 3_600;
/** A seller lands only work completed at least this long before the chain's clock. */
export const COMPLETED_MARGIN_SECONDS = 30;

export type SellerName = 'beacon-01' | 'beacon-02' | 'beacon-03' | 'beacon-04';
export type ServiceLabel = 'inference/model-alpha' | 'inference/model-beta' | 'query/knowledge';
export type BuyerName = 'wallet-heavy' | 'wallet-light' | 'wallet-bursty' | 'account-plain' | 'account-30' | 'account-75';

export type Seller = {
  name: SellerName;
  identityId: number;
  address: string;
  /** The minute of each five that this beacon's timer fires at, so the beacons do not hit the public endpoint together. */
  tickMinute: number;
  /** The seller's unit price per service, in TRAC wei. */
  prices: Record<ServiceLabel, bigint>;
};

const milli = (m: number) => (BigInt(Math.round(m * 1_000_000)) * TRAC) / 1_000_000_000n;

/** Prices in thousandths of a TRAC per unit. */
export const SELLERS: readonly Seller[] = [
  {
    name: 'beacon-01',
    identityId: 4,
    address: '0x694f6eF05658913da0437ac7a63A8Dad981B4a7e',
    tickMinute: 0,
    prices: { 'inference/model-alpha': milli(1.0), 'inference/model-beta': milli(3.0), 'query/knowledge': milli(40) },
  },
  {
    name: 'beacon-02',
    identityId: 3,
    address: '0x40bb512e8Ba105e0AC0bc44be540BDFb28377230',
    tickMinute: 1,
    prices: { 'inference/model-alpha': milli(1.1), 'inference/model-beta': milli(2.8), 'query/knowledge': milli(45) },
  },
  {
    name: 'beacon-03',
    identityId: 1,
    address: '0x8891Ad8396d5FE34c9A3c778bCbb99F20fbD4954',
    tickMinute: 2,
    prices: { 'inference/model-alpha': milli(0.9), 'inference/model-beta': milli(3.4), 'query/knowledge': milli(38) },
  },
  {
    name: 'beacon-04',
    identityId: 5,
    address: '0xfd6473f3F9a6fE03984cbdb6d2370FA13c0c2441',
    tickMinute: 3,
    prices: { 'inference/model-alpha': milli(1.2), 'inference/model-beta': milli(3.2), 'query/knowledge': milli(50) },
  },
];

export type Service = {
  label: ServiceLabel;
  serviceClass: bigint;
  unit: 'token' | 'query';
  /** Each budget's price cap per unit, above every seller's price. */
  maxPricePerUnit: bigint;
};

export const SERVICES: readonly Service[] = [
  { label: 'inference/model-alpha', serviceClass: CLASS_INFERENCE, unit: 'token', maxPricePerUnit: milli(1.5) },
  { label: 'inference/model-beta', serviceClass: CLASS_INFERENCE, unit: 'token', maxPricePerUnit: milli(4) },
  { label: 'query/knowledge', serviceClass: CLASS_QUERY, unit: 'query', maxPricePerUnit: milli(60) },
];

export type Buyer = {
  name: BuyerName;
  pays: 'wallet' | 'account';
  /** Most of its calls go to this seller. */
  mainSeller: SellerName;
  /** The one beacon that sends this buyer's funding, top-up and grant transactions. Never its main seller. */
  home: SellerName;
  /** The share of its budgets it means to use, in basis points. */
  utilizationBps: number;
  /** The share of slots in which it makes a call, in basis points, at the least and at the most, varied per epoch. */
  activityBps: readonly [number, number];
  /** The base value of its budgets, in whole TRAC, varied per epoch. */
  budgets: Partial<Record<ServiceLabel, number>>;
  /** For a Conviction Account: the TRAC committed at creation, the tier that gives, and its primary node. */
  account?: { committedTrac: number; discountBps: number; primaryNode: SellerName };
};

export const BUYERS: readonly Buyer[] = [
  {
    name: 'wallet-heavy',
    pays: 'wallet',
    mainSeller: 'beacon-01',
    home: 'beacon-02',
    utilizationBps: 9000,
    activityBps: [6000, 8000],
    budgets: { 'inference/model-alpha': 200, 'inference/model-beta': 300, 'query/knowledge': 100 },
  },
  {
    name: 'wallet-light',
    pays: 'wallet',
    mainSeller: 'beacon-02',
    home: 'beacon-03',
    utilizationBps: 2500,
    activityBps: [2500, 4500],
    budgets: { 'inference/model-alpha': 120, 'query/knowledge': 80 },
  },
  {
    name: 'wallet-bursty',
    pays: 'wallet',
    mainSeller: 'beacon-03',
    home: 'beacon-04',
    utilizationBps: 9000,
    activityBps: [4000, 7000],
    budgets: { 'inference/model-alpha': 100, 'inference/model-beta': 200 },
  },
  {
    name: 'account-plain',
    pays: 'account',
    mainSeller: 'beacon-04',
    home: 'beacon-01',
    utilizationBps: 6000,
    activityBps: [4000, 6000],
    budgets: { 'inference/model-alpha': 100, 'query/knowledge': 60 },
    account: { committedTrac: 6_000, discountBps: 0, primaryNode: 'beacon-04' },
  },
  {
    name: 'account-30',
    pays: 'account',
    mainSeller: 'beacon-01',
    home: 'beacon-03',
    utilizationBps: 7000,
    activityBps: [5000, 7000],
    budgets: { 'inference/model-alpha': 150, 'inference/model-beta': 200 },
    account: { committedTrac: 100_000, discountBps: 3_000, primaryNode: 'beacon-01' },
  },
  {
    name: 'account-75',
    pays: 'account',
    mainSeller: 'beacon-02',
    home: 'beacon-04',
    utilizationBps: 8000,
    activityBps: [5000, 7500],
    budgets: { 'inference/model-beta': 400, 'query/knowledge': 200 },
    account: { committedTrac: 1_000_000, discountBps: 7_500, primaryNode: 'beacon-02' },
  },
];

/** The most one subscription of an account's buyer may cost, its top-ups included. */
export const GRANT_MAX_COST_TRAC = 1_000;

/** The share of a buyer's calls that go to its main seller, in basis points; the rest is split evenly among the others. */
export const MAIN_SELLER_SHARE_BPS = 5_500;

/** A budget's base value is scaled by a factor in this range, in basis points, per epoch. */
export const VALUE_VARIATION_BPS: readonly [number, number] = [7_500, 12_500];

/** wallet-bursty's top-up, as a share of each budget's value in that epoch, in basis points. */
export const TOP_UP_SHARE_BPS = 8_000;
/** At the race, the budget's baseline demand, before the two sellers' calls, in basis points of its value. */
export const RACE_BASELINE_BPS = 7_500;
/** At the race, each of the two sellers' calls, in basis points of the budget's value. */
export const RACE_CALL_BPS = 1_000;

/** The start of the first epoch; the driver checks it against Chronos. */
export const FIRST_EPOCH_START = 1_794_009_600;

export type EventKind = 'baseline' | 'top-up' | 'remove-buyer' | 'add-buyer' | 'race' | 'held-batch' | 'funding-only';

export type ScriptedEvent = {
  epochOffset: number;
  /** The time of day it is due, in UTC. */
  atUtc: string;
  kind: EventKind;
  /** A buyer, a seller, or `all`. */
  who: string;
  note: string;
  /** For a race: the budget and the two sellers. */
  service?: ServiceLabel;
  sellers?: readonly [SellerName, SellerName];
};

/** What is scripted, by epoch offset from the first epoch. An offset of 4 or more with nothing here is a baseline with varied demand. */
export const EVENTS: readonly ScriptedEvent[] = [
  { epochOffset: 0, atUtc: '00:00', kind: 'baseline', who: 'all', note: 'The first epoch of the pool: every buyer funds its subscription, and the sellers land calls through the day.' },
  { epochOffset: 1, atUtc: '12:00', kind: 'top-up', who: 'wallet-bursty', note: 'Tops up every budget mid-epoch; its calls of the second half of the day use what the top-up adds.' },
  { epochOffset: 1, atUtc: '16:00', kind: 'remove-buyer', who: 'account-30', note: "The account's owner removes its buyer: requests issued from then on are refused, and those served before it still land." },
  { epochOffset: 2, atUtc: '00:00', kind: 'add-buyer', who: 'account-30', note: 'The owner adds the buyer again under a new grant, at the epoch start, and the buyer funds the epoch from it.' },
  {
    epochOffset: 2,
    atUtc: '22:30',
    kind: 'race',
    who: 'wallet-heavy',
    service: 'inference/model-beta',
    sellers: ['beacon-01', 'beacon-02'],
    note: 'Two sellers serve the same budget past its limit: batches count in landing order, so whichever lands last counts only what is left.',
  },
  { epochOffset: 2, atUtc: '22:30', kind: 'held-batch', who: 'beacon-03', note: 'Holds its calls from 22:30 on past the end of the epoch, so that last batch misses: refused as OutsideEpoch, and it never counts. Expected.' },
  { epochOffset: 3, atUtc: '00:00', kind: 'funding-only', who: 'all', note: 'Every buyer funds, and no call is made. No node has served value, so the pool is 0 and the money rolls forward.' },
  { epochOffset: 4, atUtc: '00:00', kind: 'baseline', who: 'all', note: 'Calls resume with varied demand: this epoch has value, so its pool takes the money rolled from offset 3.' },
];

export function eventOf(epochOffset: number, kind: EventKind): ScriptedEvent | undefined {
  return EVENTS.find((e) => e.epochOffset === epochOffset && e.kind === kind);
}

/** "HH:MM" as seconds into the UTC day. */
export function secondsOfDay(atUtc: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(atUtc);
  if (!m) throw new Error(`not a time of day: ${atUtc}`);
  return Number(m[1]) * 3_600 + Number(m[2]) * 60;
}

export function sellerNamed(name: string): Seller {
  const s = SELLERS.find((x) => x.name === name);
  if (!s) throw new Error(`no seller named ${name}`);
  return s;
}

export function buyerNamed(name: string): Buyer {
  const b = BUYERS.find((x) => x.name === name);
  if (!b) throw new Error(`no buyer named ${name}`);
  return b;
}

export function serviceNamed(label: string): Service {
  const s = SERVICES.find((x) => x.label === label);
  if (!s) throw new Error(`no service labelled ${label}`);
  return s;
}
