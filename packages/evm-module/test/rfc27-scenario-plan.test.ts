// The pure plan of the OT-RFC-27 marketplace scenario (scripts/rfc27/scenario):
// what it derives from the seed and the epoch, with no chain. The run is
// `npx hardhat test test/rfc27-scenario-plan.test.ts --no-compile --network hardhat --config hardhat.node.config.ts`.

import { expect } from 'chai';
import { ethers } from 'ethers';

import { costOf } from './helpers/conviction-service';
import {
  BUYERS,
  EPOCH_SECONDS,
  EVENTS,
  FIRST_CALL_SLOT,
  FIRST_EPOCH,
  LAST_CALL_SLOT,
  LAST_STRETCH_SECONDS,
  MAIN_SELLER_SHARE_BPS,
  SELLERS,
  SERVICES,
  SLOT_SECONDS,
  TICK_SECONDS,
  TRAC,
  buyerNamed,
  eventOf,
  secondsOfDay,
  sellerNamed,
  serviceNamed,
} from '../scripts/rfc27/scenario/config';
import { buyerWallet, deriveKey, ownerWallet, seedFromHex, sessionWallet } from '../scripts/rfc27/scenario/keys';
import { callIsLive, epochStart, landingDue, landingTimes, planDigestOf, planEpoch, serviceIdOf, valueOf } from '../scripts/rfc27/scenario/plan';
import { publicFile } from '../scripts/rfc27/scenario/public';

const SEEDS = ['a', 'b', 'c'].map((s) => seedFromHex(ethers.id(`plan test seed ${s}`)));
const SEED = SEEDS[0];
const EPOCHS = Array.from({ length: 12 }, (_, i) => FIRST_EPOCH + i);
const OFFSET = { baseline: 0, burst: 1, race: 2, quiet: 3, later: 4 };

describe('@unit OT-RFC-27 scenario plan', function () {
  this.timeout(120_000);

  describe('the keys', () => {
    it('derives each role as keccak256(seed || "rfc27-scenario/<role>")', () => {
      const expected = ethers.keccak256(ethers.concat([SEED, ethers.toUtf8Bytes('rfc27-scenario/buyer/wallet-heavy')]));
      expect(deriveKey(SEED, 'buyer/wallet-heavy')).to.equal(expected);
      expect(buyerWallet(SEED, 'wallet-heavy').privateKey).to.equal(expected);
    });

    it('gives every buyer, owner and session key its own address', () => {
      const all = [
        ...BUYERS.map((b) => buyerWallet(SEED, b.name).address),
        ...BUYERS.filter((b) => b.account).map((b) => ownerWallet(SEED, b.name).address),
        ...BUYERS.map((b) => sessionWallet(SEED, b.name, FIRST_EPOCH).address),
        ...BUYERS.map((b) => sessionWallet(SEED, b.name, FIRST_EPOCH + 1).address),
        ...SELLERS.map((s) => s.address),
      ];
      expect(new Set(all).size).to.equal(all.length);
    });

    it('refuses a seed that is not 32 bytes', () => {
      expect(() => seedFromHex('0x1234')).to.throw();
    });
  });

  describe('the cast', () => {
    it('never homes a buyer on its main seller', () => {
      for (const b of BUYERS) expect(b.home, b.name).to.not.equal(b.mainSeller);
    });

    it('prices each service differently per seller, within the budget caps', () => {
      for (const service of SERVICES) {
        const prices = SELLERS.map((s) => s.prices[service.label]);
        expect(new Set(prices).size, service.label).to.be.greaterThan(1);
        for (const p of prices) expect(p > 0n && p <= service.maxPricePerUnit, service.label).to.equal(true);
      }
    });

    it('prices model-beta above model-alpha at every seller', () => {
      for (const s of SELLERS) expect(s.prices['inference/model-beta'] > s.prices['inference/model-alpha'], s.name).to.equal(true);
    });

    it('commits the tier each account is named for', () => {
      const tier = (committed: number) => (committed >= 1_000_000 ? 7_500 : committed >= 500_000 ? 5_000 : committed >= 250_000 ? 4_000 : committed >= 100_000 ? 3_000 : committed >= 50_000 ? 2_000 : committed >= 25_000 ? 1_000 : 0);
      for (const b of BUYERS.filter((x) => x.account)) expect(tier(b.account?.committedTrac ?? 0), b.name).to.equal(b.account?.discountBps);
      expect(buyerNamed('account-plain').account?.discountBps).to.equal(0);
      expect(buyerNamed('account-30').account?.committedTrac).to.equal(100_000);
      expect(buyerNamed('account-75').account?.committedTrac).to.equal(1_000_000);
    });

    it('names only known buyers, sellers and services in the script', () => {
      const names = new Set<string>(['all', ...BUYERS.map((b) => b.name), ...SELLERS.map((s) => s.name)]);
      for (const e of EVENTS) {
        expect(names.has(e.who), e.who).to.equal(true);
        expect(() => secondsOfDay(e.atUtc)).to.not.throw();
        if (e.service) expect(serviceNamed(e.service).label).to.equal(e.service);
        for (const s of e.sellers ?? []) expect(sellerNamed(s).name).to.equal(s);
      }
    });
  });

  describe('a plan', () => {
    it('is a pure function of the seed and the epoch', () => {
      const text = (seed: Uint8Array, e: number) => JSON.stringify(planEpoch(seed, e), (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
      expect(text(SEED, FIRST_EPOCH)).to.equal(text(SEED, FIRST_EPOCH));
      expect(text(SEED, FIRST_EPOCH)).to.not.equal(text(SEEDS[1], FIRST_EPOCH));
      expect(text(SEED, FIRST_EPOCH)).to.not.equal(text(SEED, FIRST_EPOCH + 1));
    });

    it('funds every buyer in every epoch, offset 3 included, with budgets in strictly increasing serviceId', () => {
      for (const seed of SEEDS) {
        for (const e of EPOCHS) {
          const plan = planEpoch(seed, e);
          expect(plan.subscriptions.map((s) => s.buyer)).to.deep.equal(BUYERS.map((b) => b.name));
          for (const s of plan.subscriptions) {
            expect(s.budgets.length).to.be.greaterThan(0);
            for (let i = 1; i < s.budgets.length; i++) expect(BigInt(s.budgets[i - 1].serviceId) < BigInt(s.budgets[i].serviceId), s.buyer).to.equal(true);
            expect(s.value).to.equal(s.budgets.reduce((a, b) => a + b.value, 0n));
          }
        }
      }
    });

    it('keeps each subscription in the hundreds of TRAC, with some variation per epoch', () => {
      for (const b of BUYERS) {
        const values = EPOCHS.map((e) => planEpoch(SEED, e).subscriptions.find((s) => s.buyer === b.name)?.value ?? 0n);
        for (const v of values) expect(v >= 100n * TRAC && v < 1_000n * TRAC, `${b.name}: ${v}`).to.equal(true);
        expect(new Set(values.map(String)).size, b.name).to.be.greaterThan(1);
      }
    });

    it('costs each account its value at its discount', () => {
      const plan = planEpoch(SEED, FIRST_EPOCH);
      for (const s of plan.subscriptions) {
        expect(s.discountBps).to.equal(buyerNamed(s.buyer).account?.discountBps ?? 0);
        expect(s.cost).to.equal(costOf(s.value, BigInt(s.discountBps)));
      }
      expect(plan.subscriptions.find((s) => s.buyer === 'account-30')?.cost).to.equal(((plan.subscriptions.find((s) => s.buyer === 'account-30')?.value ?? 0n) * 7_000n) / 10_000n);
      expect(plan.subscriptions.find((s) => s.buyer === 'account-75')?.cost).to.equal(((plan.subscriptions.find((s) => s.buyer === 'account-75')?.value ?? 0n) * 2_500n) / 10_000n);
    });

    it('commits to its budgets in the plan digest', () => {
      const s = planEpoch(SEED, FIRST_EPOCH).subscriptions[0];
      const other = s.budgets.map((b, i) => (i === 0 ? { ...b, value: b.value + 1n } : b));
      expect(planDigestOf(FIRST_EPOCH, s.buyer, s.budgets)).to.not.equal(planDigestOf(FIRST_EPOCH, s.buyer, other));
    });
  });

  describe('the calls', () => {
    it('are well formed, within the budget terms and the epoch', function () {
      this.timeout(300_000);
      for (const seed of SEEDS.slice(0, 2)) {
        for (const e of EPOCHS.slice(0, 7)) {
          const plan = planEpoch(seed, e);
          for (const c of plan.calls) {
            const what = `${e}/${c.buyer}/${c.service}/${c.slot}`;
            const budget = plan.subscriptions.find((s) => s.buyer === c.buyer)?.budgets.find((b) => b.service === c.service);
            expect(budget, what).to.not.equal(undefined);
            expect(c.price <= (budget?.maxPricePerUnit ?? 0n), what).to.equal(true);
            expect(c.price).to.equal(sellerNamed(c.seller).prices[c.service]);
            expect(c.units > 0n && c.units <= c.maxUnits, what).to.equal(true);
            expect(c.value).to.equal(c.units * c.price);
            expect(c.slot >= FIRST_CALL_SLOT && c.slot <= LAST_CALL_SLOT, what).to.equal(true);
            expect(c.issuedAt >= plan.start + c.slot * SLOT_SECONDS && c.issuedAt < plan.start + (c.slot + 1) * SLOT_SECONDS, what).to.equal(true);
            expect(c.issuedAt <= c.completedAt && c.completedAt <= c.expiry, what).to.equal(true);
            expect(c.completedAt < plan.end - 3 * TICK_SECONDS, what).to.equal(true);
            expect(ethers.getBytes(c.resultCommitment).length).to.equal(32);
            expect(BigInt(c.resultCommitment) !== 0n, what).to.equal(true);
          }
        }
      }
    });

    it('have one call per buyer, service and slot, and so a unique nonce per subscription and seller', function () {
      this.timeout(120_000);
      for (const e of EPOCHS) {
        const seen = new Set<string>();
        const perBuyer = new Set<string>();
        for (const c of planEpoch(SEED, e).calls) {
          const key = `${c.buyer}/${c.seller}/${c.nonce}`;
          expect(seen.has(key), key).to.equal(false);
          seen.add(key);
          const across = `${c.buyer}/${c.nonce}`;
          expect(perBuyer.has(across), across).to.equal(false);
          perBuyer.add(across);
        }
      }
    });

    it('come about to each buyer\'s utilization, on a baseline epoch', () => {
      for (const seed of SEEDS) {
        for (const e of [FIRST_EPOCH, FIRST_EPOCH + OFFSET.later, FIRST_EPOCH + 7]) {
          const plan = planEpoch(seed, e);
          for (const s of plan.subscriptions) {
            const used = valueOf(plan.calls.filter((c) => c.buyer === s.buyer));
            const bps = Number((used * 10_000n) / s.value);
            const target = buyerNamed(s.buyer).utilizationBps;
            expect(bps, `${e}/${s.buyer}`).to.be.within(target - 100, target);
          }
        }
      }
      expect(buyerNamed('wallet-heavy').utilizationBps).to.equal(9_000);
      expect(buyerNamed('wallet-light').utilizationBps).to.equal(2_500);
    });

    it('never exceed a budget on a baseline epoch', () => {
      for (const e of [FIRST_EPOCH, FIRST_EPOCH + OFFSET.later, FIRST_EPOCH + 9]) {
        const plan = planEpoch(SEED, e);
        for (const s of plan.subscriptions) {
          for (const b of s.budgets) expect(valueOf(plan.calls.filter((c) => c.buyer === s.buyer && c.service === b.service)) <= b.value).to.equal(true);
        }
      }
    });

    it('go mostly to the buyer\'s main seller, and to every seller', () => {
      for (const b of BUYERS) {
        const calls = EPOCHS.flatMap((e) => planEpoch(SEED, e).calls.filter((c) => c.buyer === b.name));
        const main = calls.filter((c) => c.seller === b.mainSeller).length;
        const share = Math.floor((main * 10_000) / calls.length);
        expect(share, b.name).to.be.within(MAIN_SELLER_SHARE_BPS - 1_000, MAIN_SELLER_SHARE_BPS + 1_500);
        expect(new Set(calls.map((c) => c.seller)).size, b.name).to.equal(SELLERS.length);
      }
    });
  });

  describe('the script', () => {
    it('offset 0 is a baseline: no top-up, no race, nothing held', () => {
      const plan = planEpoch(SEED, FIRST_EPOCH + OFFSET.baseline);
      expect(plan.calls.length).to.be.greaterThan(100);
      expect(plan.calls.some((c) => c.race || c.held)).to.equal(false);
      expect(plan.subscriptions.some((s) => s.topUp)).to.equal(false);
    });

    it('offset 1: wallet-bursty tops up, its calls before within what it funded and after within what it adds', () => {
      const plan = planEpoch(SEED, FIRST_EPOCH + OFFSET.burst);
      const sub = plan.subscriptions.find((s) => s.buyer === 'wallet-bursty');
      expect(sub?.topUp?.atSecond).to.equal(12 * 3_600);
      expect(plan.subscriptions.filter((s) => s.topUp).length).to.equal(1);
      const split = Math.floor((sub?.topUp?.atSecond ?? 0) / SLOT_SECONDS);
      const budgets = sub?.budgets ?? [];
      for (const b of budgets) {
        const calls = plan.calls.filter((c) => c.buyer === 'wallet-bursty' && c.service === b.service);
        const added = sub?.topUp?.additions.find((a) => a.service === b.service)?.value ?? 0n;
        expect(added > 0n).to.equal(true);
        const first = valueOf(calls.filter((c) => c.slot < split));
        const second = valueOf(calls.filter((c) => c.slot > split));
        expect(first > 0n && first <= b.value).to.equal(true);
        expect(second > 0n && second <= added).to.equal(true);
        expect(calls.some((c) => c.slot === split)).to.equal(false);
      }
      expect(sub?.topUp?.additions.map((a) => a.serviceId)).to.deep.equal(budgets.map((b) => b.serviceId));
      expect(sub?.topUp?.additions.map((a) => a.maxPricePerUnit)).to.deep.equal(budgets.map((b) => b.maxPricePerUnit));
    });

    it('offset 1: account-30 is removed at 16:00, and added again at the start of offset 2', () => {
      expect(eventOf(OFFSET.burst, 'remove-buyer')?.who).to.equal('account-30');
      expect(eventOf(OFFSET.burst, 'remove-buyer')?.atUtc).to.equal('16:00');
      expect(eventOf(OFFSET.race, 'add-buyer')?.who).to.equal('account-30');
    });

    it('a call counts from the recorded start, and only before the grant ended', () => {
      const c = planEpoch(SEED, FIRST_EPOCH).calls[0];
      const at = BigInt(c.issuedAt);
      expect(callIsLive(c, { startsAt: at, grantEnd: at + 1n })).to.equal(true);
      expect(callIsLive(c, { startsAt: at + 1n, grantEnd: at + 2n })).to.equal(false);
      expect(callIsLive(c, { startsAt: at, grantEnd: at })).to.equal(false);
    });

    it('offset 2: two sellers take turns past the budget\'s limit', () => {
      for (const seed of SEEDS) {
        const plan = planEpoch(seed, FIRST_EPOCH + OFFSET.race);
        const race = eventOf(OFFSET.race, 'race');
        const racing = plan.calls.filter((c) => c.race);
        expect(racing.length).to.equal(4);
        expect(new Set(racing.map((c) => c.seller))).to.deep.equal(new Set(race?.sellers));
        for (const c of racing) {
          expect(c.buyer).to.equal(race?.who);
          expect(c.service).to.equal(race?.service);
        }
        const budget = plan.subscriptions.find((s) => s.buyer === race?.who)?.budgets.find((b) => b.service === race?.service);
        const before = valueOf(plan.calls.filter((c) => c.buyer === race?.who && c.service === race?.service && !c.race));
        const all = before + valueOf(racing);
        expect(before < (budget?.value ?? 0n), 'the baseline stops short').to.equal(true);
        expect(all > (budget?.value ?? 0n), 'the demand is past the limit').to.equal(true);
        // Either seller alone would still fit: only the order decides who is cut.
        for (const s of race?.sellers ?? []) expect(before + valueOf(racing.filter((c) => c.seller === s)) <= (budget?.value ?? 0n), s).to.equal(true);
      }
    });

    it('offset 2: beacon-03 holds its last batch, and it is never empty', () => {
      for (const seed of SEEDS) {
        const plan = planEpoch(seed, FIRST_EPOCH + OFFSET.race);
        const held = plan.calls.filter((c) => c.held);
        expect(held.length).to.be.greaterThan(0);
        const from = secondsOfDay(eventOf(OFFSET.race, 'held-batch')?.atUtc ?? '') / SLOT_SECONDS;
        for (const c of held) {
          expect(c.seller).to.equal('beacon-03');
          expect(c.slot >= from).to.equal(true);
          expect(c.race).to.equal(false);
        }
        expect(plan.calls.filter((c) => c.seller === 'beacon-03' && c.slot >= from && !c.held).length).to.equal(0);
        expect(plan.calls.filter((c) => c.seller === 'beacon-03' && !c.held).length).to.be.greaterThan(0);
      }
    });

    it('offset 3 has funding and no calls', () => {
      for (const seed of SEEDS) {
        const plan = planEpoch(seed, FIRST_EPOCH + OFFSET.quiet);
        expect(plan.calls.length).to.equal(0);
        expect(plan.subscriptions.length).to.equal(BUYERS.length);
      }
    });

    it('from offset 4, a baseline whose demand varies per epoch', () => {
      const counts = EPOCHS.slice(OFFSET.later).map((e) => planEpoch(SEED, e).calls.length);
      expect(new Set(counts).size).to.be.greaterThan(1);
      for (const e of EPOCHS.slice(OFFSET.later)) {
        const plan = planEpoch(SEED, e);
        expect(plan.calls.length).to.be.greaterThan(100);
        expect(plan.calls.some((c) => c.race || c.held)).to.equal(false);
      }
    });
  });

  describe('the landings', () => {
    it('come every 30 to 60 minutes, up to the last stretch', () => {
      for (const s of SELLERS) {
        for (const e of EPOCHS) {
          const times = landingTimes(SEED, e, s.name);
          expect(times.length).to.be.within(20, 46);
          let last = 0;
          for (const t of times) {
            expect(t - last).to.be.within(1_800, 3_600);
            last = t;
          }
          expect(EPOCH_SECONDS - LAST_STRETCH_SECONDS - last).to.be.lessThanOrEqual(3_600);
        }
      }
    });

    it('fall on one tick each, and on every tick of the last stretch', () => {
      for (const s of SELLERS) {
        const e = FIRST_EPOCH;
        const ticks: number[] = [];
        for (let m = s.tickMinute; m < EPOCH_SECONDS / 60; m += 5) ticks.push(m * 60 + 15);
        const due = ticks.filter((t) => landingDue(SEED, e, s.name, t));
        const last = ticks.filter((t) => t >= EPOCH_SECONDS - LAST_STRETCH_SECONDS);
        expect(due.length).to.equal(landingTimes(SEED, e, s.name).length + last.length);
        for (const t of last) expect(landingDue(SEED, e, s.name, t)).to.equal(true);
      }
    });

    it('stay within the batch bounds between landings', () => {
      for (const seed of SEEDS) {
        for (const e of [FIRST_EPOCH, FIRST_EPOCH + OFFSET.burst, FIRST_EPOCH + OFFSET.race]) {
          const plan = planEpoch(seed, e);
          for (const s of SELLERS) {
            const own = plan.calls.filter((c) => c.seller === s.name);
            const times = [...landingTimes(seed, e, s.name), EPOCH_SECONDS];
            let from = 0;
            for (const t of times) {
              const inWindow = own.filter((c) => c.completedAt - plan.start >= from && c.completedAt - plan.start < t);
              expect(inWindow.length).to.be.lessThanOrEqual(256);
              expect(new Set(inWindow.map((c) => `${c.buyer}/${c.service}`)).size).to.be.lessThanOrEqual(32);
              from = t;
            }
          }
        }
      }
    });

    it('starts the first epoch where the chain does', () => {
      expect(epochStart(FIRST_EPOCH)).to.equal(Date.UTC(2026, 10, 7) / 1000);
      expect(epochStart(FIRST_EPOCH + 2)).to.equal(Date.UTC(2026, 10, 9) / 1000);
    });
  });

  describe('the public file', () => {
    const file = publicFile(SEED, { 'account-30': 42 });
    const text = JSON.stringify(file);

    it('holds no key and not the seed', () => {
      expect(text).to.not.contain(ethers.hexlify(SEED).slice(2));
      for (const b of BUYERS) {
        expect(text).to.not.contain(buyerWallet(SEED, b.name).privateKey.slice(2));
        expect(text).to.not.contain(ownerWallet(SEED, b.name).privateKey.slice(2));
      }
    });

    it('names the cast, with its ids', () => {
      expect(file.network.chainId).to.equal(84532);
      expect(file.firstEpoch).to.equal(FIRST_EPOCH);
      expect(file.sellers.map((s) => s.identityId)).to.deep.equal([4, 3, 1, 5]);
      for (const s of file.services) expect(s.serviceId).to.equal(serviceIdOf(s.label));
      expect(file.services.map((s) => s.serviceClass)).to.deep.equal([1, 1, 2]);
      const buyer = file.buyers.find((b) => b.name === 'account-30');
      expect(buyer?.accountId).to.equal(42);
      expect(buyer?.discountBps).to.equal(3_000);
      expect(buyer?.owner).to.equal(ownerWallet(SEED, 'account-30').address);
      const wallet = file.buyers.find((b) => b.name === 'wallet-heavy');
      expect(wallet?.pays).to.equal('wallet');
      expect(wallet?.owner).to.equal(null);
      expect(wallet?.accountId).to.equal(null);
      expect(wallet?.home).to.equal('beacon-02');
      expect(file.events.some((e) => e.kind === 'top-up' && e.epochOffset === 1 && e.who === 'wallet-bursty')).to.equal(true);
    });
  });
});
