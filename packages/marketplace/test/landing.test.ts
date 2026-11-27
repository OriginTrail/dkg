// SPDX-License-Identifier: Apache-2.0
/**
 * The seller's landing loop and ledger against MockChainAdapter's marketplace,
 * on a clock the tests set: when a tick is due, why it stops, batches within
 * the chain's bounds, faults dropped, a batch whose fate is not known yet, a
 * crash right after a send, receipts missed at the epoch's end, and pruning.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  SERVICE_CLASS_INFERENCE,
  marketplaceChainOf,
  signServiceRequest,
  type EpochTimes,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import {
  DEFAULT_LANDING,
  Seller,
  SellerLedger,
  batchesOf,
  receiptItemOfCall,
  requestFromWire,
  requestToWire,
  secondsToNextTick,
  secondsToRetry,
  serviceIdOf,
  type Connector,
  type LandingReport,
  type LandingSettings,
} from '../src/index.js';

const SELLER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const SESSION = new ethers.Wallet(`0x${'33'.repeat(32)}`);
const BUYER = ethers.getAddress(`0x${'b1'.repeat(20)}`);
const MODEL = 'urn:test:model:landing';
const A = serviceIdOf(MODEL);
const PRICE = 10n;
// A short question: its input bound, 25 units, is under the smallest cap a case sets (30 units).
const BODY = { messages: [{ role: 'user' as const, content: 'q' }], max_tokens: 50 };
const HOUR = 3_600;
const EPOCH = 30 * 86_400;
/** Each call: 12 units in, 8 out, at 10 wei. */
const CALL_VALUE = 200n;

const backend: Connector = { kind: 'openai', complete: async () => ({ content: 'synthetic answer', promptTokens: 12, completionTokens: 8 }) };

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
let subscriptionId: string;
let logs: string[];
/** The chain's time, in seconds from the current epoch's start. */
let clock: number;

const at = (seconds: number) => { clock = seconds; };
const later = (seconds: number) => { clock += seconds; };

function sellerWith(landing: Partial<LandingSettings> = {}): Seller {
  return new Seller({
    chain, dir, signer: SELLER.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
    services: [{ model: MODEL, serviceId: A, pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed', connector: backend }],
    landing: { ...DEFAULT_LANDING, ...landing },
    log: (m) => logs.push(m),
  });
}

async function started(landing: Partial<LandingSettings> = {}): Promise<Seller> {
  const seller = sellerWith(landing);
  await seller.load();
  await seller.tick();
  return seller;
}

/** Fund the buyer's subscription of the current epoch (or the next) with `value` for A. */
async function fund(value = 10n ** 6n, buyer = BUYER, epochOffset = 0): Promise<string> {
  const { epoch } = await chain.getEpochTimes();
  await chain.approveServiceSubscriptionsWallet(10n ** 24n, { from: buyer });
  const budgets = [{ serviceId: A, serviceClass: SERVICE_CLASS_INFERENCE, value, maxPricePerUnit: 100n }];
  return (await chain.fundFromWallet({ epoch: epoch + epochOffset, sessionKey: SESSION.address, planDigest: ethers.ZeroHash, budgets }, { from: buyer })).subscriptionId;
}

/** Serve `n` calls, nonces from `from`, each worth `CALL_VALUE`. */
async function serve(seller: Seller, n: number, from = 0, maxValueWei = 10_000n): Promise<void> {
  const { now } = await chain.getEpochTimes();
  for (let i = 0; i < n; i++) {
    const request: ServiceRequest = {
      subscriptionId, serviceId: A, seller: seller.gate.identityId, nonce: BigInt(from + i), pricePerUnit: PRICE,
      maxUnits: 1_000n, maxValueWei, issuedAt: now, expiry: now + 600,
    };
    const answer = await seller.serve({ request: requestToWire(request), signature: signServiceRequest(SESSION.privateKey, domain, request), body: BODY });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
  }
}

const sent = (report: LandingReport | undefined) => (report && 'sent' in report ? report.sent.map((b) => b.items) : report);
const counts = async (seller: Seller) => seller.ledger.epochReport((await chain.getEpochTimes()).epoch).summary.counts;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-landing-'));
  mock = new MockChainAdapter('mock:31337', SELLER.address);
  mock.setMockACKSigner(SELLER);
  await mock.ensureProfile();
  chain = marketplaceChainOf(mock)!;
  const real = chain.getEpochTimes.bind(chain);
  vi.spyOn(chain, 'getEpochTimes').mockImplementation(async (): Promise<EpochTimes> => {
    const t = await real();
    return { ...t, now: t.startsAt + clock };
  });
  domain = (await chain.getMarketplaceContracts()).requestDomain;
  logs = [];
  at(HOUR);
  subscriptionId = await fund();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('when a tick lands', () => {
  it('at each landing time, and at every tick of the last stretch', async () => {
    const seller = await started({ nearLimitShare: 0 });
    await serve(seller, 2);
    later(31);
    // The first two hours are one slot: nothing is due before the next landing time.
    expect(await seller.lander.tick()).toEqual({ stopped: 'not-due' });
    at(2 * HOUR + 1);
    expect(sent(await seller.lander.tick())).toEqual([2]);
    await serve(seller, 1, 2);
    later(60);
    expect(await seller.lander.tick()).toEqual({ stopped: 'not-due' });
    at(4 * HOUR);
    expect(sent(await seller.lander.tick())).toEqual([1]);
    // The last 20 minutes: every tick.
    at(EPOCH - 19 * 60);
    for (const nonce of [3, 4]) {
      await serve(seller, 1, nonce);
      later(31);
      expect(sent(await seller.lander.tick())).toEqual([1]);
    }
    expect(await counts(seller)).toEqual({ served: 0, sent: 0, landed: 5, refused: 0, missed: 0 });
  });

  it('near a budget limit, when asked, and on the final tick', async () => {
    const main = subscriptionId;
    subscriptionId = await fund(1_000n, ethers.getAddress(`0x${'b2'.repeat(20)}`));
    const seller = await started({ lastStretchMinutes: 0 });
    // Calls of 200 wei over 1,000 left: three reach half of it.
    await serve(seller, 2, 0, 300n);
    later(31);
    expect(await seller.lander.tick()).toEqual({ stopped: 'not-due' });
    await serve(seller, 1, 2, 300n);
    later(31);
    expect(sent(await seller.lander.tick())).toEqual([3]);

    subscriptionId = main;
    await serve(seller, 1, 0);
    later(31);
    seller.lander.landNow();
    expect(sent(await seller.lander.tick())).toEqual([1]);
    // The last landing time, then the final tick, once.
    at(EPOCH - 250);
    expect(await seller.lander.tick()).toEqual({ stopped: 'nothing-ready' });
    await serve(seller, 1, 1);
    at(EPOCH - 50);
    expect(sent(await seller.lander.tick())).toEqual([1]);
    at(EPOCH - 40);
    expect(await seller.lander.tick()).toEqual({ stopped: 'not-due' });
  });

  it('takes turns: a tick asked for while another runs waits for it, and sends nothing twice', async () => {
    const seller = await started();
    await serve(seller, 2);
    later(31);
    seller.lander.landNow();
    const [first, second] = await Promise.all([seller.lander.tick(), seller.lander.tick()]);
    expect(sent(first)).toEqual([2]);
    expect(second).toEqual({ stopped: 'not-due' });
  });

  it('ticks from the epoch start, and once more just before its end', () => {
    const times = { epoch: 1, startsAt: 1_000, endsAt: 1_000 + EPOCH, now: 1_000 + 601 };
    expect(secondsToNextTick(times, 300, 60)).toBe(299);
    expect(secondsToNextTick({ ...times, now: times.endsAt - 100 }, 300, 60)).toBe(40);
    expect(secondsToNextTick({ ...times, now: times.endsAt - 100 }, 300, 0)).toBe(100);
    expect(secondsToNextTick({ ...times, now: times.endsAt - 60 }, 300, 60)).toBe(60);
    // After a tick that failed: 30 seconds, or a shorter tick, and never past the final tick.
    const late = { ...times, now: times.endsAt - 300 };
    expect(secondsToRetry(undefined, 0, 300, 60)).toBe(30);
    expect(secondsToRetry(undefined, 0, 10, 60)).toBe(10);
    expect(secondsToRetry(late, 0, 300, 60)).toBe(30);
    expect(secondsToRetry(late, 225, 300, 60)).toBe(15);
    expect(secondsToRetry(late, 240, 300, 60)).toBe(1);
    expect(secondsToRetry(late, 300, 300, 60)).toBe(30);
    expect(secondsToRetry(late, 225, 300, 0)).toBe(30);
  });

  it('lands on a tick whose gate reads fail, by the gate the last tick read', async () => {
    const seller = await started();
    await serve(seller, 1);
    later(31);
    vi.spyOn(chain, 'getIdentityId').mockRejectedValueOnce(new Error('the endpoint is away'));
    seller.lander.landNow();
    await seller.tick();
    expect(seller.gate.open).toBe(true);
    expect(seller.lastLanding).toMatchObject({ sent: [{ items: 1 }] });
    expect(logs).toEqual([expect.stringMatching(/gate was not read; it stays open: the endpoint is away/)]);
  });

  it('tries a tick that fails 300 seconds before the end again every 30 seconds, and the final tick lands', async () => {
    at(EPOCH - 600);
    const seller = await started();
    await serve(seller, 1);
    // The chain's reads fail from 300 seconds before the end until the final tick.
    const base = await chain.getEpochTimes();
    vi.mocked(chain.getEpochTimes).mockImplementation(async () => {
      const now = base.startsAt + clock;
      if (now >= base.endsAt - 300 && now < base.endsAt - 60) throw new Error('the endpoint is away');
      return { ...base, now };
    });
    vi.useFakeTimers();
    try {
      const step = async (seconds: number) => {
        later(seconds);
        await vi.advanceTimersByTimeAsync(seconds * 1_000);
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      };
      seller.start();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      // The aligned tick 300 seconds before the end fails, and so does each try until the final tick's time.
      await step(300);
      for (let i = 0; i < 7; i++) await step(30);
      const failed = logs.filter((m) => m.includes('seller tick failed'));
      expect(failed).toHaveLength(8);
      expect(failed.every((m) => /tried again in 30 s: the endpoint is away/.test(m))).toBe(true);
      await step(30);
      expect(seller.lastLanding).toMatchObject({ sent: [{ items: 1 }] });
      await seller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('why a tick stops', () => {
  it('while not serving, in the end margin, without a node score, over the base fee, and with nothing ready', async () => {
    const seller = await started();
    await serve(seller, 1);
    expect(await seller.lander.tick(false)).toEqual({ stopped: 'not-serving' });
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ stopped: 'nothing-ready' });
    later(31);
    const score = vi.spyOn(chain, 'getNodeEpochScore').mockResolvedValue(0n);
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ stopped: 'no-node-score' });
    score.mockRestore();
    mock.mockBaseFee = 10n ** 12n;
    // The retry makes the next tick due.
    expect(await seller.lander.tick()).toEqual({ stopped: 'base-fee' });
    // 0.5 gwei: over the ceiling until the last stretch, whose ceiling is 1 gwei.
    mock.mockBaseFee = 5n * 10n ** 8n;
    expect(await seller.lander.tick()).toEqual({ stopped: 'base-fee' });
    at(EPOCH - 10 * 60);
    expect(sent(await seller.lander.tick())).toEqual([1]);
    at(EPOCH - 30);
    expect(await seller.lander.tick()).toEqual({ stopped: 'end-margin' });
  });

  it('waits while the settlement is paused or not active yet', async () => {
    const seller = await started();
    await serve(seller, 1);
    later(31);
    const state = vi.spyOn(chain, 'batchState').mockResolvedValueOnce({ activationEpoch: 1, paused: true, maxGroups: 32, maxItems: 256 });
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ stopped: 'not-active' });
    const { epoch } = await chain.getEpochTimes();
    state.mockResolvedValueOnce({ activationEpoch: epoch + 1, paused: false, maxGroups: 32, maxItems: 256 });
    expect(await seller.lander.tick()).toEqual({ stopped: 'not-active' });
    // The retry each left: the next tick lands.
    expect(sent(await seller.lander.tick())).toEqual([1]);
  });

  it('skips a budget with nothing left', async () => {
    const seller = await started();
    await serve(seller, 1);
    later(31);
    vi.spyOn(chain, 'budgetLeft').mockResolvedValue(0n);
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ stopped: 'nothing-ready' });
    expect(await counts(seller)).toMatchObject({ served: 1 });
  });
});

describe('a batch', () => {
  it("is split by the chain's bounds, and marks what another sender landed without sending it", async () => {
    vi.spyOn(chain, 'batchState').mockResolvedValue({ activationEpoch: 1, paused: false, maxGroups: 32, maxItems: 2 });
    const seller = await started({ maxBatchesPerTick: 2 });
    await serve(seller, 6);
    later(31);
    // One receipt lands from elsewhere first: its nonce is used.
    const [first] = seller.ledger.inState('served');
    await chain.submitReceiptBatch([{ subscriptionId, budgetIndex: 0, minCounted: 0n, items: [receiptItemOfCall(first!)] }]);
    seller.lander.landNow();
    expect(sent(await seller.lander.tick())).toEqual([2, 2]);
    seller.lander.landNow();
    expect(sent(await seller.lander.tick())).toEqual([1]);
    expect(seller.ledger.stateOf(first!.requestDigest)).toBe('landed');
    expect(await counts(seller)).toMatchObject({ landed: 6 });
    expect(batchesOf([{ calls: [1, 2, 3] }, { calls: [4] }, { calls: [5, 6] }], 2, 3).map((b) => b.map((g) => g.calls))).toEqual([[[1, 2, 3]], [[4], [5, 6]]]);
    expect(batchesOf([], 2, 3)).toEqual([]);
  });

  it('lands the groups of two subscriptions in one, each counted on its own budget', async () => {
    const main = subscriptionId;
    const small = await fund(300n, ethers.getAddress(`0x${'b4'.repeat(20)}`));
    const seller = await started();
    await serve(seller, 2);
    subscriptionId = small;
    await serve(seller, 1, 0, 300n);
    later(31);
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ sent: [{ batchId: expect.any(String), txHash: expect.any(String), items: 3, value: 600n, counted: 600n }], refused: 0, waiting: false });
    expect(await chain.budgetLeft(main, 0)).toBe(10n ** 6n - 400n);
    expect(await chain.budgetLeft(small, 0)).toBe(100n);
  });

  it('leaves a retry when the chain refuses the batch for no fault of a receipt', async () => {
    const seller = await started();
    await serve(seller, 1);
    later(31);
    // The score is read, then gone by the time the batch is checked.
    vi.spyOn(chain, 'getNodeEpochScore').mockResolvedValueOnce(1n).mockResolvedValueOnce(0n);
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ sent: [], refused: 0, waiting: false });
    vi.spyOn(chain, 'submitReceiptBatch').mockRejectedValueOnce('the endpoint is away');
    expect(await seller.lander.tick()).toEqual({ sent: [], refused: 0, waiting: false });
    expect(logs).toEqual([expect.stringMatching(/not sent: the endpoint is away/)]);
    expect(sent(await seller.lander.tick())).toEqual([1]);
  });

  it('drops a faulty receipt and a faulty group, and gives up after the most drops', async () => {
    const seller = await started();
    await serve(seller, 2);
    const [call] = seller.ledger.inState('served');
    // A receipt whose request another key signed, and one on the next epoch's subscription.
    const stranger = new ethers.Wallet(`0x${'44'.repeat(32)}`);
    const forged = { ...requestFromWire(call!.request), nonce: 7n };
    await seller.ledger.recordServed({
      ...call!, requestDigest: ethers.id('forged'), request: requestToWire(forged), signature: signServiceRequest(stranger.privateKey, domain, forged),
    });
    const next = await fund(10n ** 6n, ethers.getAddress(`0x${'b3'.repeat(20)}`), 1);
    await seller.ledger.recordServed({ ...call!, requestDigest: ethers.id('next'), subscriptionId: next, request: requestToWire({ ...requestFromWire(call!.request), subscriptionId: next }) });
    later(31);
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ sent: [expect.objectContaining({ items: 2 })], refused: 2, waiting: false });
    expect(seller.ledger.stateOf(ethers.id('forged'))).toBe('refused');
    expect(seller.ledger.stateOf(ethers.id('next'))).toBe('refused');

    const strict = await started({ maxFaultDrops: 0 });
    await strict.ledger.recordServed({ ...call!, requestDigest: ethers.id('forged again'), request: requestToWire({ ...forged, nonce: 8n }), signature: signServiceRequest(stranger.privateKey, domain, { ...forged, nonce: 8n }) });
    strict.lander.landNow();
    expect(await strict.lander.tick()).toEqual({ sent: [], refused: 0, waiting: false });
    expect(logs.join('\n')).toMatch(/a receipt batch was not sent/);
  });

  it('whose fate is not known waits; its wallet nonce passing resolves it by the nonces, and a revert puts it back', async () => {
    const seller = await started();
    await serve(seller, 2);
    later(31);
    const submit = vi.spyOn(chain, 'submitReceiptBatch').mockImplementationOnce(async (_groups, opts) => {
      await opts!.onBroadcast!({ txHash: ethers.id('lost'), nonce: 0, wallet: SELLER.address, signedTx: ethers.id('lost, signed') });
      throw new Error('timed out');
    });
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ sent: [], refused: 0, waiting: true });
    expect(await counts(seller)).toMatchObject({ sent: 2 });
    await seller.lander.resolve();
    expect(seller.ledger.pendingBatches()).toHaveLength(1);
    // The wallet's nonce passed it, and the receipts' nonces are clear: back to served, and sent again.
    vi.spyOn(chain, 'getMinedNonce').mockResolvedValue(1);
    await seller.lander.resolve();
    expect(await counts(seller)).toMatchObject({ served: 2 });

    submit.mockImplementationOnce(async (_groups, opts) => {
      await opts!.onBroadcast!({ txHash: ethers.id('reverted'), nonce: 1, wallet: SELLER.address, signedTx: ethers.id('reverted, signed') });
      throw Object.assign(new Error('reverted'), { receipt: { status: 0 } });
    });
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ sent: [], refused: 0, waiting: false });
    expect(await counts(seller)).toMatchObject({ served: 2 });
    seller.lander.landNow();
    expect(sent(await seller.lander.tick())).toEqual([2]);

    // A batch sent without a known nonce waits on its transaction alone, which turns out reverted.
    await serve(seller, 1, 2);
    later(31);
    submit.mockImplementationOnce(async (_groups, opts) => {
      await opts!.onBroadcast!({ txHash: ethers.id('no nonce'), wallet: SELLER.address, signedTx: ethers.id('no nonce, signed') });
      throw new Error('timed out');
    });
    seller.lander.landNow();
    expect(await seller.lander.tick()).toMatchObject({ waiting: true });
    vi.spyOn(chain, 'getMinedNonce').mockResolvedValue(99);
    await seller.lander.resolve();
    expect(seller.ledger.pendingBatches()).toMatchObject([{ nonce: null }]);
    vi.spyOn(chain, 'getReceiptBatchOutcome').mockResolvedValueOnce({ reverted: true });
    await seller.lander.resolve();
    expect(await counts(seller)).toMatchObject({ served: 1, landed: 2 });
  });

  it('reads a pending batch once more when its wallet nonce has passed it, so one mined in between lands with what it counted', async () => {
    const seller = await started();
    await serve(seller, 2);
    later(31);
    const real = chain.submitReceiptBatch.bind(chain);
    vi.spyOn(chain, 'submitReceiptBatch').mockImplementationOnce(async (groups, opts) => {
      await real(groups, opts);
      throw new Error('timed out');
    });
    seller.lander.landNow();
    expect(await seller.lander.tick()).toMatchObject({ waiting: true });
    // Not mined by the first read; mined by the time the wallet's nonce is read.
    vi.spyOn(chain, 'getReceiptBatchOutcome').mockResolvedValueOnce(null);
    await seller.lander.resolve();
    const { epoch } = await chain.getEpochTimes();
    expect(seller.ledger.epochReport(epoch)).toMatchObject({
      summary: { counts: { landed: 2, sent: 0 }, counted: '400' },
      batches: [{ state: 'landed', counted: '400' }],
    });
  });

  it('does not send a sped-up batch again as first signed: it was on the network', async () => {
    const seller = await started();
    await serve(seller, 1);
    later(31);
    vi.spyOn(chain, 'submitReceiptBatch').mockImplementationOnce(async (_groups, opts) => {
      await opts!.onBroadcast!({ txHash: ethers.id('stuck'), nonce: 0, wallet: SELLER.address, signedTx: ethers.id('stuck, signed') });
      await opts!.onBeforeReplacementBroadcast!({ txHash: ethers.id('faster'), nonce: 0, replacesTxHashes: [ethers.id('stuck')] });
      throw new Error('timed out');
    });
    seller.lander.landNow();
    expect(await seller.lander.tick()).toMatchObject({ waiting: true });
    const rebroadcast = vi.spyOn(chain, 'rebroadcastReceiptBatch');
    await seller.lander.resolve();
    expect(rebroadcast).not.toHaveBeenCalled();
    expect(seller.ledger.pendingBatches()).toMatchObject([{ hashes: [ethers.id('stuck'), ethers.id('faster')] }]);
  });

  it('is resolved by a speed-up that landed', async () => {
    const seller = await started();
    await serve(seller, 1);
    later(31);
    const real = chain.submitReceiptBatch.bind(chain);
    let landed = '';
    vi.spyOn(chain, 'submitReceiptBatch').mockImplementationOnce(async (groups, opts) => {
      const batch = await real(groups, { onBroadcast: async (s) => { await opts!.onBroadcast!({ ...s, txHash: ethers.id('stuck') }); } });
      await opts!.onBeforeReplacementBroadcast!({ txHash: batch.hash, nonce: 0, replacesTxHashes: [ethers.id('stuck')] });
      landed = batch.hash;
      throw new Error('timed out');
    });
    seller.lander.landNow();
    expect(await seller.lander.tick()).toMatchObject({ waiting: true });
    expect(seller.ledger.pendingBatches()[0]!.hashes).toEqual([ethers.id('stuck'), landed]);
    await seller.lander.resolve();
    expect(seller.ledger.epochReport((await chain.getEpochTimes()).epoch).batches).toMatchObject([{ state: 'landed', txHash: landed, items: 1, value: '200', counted: '200' }]);
  });
});

describe('after a crash, and at the epoch end', () => {
  it('a batch sent right before a crash is resolved at the next start, and nothing is sent again', async () => {
    const seller = await started();
    await serve(seller, 3);
    later(31);
    const real = chain.submitReceiptBatch.bind(chain);
    const submit = vi.spyOn(chain, 'submitReceiptBatch').mockImplementationOnce(async (groups, opts) => {
      await real(groups, opts);
      throw new Error('the node stopped');
    });
    seller.lander.landNow();
    expect(await seller.lander.tick()).toMatchObject({ waiting: true });

    submit.mockClear();
    const restarted = sellerWith();
    await restarted.load();
    await restarted.tick();
    restarted.lander.landNow();
    expect(await restarted.lander.tick()).toEqual({ stopped: 'nothing-ready' });
    expect(submit).not.toHaveBeenCalled();
    expect(await counts(restarted)).toMatchObject({ landed: 3, sent: 0 });
    expect(await chain.budgetUsed(subscriptionId, 0)).toBe(3n * CALL_VALUE);
  });

  it('sends a batch recorded but never broadcast again after a restart, as it was signed, and it lands once', async () => {
    const seller = await started();
    await serve(seller, 2);
    later(31);
    // The node stops right after the batch is recorded, before its transaction reaches the network. The wallet sends
    // nothing else, so its nonce stays at the batch's.
    const record = seller.ledger.recordSent.bind(seller.ledger);
    vi.spyOn(seller.ledger, 'recordSent').mockImplementationOnce(async (batch) => {
      await record(batch);
      throw new Error('the node stopped');
    });
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ sent: [], refused: 0, waiting: false });
    const [pending] = seller.ledger.pendingBatches();
    expect(pending).toMatchObject({ nonce: 0, signedTx: expect.stringMatching(/^0x/) });
    expect(await chain.getMinedNonce(SELLER.address)).toBe(0);

    const restarted = sellerWith();
    await restarted.load();
    const submit = vi.spyOn(chain, 'submitReceiptBatch');
    const rebroadcast = vi.spyOn(chain, 'rebroadcastReceiptBatch');
    // A send that fails is tried again at the next tick.
    rebroadcast.mockRejectedValueOnce(new Error('the endpoint is away')).mockRejectedValueOnce('the endpoint is still away');
    await restarted.lander.resolve();
    await restarted.lander.resolve();
    expect(logs.slice(-2)).toEqual([
      expect.stringMatching(/a receipt batch was not sent again: the endpoint is away/),
      expect.stringMatching(/a receipt batch was not sent again: the endpoint is still away/),
    ]);
    await restarted.tick();
    expect(rebroadcast).toHaveBeenLastCalledWith(pending!.signedTx);
    await restarted.lander.resolve();
    expect(submit).not.toHaveBeenCalled();
    expect(await counts(restarted)).toMatchObject({ landed: 2, sent: 0 });
    expect(restarted.ledger.batch(pending!.batchId)).toMatchObject({ state: 'landed', txHash: pending!.hashes[0] });
    expect(await chain.budgetUsed(subscriptionId, 0)).toBe(2n * CALL_VALUE);
    // Its nonce used, the same transaction sent once more is refused, and lands nothing.
    await expect(chain.rebroadcastReceiptBatch(pending!.signedTx!)).rejects.toThrow(/nonce too low/);
    expect(await chain.budgetUsed(subscriptionId, 0)).toBe(2n * CALL_VALUE);
  });

  it('leaves a batch recorded without its signed transaction, as records from before it was kept, to its nonce', async () => {
    const seller = await started();
    await serve(seller, 1);
    later(31);
    const record = seller.ledger.recordSent.bind(seller.ledger);
    vi.spyOn(seller.ledger, 'recordSent').mockImplementationOnce(async ({ signedTx: _signed, ...batch }) => {
      await record(batch);
      throw new Error('the node stopped');
    });
    seller.lander.landNow();
    await seller.lander.tick();
    const rebroadcast = vi.spyOn(chain, 'rebroadcastReceiptBatch');
    await seller.lander.resolve();
    expect(rebroadcast).not.toHaveBeenCalled();
    expect(seller.ledger.pendingBatches()).toHaveLength(1);
    // A transaction the chain did not sign cannot be sent again.
    await expect(chain.rebroadcastReceiptBatch('0x00')).rejects.toThrow(/not a receipt batch/);
  });

  it('misses what did not land, prunes the ended epoch to a summary, and reads it back', async () => {
    const seller = await started();
    await serve(seller, 3);
    later(31);
    seller.lander.landNow();
    await seller.lander.tick();
    await serve(seller, 2, 3);
    const { epoch } = await chain.getEpochTimes();
    mock.__advanceEpoch();
    at(60);
    await seller.lander.tick();
    const report = seller.ledger.epochReport(epoch);
    expect(report.summary).toEqual({
      epoch, counts: { served: 0, sent: 0, landed: 3, refused: 0, missed: 2 }, heldValue: '0', landedValue: '600', counted: '600',
    });
    expect(report.batches).toMatchObject([{ state: 'landed', items: 3, digests: [], value: '600', counted: '600' }]);
    expect(report.batches[0]!.gasUsed).toMatch(/^\d+$/);
    expect(seller.ledger.inState('missed')).toEqual([]);
    const lines = (await readFile(join(dir, 'seller-ledger.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['summary']);
    const reread = new SellerLedger(dir);
    await reread.load();
    expect(reread.epochReport(epoch)).toEqual(report);
  });
});

