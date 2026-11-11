// SPDX-License-Identifier: Apache-2.0
/**
 * The renewal job near the end of an epoch, against MockChainAdapter (30-day
 * epochs): it funds or adds to the epoch under way only while a quarter of it,
 * and at least fifteen minutes, is left, and otherwise waits for the next
 * epoch, which it prefunds within the lead as before; and the plan's next
 * renewal, as the node API shows it, says the same.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, marketplaceChainOf, subscriptionIdOf, type EpochTimes, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import { Buyer, BuyerStore, RENEWAL_MIN_SECONDS, parsePlan, planView, renewsEpochUnderWay } from '../src/index.js';

const SIGNER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const TRAC = 10n ** 18n;
const DAY = 86_400;
const A = `0x${'0a'.repeat(32)}`;
const B = `0x${'0b'.repeat(32)}`;
const plan = (services = [A]) => parsePlan({
  services: services.map((serviceId) => ({ serviceId, serviceClass: 'inference', value: String(TRAC), maxPricePerUnit: '1000' })),
  source: { kind: 'wallet' },
  renew: true,
  renewUntilEpoch: 10,
});

let dir: string;
let chain: MarketplaceChainAdapter;
let buyer: Buyer;
let times: EpochTimes;
const funded = (epoch: number) => chain.subscriptionExists(subscriptionIdOf(SIGNER.address, epoch));
/** The chain's time `seconds` before the epoch under way ends. */
const before = (seconds: number) => vi.spyOn(chain, 'getEpochTimes').mockResolvedValue({ ...times, now: times.endsAt - seconds });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-renewal-'));
  const mock = new MockChainAdapter('mock:31337', SIGNER.address);
  chain = marketplaceChainOf(mock)!;
  buyer = new Buyer({ chain, store: new BuyerStore(dir), config: { enabled: true, buyerWallet: SIGNER.address, prefundLeadSeconds: 7_200, tickSeconds: 300 } });
  times = await chain.getEpochTimes();
  expect(times.endsAt - times.startsAt).toBe(30 * DAY);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the renewal job near the end of an epoch', () => {
  it('funds the epoch under way while a quarter of it is left', async () => {
    await buyer.store.writePlan(plan());
    before(7.5 * DAY);
    await buyer.tick();
    expect(await funded(times.epoch)).toBe(true);
    expect(await funded(times.epoch + 1)).toBe(false);
  });

  it('leaves the epoch under way with less left, and funds nothing before the prefund lead', async () => {
    await buyer.store.writePlan(plan());
    const sends = vi.spyOn(chain, 'fundFromWallet');
    before(7.5 * DAY - 1);
    await buyer.tick();
    expect(sends).not.toHaveBeenCalled();
    expect(buyer.renewals.size).toBe(0);
  });

  it('prefunds the next epoch instead within the lead, so service resumes at the boundary', async () => {
    await buyer.store.writePlan(plan());
    before(3_600);
    await buyer.tick();
    expect(await funded(times.epoch)).toBe(false);
    expect(await funded(times.epoch + 1)).toBe(true);
  });

  it('adds no plan service to the epoch under way with less than a quarter left', async () => {
    await buyer.store.writePlan(plan());
    await buyer.tick();
    expect(await funded(times.epoch)).toBe(true);
    await buyer.store.writePlan(plan([A, B]));
    const topUps = vi.spyOn(chain, 'topUpFromWallet');
    before(DAY);
    await buyer.tick();
    expect(topUps).not.toHaveBeenCalled();
  });

  it('asks a quarter of any epoch, and fifteen minutes of a short one', () => {
    const epoch = (length: number, left: number): EpochTimes => ({ epoch: 1, startsAt: 0, endsAt: length, now: length - left });
    // A one-day epoch: six hours.
    expect(renewsEpochUnderWay(epoch(DAY, 6 * 3_600))).toBe(true);
    expect(renewsEpochUnderWay(epoch(DAY, 6 * 3_600 - 1))).toBe(false);
    // A one-hour epoch: fifteen minutes, the floor too.
    expect(renewsEpochUnderWay(epoch(3_600, 900))).toBe(true);
    expect(renewsEpochUnderWay(epoch(3_600, 899))).toBe(false);
    // A ten-minute epoch is never funded once under way: calls stop a few minutes before its end.
    expect(renewsEpochUnderWay(epoch(600, 600))).toBe(false);
    expect(RENEWAL_MIN_SECONDS).toBeGreaterThan(180);
  });
});

describe("the plan's next renewal", () => {
  it('names the epoch the job funds next: the one under way while a quarter of it is left, then the next one', async () => {
    await buyer.store.writePlan(plan());
    before(7.5 * DAY);
    expect((await planView(buyer, plan())).next).toMatchObject({ epoch: times.epoch, at: times.endsAt - 7.5 * DAY });
    before(7.5 * DAY - 1);
    expect((await planView(buyer, plan())).next).toMatchObject({ epoch: times.epoch + 1, at: times.endsAt - 7_200 });
    // Within the lead, from now.
    before(3_600);
    expect((await planView(buyer, plan())).next).toMatchObject({ epoch: times.epoch + 1, at: times.endsAt - 3_600 });
  });
});
