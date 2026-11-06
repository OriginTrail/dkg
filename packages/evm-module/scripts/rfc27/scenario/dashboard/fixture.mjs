// Generates realistic data.json files to build and test the page against, without a
// chain. It plays a multi-day marketplace through the contracts' own arithmetic, into
// the state the indexer would hold, then runs the same compose() over it, so the
// fixture also exercises that code. Nothing here is real, and it says so.
//
//   node fixture.mjs [outDir]     writes <outDir>/<variant>/{data.json,index.html}
//
// Variants: live (several days in, with an empty epoch, a partial count and a missed
// deadline), early (hours into the first epoch), pre (before the first epoch), bare
// (before the first epoch, with no public file yet), stale (live, with a failed read),
// partly (live, with the events failing), unread (the very first read failed).

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compose } from './lib/compose.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(here, 'fixture', 'out');

const E18 = 10n ** 18n;
const BPS = 10_000n;
const DAY = 86_400;
const FIRST = 663;
const LAMBDA = 5000n;
const MAX_STAKE = 10_000_000n * E18;

const tok = (x) => (BigInt(Math.round(x * 1e6)) * E18) / 1_000_000n;

function isqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
const factorOf = (stake) => isqrt(((stake * E18) / MAX_STAKE) * E18);

/** A small deterministic generator, so a fixture is the same every time. */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (n, size = 64) => `0x${n.toString(16).padStart(size, '0')}`;
const SELLERS = [
  { name: 'beacon-01', identityId: 4, address: hex(0xb01n, 40), stake: 488_000n * E18, score: 0.0212 },
  { name: 'beacon-02', identityId: 3, address: hex(0xb02n, 40), stake: 968_000n * E18, score: 0.059 },
  { name: 'beacon-03', identityId: 1, address: hex(0xb03n, 40), stake: 449_000n * E18, score: 0.1649 },
  { name: 'beacon-04', identityId: 5, address: hex(0xb04n, 40), stake: 475_000n * E18, score: 0.1691 },
];
const SERVICES = [
  { label: 'inference/model-alpha', serviceId: hex(0xa1n), serviceClass: 1, unit: 'token', price: 0.0002, unitsPerReceipt: [3000, 14000] },
  { label: 'inference/model-beta', serviceId: hex(0xa2n), serviceClass: 1, unit: 'token', price: 0.0005, unitsPerReceipt: [1500, 7000] },
  { label: 'query/knowledge', serviceId: hex(0xa3n), serviceClass: 2, unit: 'query', price: 0.25, unitsPerReceipt: [2, 14] },
];
const BUYERS = [
  { name: 'wallet-heavy', address: hex(0xc01n, 40), pays: 'wallet', accountId: null, owner: null, discountBps: 0, home: 'beacon-02', plan: [260, 190, 110], heat: 1 },
  { name: 'wallet-light', address: hex(0xc02n, 40), pays: 'wallet', accountId: null, owner: null, discountBps: 0, home: 'beacon-03', plan: [36, 0, 14], heat: 0.8 },
  { name: 'wallet-bursty', address: hex(0xc03n, 40), pays: 'wallet', accountId: null, owner: null, discountBps: 0, home: 'beacon-04', plan: [0, 70, 30], heat: 0.5 },
  { name: 'account-plain', address: hex(0xc04n, 40), pays: 'account', accountId: '21', owner: hex(0xd01n, 40), discountBps: 0, home: 'beacon-01', plan: [90, 60, 20], heat: 0.7 },
  { name: 'account-30', address: hex(0xc05n, 40), pays: 'account', accountId: '22', owner: hex(0xd01n, 40), discountBps: 3000, home: 'beacon-02', plan: [150, 110, 60], heat: 0.9 },
  { name: 'account-75', address: hex(0xc06n, 40), pays: 'account', accountId: '23', owner: hex(0xd02n, 40), discountBps: 7500, home: 'beacon-03', plan: [300, 240, 120], heat: 1.1 },
];
const EVENTS = [
  { epochOffset: 0, atUtc: '00:00', kind: 'baseline', who: 'all', note: 'The first epoch of the pool: every buyer funds its subscription, and the sellers land calls through the day.' },
  { epochOffset: 1, atUtc: '12:00', kind: 'top-up', who: 'wallet-bursty', note: 'Tops up every budget mid-epoch; its calls of the second half of the day use what the top-up adds.' },
  { epochOffset: 2, atUtc: '14:00', kind: 'remove-buyer', who: 'account-plain', note: "The account's owner removes its buyer: requests issued from then on are refused, and those served before it still land." },
  { epochOffset: 3, atUtc: '00:00', kind: 'add-buyer', who: 'account-plain', note: 'The owner adds the buyer again under a new grant, at the epoch start, and the buyer funds the epoch from it.' },
  { epochOffset: 3, atUtc: '16:00', kind: 'race', who: 'wallet-light', note: 'Two sellers serve the same budget past its limit: batches count in landing order, so whichever lands last counts only what is left.' },
  { epochOffset: 2, atUtc: '22:30', kind: 'held-batch', who: 'beacon-03', note: 'Holds its calls past the end of the epoch and never sends them: on-chain, only the budget left unused shows it.' },
  { epochOffset: 4, atUtc: '22:30', kind: 'held-batch', who: 'beacon-04', note: 'Holds its calls past the end of the epoch, so that last batch misses: refused as OutsideEpoch, and it never counts. Expected.' },
  { epochOffset: 5, atUtc: '00:00', kind: 'funding-only', who: 'all', note: 'Every buyer funds, and no call is made. No node has served value, so the pool is 0 and the money rolls forward.' },
  { epochOffset: 6, atUtc: '00:00', kind: 'baseline', who: 'all', note: 'Calls resume with varied demand: this epoch has value, so its pool takes the money rolled forward.' },
];

const publicFile = (hub) => ({
  network: { chainId: 84532, hub, rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', blockscout: 'https://base-sepolia.blockscout.com' },
  activationEpoch: FIRST,
  firstEpoch: FIRST,
  sellers: SELLERS.map(({ name, identityId, address }) => ({ name, identityId, address })),
  services: SERVICES.map(({ label, serviceId, serviceClass, unit }) => ({ label, serviceId, serviceClass, unit })),
  buyers: BUYERS.map(({ name, address, pays, accountId, owner, discountBps, home }) => ({ name, address, pays, accountId, owner, discountBps, home })),
  events: EVENTS,
});

class Sim {
  constructor({ now, currentEpoch }) {
    this.now = now;
    const midnight = now - (now % DAY);
    this.clock = { startTime: midnight - (currentEpoch - 1) * DAY, epochLength: DAY, currentEpoch, activationEpoch: FIRST, block: 0, blockTime: now };
    this.logs = [];
    this.txs = {};
    this.epochs = new Map();
    this.block = 55_000_000;
    this.logIndex = 0;
    this.nonce = 1;
    this.rand = random(27);
  }

  startOf(e) {
    return this.clock.startTime + (e - 1) * DAY;
  }

  rec(e) {
    if (!this.epochs.has(e)) this.epochs.set(e, { epoch: e, wallet: 0n, account: 0n, sellers: new Map(), subs: new Map() });
    return this.epochs.get(e);
  }

  tx() {
    return hex(BigInt(this.nonce++) * 0x9e3779b97f4a7c15n);
  }

  blockAt(at) {
    return 55_000_000 + Math.floor((at - this.startOf(FIRST)) * 5);
  }

  log(k, at, tx, a) {
    this.logs.push({ k, tx, block: this.blockAt(at), idx: this.logIndex++, at, addr: hex(0xfn, 40), a });
  }

  fund(buyer, e, at) {
    const budgets = buyer.plan
      .map((v, i) => ({ value: v, service: SERVICES[i] }))
      .filter((b) => b.value > 0)
      .map((b) => ({
        serviceId: b.service.serviceId,
        serviceClass: b.service.serviceClass,
        value: tok(b.value * (0.9 + this.rand() * 0.25)),
        maxPricePerUnit: tok(b.service.price * 1.5),
        used: 0n,
      }));
    const value = budgets.reduce((a, b) => a + b.value, 0n);
    const cost = (value * (BPS - BigInt(buyer.discountBps))) / BPS;
    const id = hex(BigInt(e) * 0x10000n + BigInt(BUYERS.indexOf(buyer) + 1) * 0x123456789n);
    const tx = this.tx();
    const sub = { id, buyer, epoch: e, value, cost, budgets, startsAt: Math.max(at, this.startOf(e)), endsAt: this.startOf(e + 1), fundedEpoch: Math.min(e, Math.floor((at - this.clock.startTime) / DAY) + 1) };
    const r = this.rec(e);
    r.subs.set(buyer.address, sub);
    if (buyer.accountId) r.account += cost;
    else r.wallet += value;
    this.log('SubscriptionFunded', at, tx, {
      subscriptionId: id,
      accountId: buyer.accountId ?? '0',
      buyer: buyer.address,
      epoch: String(e),
      startsAt: String(sub.startsAt),
      endsAt: String(sub.endsAt),
      value: value.toString(),
      cost: cost.toString(),
      discountBps: String(buyer.discountBps),
      budgets: budgets.map((b) => ({ serviceId: b.serviceId, serviceClass: String(b.serviceClass), value: b.value.toString(), maxPricePerUnit: b.maxPricePerUnit.toString() })),
    });
    return sub;
  }

  topUp(buyer, e, at, added) {
    const r = this.rec(e);
    const sub = r.subs.get(buyer.address);
    const value = added.reduce((a, x) => a + x, 0n);
    added.forEach((x, i) => {
      if (sub.budgets[i]) sub.budgets[i].value += x;
    });
    const cost = (value * (BPS - BigInt(buyer.discountBps))) / BPS;
    sub.value += value;
    sub.cost += cost;
    if (buyer.accountId) r.account += cost;
    else r.wallet += value;
    this.log('SubscriptionToppedUp', at, this.tx(), { subscriptionId: sub.id, accountId: buyer.accountId ?? '0', buyer: buyer.address, value: value.toString(), cost: cost.toString(), additions: [] });
  }

  /** A group of receipts on one budget, in the contract's words: what fits what the budget has left counts. */
  groupOf(buyer, e, budgetIndex, receipts) {
    const sub = this.rec(e).subs.get(buyer.address);
    if (!sub || !sub.budgets[budgetIndex]) return null;
    const service = SERVICES.find((s) => s.serviceId === sub.budgets[budgetIndex].serviceId);
    let units = 0n;
    for (let i = 0; i < receipts; i++) {
      const [lo, hi] = service.unitsPerReceipt;
      units += BigInt(Math.floor(lo + this.rand() * (hi - lo + 1)));
    }
    const price = tok(service.price);
    return { sub, buyer, budgetIndex, receipts, units, value: units * price, price, minCounted: 0n };
  }

  batch(seller, at, groups) {
    const groupsIn = groups.filter(Boolean);
    if (!groupsIn.length) return;
    const tx = this.tx();
    const e = Math.floor((at - this.clock.startTime) / DAY) + 1;
    const factor = factorOf(seller.stake);
    const node = this.rec(e).sellers.get(seller.identityId) ?? { served: 0n, weighted: 0n };
    let value = 0n;
    let counted = 0n;
    let items = 0;
    const planned = [];
    for (const g of groupsIn) {
      const budget = g.sub.budgets[g.budgetIndex];
      const left = budget.value - budget.used;
      const c = g.value < left ? g.value : left;
      const served = (c * (BPS - BigInt(g.buyer.discountBps))) / BPS;
      const weighted = (served * factor) / E18;
      budget.used += c;
      node.served += served;
      node.weighted += weighted;
      value += g.value;
      counted += c;
      items += g.receipts;
      planned.push({ sub: g.sub.id, budget: g.budgetIndex, minCounted: '0', items: g.receipts, units: g.units.toString(), value: g.value.toString(), minPrice: g.price.toString(), maxPrice: g.price.toString() });
      this.log('ReceiptsLanded', at, tx, {
        subscriptionId: g.sub.id,
        budgetIndex: String(g.budgetIndex),
        seller: String(seller.identityId),
        itemCount: String(g.receipts),
        value: g.value.toString(),
        counted: c.toString(),
        stakeFactor18: factor.toString(),
        groupDigest: hex(1n),
      });
    }
    this.rec(e).sellers.set(seller.identityId, node);
    this.log('ReceiptBatchAccepted', at, tx, { seller: String(seller.identityId), batchDigest: hex(2n), itemCount: String(items), value: value.toString(), counted: counted.toString(), stakeFactor18: factor.toString() });
    this.txs[tx] = { ok: true, from: seller.address, to: hex(0xfn, 40), at, block: this.blockAt(at), position: 1, fn: 'submitReceiptBatch', groups: planned };
  }

  refusedBatch(seller, at, groups, revert) {
    const tx = this.tx();
    this.txs[tx] = {
      ok: false,
      from: seller.address,
      to: hex(0xfn, 40),
      at,
      block: this.blockAt(at),
      position: 1,
      fn: 'submitReceiptBatch',
      groups: groups.filter(Boolean).map((g) => ({ sub: g.sub.id, budget: g.budgetIndex, minCounted: '0', items: g.receipts, units: g.units.toString(), value: g.value.toString(), minPrice: g.price.toString(), maxPrice: g.price.toString() })),
      revert,
    };
  }

  /** A day of service: batches through the day, each from one seller, each with one to three groups. */
  serve(e, from, to, { heat = 1, stopBuyer = null, skipBuyer = () => false } = {}) {
    const start = this.startOf(e);
    const count = Math.round(44 * heat);
    for (let i = 0; i < count; i++) {
      const at = start + from + Math.floor(((i + this.rand()) / count) * (to - from));
      if (at >= this.now) break;
      const seller = SELLERS[Math.floor(this.rand() * SELLERS.length)];
      const groups = [];
      for (const buyer of BUYERS) {
        if (skipBuyer(buyer, at) || this.rand() > 0.34 * buyer.heat + 0.12) continue;
        const sub = this.rec(e).subs.get(buyer.address);
        if (!sub) continue;
        const b = Math.floor(this.rand() * sub.budgets.length);
        if (sub.budgets[b].used >= sub.budgets[b].value) continue;
        const receipts = 1 + Math.floor(this.rand() * 6);
        groups.push(this.groupOf(buyer, e, b, receipts));
      }
      this.batch(seller, at, groups.slice(0, 3));
    }
    void stopBuyer;
  }

  fundAll(e, opts = {}) {
    const start = this.startOf(e);
    BUYERS.forEach((b, i) => {
      if (opts.skip?.(b)) return;
      this.fund(b, e, start + 20 + i * 180 + Math.floor(this.rand() * 120));
    });
  }

  /** What the views would answer, for what has happened. */
  state({ hub }) {
    const clock = this.clock;
    const final = {};
    const live = {};
    let waiting = 0n;
    const epochNumbers = [...this.epochs.keys()].sort((a, b) => a - b);
    for (const e of epochNumbers) {
      const r = this.epochs.get(e);
      const money = r.wallet + r.account;
      const totalServed = [...r.sellers.values()].reduce((a, n) => a + n.served, 0n);
      const totalWeighted = [...r.sellers.values()].reduce((a, n) => a + n.weighted, 0n);
      const pool = totalServed === 0n ? 0n : waiting + money;
      if (totalServed === 0n) waiting += money;
      else waiting = 0n;
      const publishingPool = tok(128_000 + ((e * 7919) % 11_000));
      const allNodesScore = SELLERS.reduce((a, s) => a + tok(s.score), 0n);
      const sellers = {};
      for (const s of SELLERS) {
        const n = r.sellers.get(s.identityId) ?? { served: 0n, weighted: 0n };
        const gross =
          n.served === 0n
            ? 0n
            : (pool * (BPS - LAMBDA) * n.served) / (BPS * totalServed) + (pool * LAMBDA * n.weighted) / (BPS * totalWeighted);
        const nodeScore = tok(s.score);
        const publishing = (publishingPool * nodeScore) / allNodesScore;
        const feeBps = s.identityId === 3 ? 1000n : 0n;
        const total = publishing + gross;
        const net = total - (total * feeBps) / BPS;
        sellers[s.identityId] = { served: n.served.toString(), weighted: n.weighted.toString(), gross: gross.toString(), nodeScore: nodeScore.toString(), proofs: String(70 + ((e * s.identityId * 13) % 40)), feeBps: feeBps.toString(), net: net.toString() };
      }
      const subs = {};
      for (const b of BUYERS) {
        const s = r.subs.get(b.address);
        subs[b.address] = s
          ? {
              id: s.id,
              accountId: b.accountId ?? '0',
              buyer: b.address,
              grantNonce: '0',
              epoch: e,
              startsAt: s.startsAt,
              endsAt: s.endsAt,
              fundedEpoch: s.fundedEpoch,
              discountBps: b.discountBps,
              budgetCount: s.budgets.length,
              value: s.value.toString(),
              cost: s.cost.toString(),
              spentFromWindow: s.cost.toString(),
              spentFromTopUp: '0',
              budgets: s.budgets.map((x) => ({ serviceId: x.serviceId, serviceClass: x.serviceClass, value: x.value.toString(), maxPricePerUnit: x.maxPricePerUnit.toString(), used: x.used.toString() })),
            }
          : null;
      }
      const rec = { epoch: e, wallet: r.wallet.toString(), account: r.account.toString(), served: totalServed.toString(), weighted: totalWeighted.toString(), lambdaBps: Number(LAMBDA), pool: pool.toString(), publishingPool: publishingPool.toString(), allNodesScore: allNodesScore.toString(), sellers, subs };
      if (e < clock.currentEpoch) final[e] = rec;
      else live[e] = rec;
    }
    const sellersLive = Object.fromEntries(SELLERS.map((s) => [s.identityId, { name: s.name, factor18: factorOf(s.stake).toString(), stake: s.stake.toString() }]));
    const buyersLive = {};
    for (const b of BUYERS) {
      if (!b.accountId) continue;
      const lastChange = [...this.logs].reverse().find((l) => (l.k === 'BuyerRemoved' || l.k === 'BuyerAdded') && l.a.buyer === b.address);
      const removed = lastChange?.k === 'BuyerRemoved' ? lastChange : null;
      buyersLive[b.address] = {
        grant: { maxCostPerEpoch: tok(b.discountBps === 7500 ? 300 : 500).toString(), grantedAt: clock.startTime + (FIRST - 2) * DAY, expiresAt: clock.startTime + (FIRST + 29) * DAY, revokedAt: removed?.at ?? 0, nonce: '1', owner: b.owner },
        usage: clock.currentEpoch - FIRST + 1,
        buyerCount: b.accountId === '23' ? 1 : 1,
        allowance: { window: clock.currentEpoch - FIRST + 2, baseRemaining: tok(14_000).toString(), topUpBuffer: '0', expired: false },
      };
    }
    return {
      v: 1,
      clock,
      params: { lambdaBps: Number(LAMBDA), paused: false, maxOperatorFee: BPS.toString(), maximumStake: MAX_STAKE.toString() },
      contracts: { Hub: hub, QueryInferenceStorage: hex(0xa1n, 40), QueryInferenceSettlement: hex(0xa2n, 40), ServiceSubscriptionsStorage: hex(0xa3n, 40), ServiceSubscriptions: hex(0xa4n, 40), ServiceSubscriptionsWallet: hex(0xa5n, 40), StakingKPI: hex(0xa6n, 40) },
      logs: this.logs,
      txs: this.txs,
      final,
      live,
      split: this.split ?? {},
      positions: this.positions ?? {},
      operators: Object.fromEntries(SELLERS.map((s) => [s.address.toLowerCase(), s.identityId])),
      sellersLive,
      buyersLive,
    };
  }
}

const HUB = '0xc056e67da4f51377ad1b01f50f655ffdccd809f6';

function freshStatus(now, source = 'repository') {
  return {
    stale: false,
    errors: [],
    rpc: { ok: true, lastOkAt: now, block: 55_400_000, blockTime: now - 2 },
    events: { ok: true, lastOkAt: now, head: 55_399_990, lagBlocks: 3 },
    public: { source, at: now - 3600 },
    run: { ms: 3200, rpcCalls: 6, explorerCalls: 8 },
  };
}

function network() {
  return { chainId: 84532, hub: HUB, explorer: 'https://sepolia.basescan.org', blockscout: 'https://base-sepolia.blockscout.com', rpc: 'https://sepolia.base.org' };
}

/** Several days in: every scheduled event has happened, and the epoch in progress holds a rollover. */
function buildLive(now) {
  const currentEpoch = FIRST + 6;
  const sim = new Sim({ now, currentEpoch });
  const by = (name) => BUYERS.find((b) => b.name === name);
  const seller = (name) => SELLERS.find((s) => s.name === name);
  const dayEnd = DAY - 300;

  // 663: an ordinary day. Not everything is used.
  sim.fundAll(FIRST);
  sim.serve(FIRST, 1800, dayEnd, { heat: 0.8 });

  // 664: wallet-bursty runs short, and tops up at midday.
  sim.fundAll(FIRST + 1);
  sim.serve(FIRST + 1, 1800, DAY * 0.5, { heat: 0.7 });
  const bursty = sim.rec(FIRST + 1).subs.get(by('wallet-bursty').address);
  sim.topUp(by('wallet-bursty'), FIRST + 1, sim.startOf(FIRST + 1) + 12 * 3600 + 40, [tok(55), tok(25)].slice(0, bursty.budgets.length));
  sim.serve(FIRST + 1, DAY * 0.5, dayEnd, { heat: 0.8 });

  // 665: account-plain is removed mid-epoch; what it was served before still lands, what comes after is refused.
  sim.fundAll(FIRST + 2);
  const removedAt = sim.startOf(FIRST + 2) + 14 * 3600 + 25;
  sim.serve(FIRST + 2, 1800, 14 * 3600, { heat: 0.6 });
  sim.log('BuyerRemoved', removedAt, sim.tx(), { accountId: by('account-plain').accountId, buyer: by('account-plain').address });
  sim.batch(seller('beacon-01'), removedAt + 900, [sim.groupOf(by('account-plain'), FIRST + 2, 0, 3)]);
  sim.refusedBatch(seller('beacon-02'), removedAt + 5400, [sim.groupOf(by('account-plain'), FIRST + 2, 1, 2)], { name: 'ReceiptFault', group: 0, item: 0, fault: 'InactiveGrant' });
  sim.serve(FIRST + 2, 14 * 3600, dayEnd, { heat: 0.5, skipBuyer: (b) => b.name === 'account-plain' });

  // 666: the buyer gets a new grant and funds again; two sellers race for the end of wallet-light's budget: one counts in full, the other in part, a third refuses to land for less than its minimum.
  sim.log('BuyerAdded', sim.startOf(FIRST + 3) + 8, sim.tx(), { accountId: by('account-plain').accountId, buyer: by('account-plain').address, maxCostPerEpoch: tok(500).toString(), expiresAt: String(sim.startOf(FIRST + 33)), nonce: '2' });
  sim.fundAll(FIRST + 3);
  sim.serve(FIRST + 3, 1800, 16 * 3600, { heat: 0.6, skipBuyer: (b) => b.name === 'wallet-light' });
  const light = sim.rec(FIRST + 3).subs.get(by('wallet-light').address);
  const raceAt = sim.startOf(FIRST + 3) + 16 * 3600;
  const first = sim.groupOf(by('wallet-light'), FIRST + 3, 0, 2);
  first.value = (light.budgets[0].value * 7n) / 10n;
  sim.batch(seller('beacon-02'), raceAt + 12, [first]);
  const second = sim.groupOf(by('wallet-light'), FIRST + 3, 0, 2);
  second.value = (light.budgets[0].value * 6n) / 10n;
  sim.batch(seller('beacon-03'), raceAt + 15, [second]);
  sim.refusedBatch(seller('beacon-01'), raceAt + 17, [sim.groupOf(by('wallet-light'), FIRST + 3, 0, 1)], { name: 'GroupFault', group: 0, fault: 'BelowMinCounted' });
  sim.serve(FIRST + 3, 16 * 3600, dayEnd, { heat: 0.5, skipBuyer: (b) => b.name === 'wallet-light' });

  // 667: a batch comes in nine seconds after the deadline, and the chain refuses it.
  sim.fundAll(FIRST + 4);
  sim.serve(FIRST + 4, 1800, dayEnd, { heat: 0.7 });
  const lateAt = sim.startOf(FIRST + 5) + 9;
  sim.refusedBatch(seller('beacon-04'), lateAt, [sim.groupOf(by('account-75'), FIRST + 4, 0, 3), sim.groupOf(by('wallet-heavy'), FIRST + 4, 1, 2)], { name: 'GroupFault', group: 0, fault: 'OutsideEpoch' });

  // 668: money only: the buyers fund, nobody serves.
  sim.fundAll(FIRST + 5);

  // 669, the epoch in progress: its pool takes the money that rolled forward.
  sim.fundAll(FIRST + 6);
  sim.serve(FIRST + 6, 1800, DAY, { heat: 0.9 });
  sim.fund(by('wallet-heavy'), currentEpoch + 1, now - 4000);

  // Some splits and claims: a position claims every epoch it has not claimed yet.
  sim.split = {};
  for (const s of SELLERS) for (let e = FIRST; e < currentEpoch; e++) if (s.identityId !== 5) sim.split[`${s.identityId}:${e}`] = true;
  sim.positions = { 1042: 4, 1050: 3, 1077: 1, 1101: 3 };
  let claimAt = sim.startOf(FIRST + 1) + 3600;
  for (const [token, amount] of [['1042', 2811], ['1050', 7422], ['1077', 21880], ['1101', 1090], ['1042', 5620], ['1050', 14810]]) {
    sim.log('RewardsClaimed', claimAt, sim.tx(), { tokenId: token, amount: tok(amount + 0.4321).toString() });
    claimAt += DAY * 0.8;
  }
  sim.logs.sort((a, b) => a.at - b.at);
  return { sim, state: sim.state({ hub: HUB }) };
}

function buildEarly(now) {
  const sim = new Sim({ now, currentEpoch: FIRST });
  // Hours into the first epoch, with only some of the buyers funded.
  sim.startOf(FIRST);
  sim.fundAll(FIRST, { skip: (b) => b.name === 'wallet-bursty' });
  sim.serve(FIRST, 1800, DAY, { heat: 0.8 });
  return { sim, state: sim.state({ hub: HUB }) };
}

function buildPre(now) {
  const start = now + 4 * 3600 + 7 * 60;
  const midnight = start - (start % DAY);
  const sim = new Sim({ now, currentEpoch: FIRST - 1 });
  sim.clock.startTime = midnight - (FIRST - 1) * DAY;
  const state = sim.state({ hub: HUB });
  state.live = { [FIRST]: { epoch: FIRST, wallet: '0', account: '0', served: '0', weighted: '0', lambdaBps: 0, pool: '0', publishingPool: tok(139_351).toString(), allNodesScore: '0', sellers: {}, subs: {} } };
  state.buyersLive = {};
  return { sim, state };
}

function write(variant, data) {
  const dir = join(outDir, variant);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'data.json'), JSON.stringify(data));
  copyFileSync(join(here, 'index.html'), join(dir, 'index.html'));
  console.log(`${variant}: ${JSON.stringify(data).length} bytes, ${data.epochs.length} epochs, ${data.feedTotal ?? 0} feed rows, ${data.checks.filter((c) => c.ok === false).length} failed checks`);
  for (const c of data.checks.filter((x) => x.ok === false)) {
    console.log(`  failed ${c.epoch} ${c.name}: ${c.detail}`);
    process.exitCode = 1;
  }
}

const now = Math.floor(Date.now() / 1000);
const pub = publicFile(HUB);

const live = buildLive(now);
write('live', compose({ state: live.state, pub, status: freshStatus(now), now, network: network() }));

const staleStatus = { ...freshStatus(now - 1260), stale: true, errors: ['RPC: request timed out', 'Explorer: HTTP 502'] };
staleStatus.rpc = { ...staleStatus.rpc, ok: false };
staleStatus.events = { ...staleStatus.events, ok: false };
write('stale', compose({ state: live.state, pub, status: staleStatus, now: now - 60, network: network() }));

const partlyStatus = { ...freshStatus(now), stale: true, errors: ['Explorer: HTTP 502'] };
partlyStatus.events = { ...partlyStatus.events, ok: false, lastOkAt: now - 700 };
write('partly', compose({ state: live.state, pub, status: partlyStatus, now, network: network() }));

const unreadStatus = { stale: true, errors: ['RPC: fetch failed (ECONNRESET)', 'Explorer: not read, the contract addresses are not known yet'], rpc: { ok: false, lastOkAt: null, block: null, blockTime: null }, events: { ok: false, lastOkAt: null, head: null, lagBlocks: null }, public: { source: 'none', at: null }, run: { ms: 4000 } };
write('unread', compose({ state: {}, pub: null, status: unreadStatus, now, network: network() }));

const early = buildEarly(now);
write('early', compose({ state: early.state, pub, status: freshStatus(now), now, network: network() }));

const pre = buildPre(now);
write('pre', compose({ state: pre.state, pub, status: freshStatus(now), now, network: network() }));
write('bare', compose({ state: pre.state, pub: null, status: freshStatus(now, 'none'), now, network: network() }));
