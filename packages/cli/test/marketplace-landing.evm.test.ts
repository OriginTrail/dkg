// SPDX-License-Identifier: Apache-2.0
/**
 * Landing on the evm-module's Hardhat chain, with time travel:
 * sellers in this process, on the EVM adapter as the daemon builds it, serve a
 * buyer's subscription from a stub backend and land its receipts.
 *   - landings at the interval, and at every tick of the last 20 minutes;
 *   - nothing sent in the last 30 seconds, and receipts missed after the end;
 *   - `NoNodeScore` until the node's first proof, then a landing;
 *   - two sellers over one budget: what lands first counts first;
 *   - a batch after the epoch's end refused with `OutsideEpoch`;
 *   - a crash right after a send sends nothing again;
 *   - the chain's bounds split a backlog of 300 receipts.
 * One snapshot per test, and the file's reverted at its end.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Contract, Wallet, ethers } from 'ethers';
import {
  EVMChainAdapter,
  SERVICE_CLASS_INFERENCE,
  enrichEvmError,
  marketplaceChainOf,
  receiptBatchFaultOf,
  signServiceRequest,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import {
  DEFAULT_LANDING,
  Seller,
  receiptItemOfCall,
  requestToWire,
  serviceIdOf,
  type Connector,
  type LandingReport,
  type LandingSettings,
} from '@origintrail-official/dkg-marketplace';
import { createProvider, getSharedContext, revertSnapshot, takeSnapshot } from '../../chain/test/evm-test-context.js';
import { HARDHAT_KEYS, makeAdapterConfig, mintTokens } from '../../chain/test/hardhat-harness.js';

const MODEL = 'urn:test:model:landing';
const SERVICE = serviceIdOf(MODEL);
const PRICE = 1_000n;
// An empty question: its input bound, 24 units, is under the smallest cap a case sets (25 units).
const BODY = { messages: [{ role: 'user' as const, content: '' }], max_tokens: 8 };
/** Each call: 6 units in and 4 out, 10,000 wei at the price. */
const backend: Connector = { kind: 'openai', complete: async () => ({ content: 'synthetic answer', promptTokens: 6, completionTokens: 4 }) };
// Hardhat's base fee is above the testnet ceilings; these tests take any.
const LANDING: LandingSettings = { ...DEFAULT_LANDING, baseFeeCeiling: 10n ** 15n, lastStretchBaseFeeCeiling: 10n ** 15n };

let fileSnapshot: string;
let testSnapshot: string;
let dirs: string[];
let buyerChain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
let session: ethers.HDNodeWallet;
let subscriptionId: string;

const provider = () => createProvider();
const chainOf = (key: string) => marketplaceChainOf(new EVMChainAdapter(makeAdapterConfig(getSharedContext().rpcUrl, getSharedContext().hubAddress, key)))!;
const sent = (report: LandingReport) => ('sent' in report ? report.sent.map((b) => b.items) : report);

async function travelTo(timestamp: number): Promise<void> {
  const latest = (await provider().getBlock('latest'))!.timestamp;
  if (timestamp > latest) await provider().send('evm_increaseTime', [timestamp - latest]);
  await provider().send('evm_mine', []);
}
const travelBy = async (seconds: number) => travelTo((await provider().getBlock('latest'))!.timestamp + seconds);

async function newDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mkt-landing-'));
  dirs.push(dir);
  return dir;
}

/** A seller as the daemon starts it: loaded, and through its first tick. */
async function sellerOf(key: string, opts: { landing?: Partial<LandingSettings>; dir?: string; chain?: MarketplaceChainAdapter } = {}): Promise<Seller> {
  const seller = new Seller({
    chain: opts.chain ?? chainOf(key), dir: opts.dir ?? await newDir(), signer: new Wallet(key).address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
    services: [{ model: MODEL, serviceId: SERVICE, pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed', connector: backend }],
    landing: { ...LANDING, ...opts.landing },
  });
  await seller.load();
  await seller.tick();
  return seller;
}

/** Serve `n` calls with nonces from `from`, each allowed `maxUnits`. */
async function serve(seller: Seller, n: number, from = 0, maxUnits = 100n): Promise<void> {
  await provider().send('evm_mine', []);
  const { now } = await buyerChain.getEpochTimes();
  for (let i = 0; i < n; i++) {
    const request: ServiceRequest = {
      subscriptionId, serviceId: SERVICE, seller: seller.gate.identityId, nonce: BigInt(from + i), pricePerUnit: PRICE,
      maxUnits, maxValueWei: maxUnits * PRICE, issuedAt: now, expiry: now + 600,
    };
    const answer = await seller.serve({ request: requestToWire(request), signature: signServiceRequest(session.privateKey, domain, request), body: BODY });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
  }
}

/** The node's first proof of the current epoch, as RandomSampling records it: the Hub owner stands in. */
async function giveScore(identityId: bigint): Promise<void> {
  const hub = new Contract(getSharedContext().hubAddress, ['function getContractAddress(string) view returns (address)'], provider());
  const rss = new Contract(await hub.getContractAddress('RandomSamplingStorage'), [
    'function addToNodeEpochScore(uint256 epoch, uint72 identityId, uint256 score)',
    'function addToAllNodesEpochScore(uint256 epoch, uint256 score)',
  ], new Wallet(HARDHAT_KEYS.DEPLOYER, provider()));
  const { epoch } = await buyerChain.getEpochTimes();
  await (await rss.addToNodeEpochScore(epoch, identityId, 10n ** 18n)).wait();
  await (await rss.addToAllNodesEpochScore(epoch, 10n ** 18n)).wait();
}

/** Fund this epoch for `key`'s wallet, with a new session key, and serve that subscription from now on. */
async function fund(key: string, value: bigint): Promise<void> {
  const chain = key === HARDHAT_KEYS.EXTRA1 ? buyerChain : chainOf(key);
  await mintTokens(provider(), getSharedContext().hubAddress, HARDHAT_KEYS.DEPLOYER, new Wallet(key).address, value);
  await chain.approveServiceSubscriptionsWallet(value);
  session = Wallet.createRandom();
  const { epoch } = await chain.getEpochTimes();
  ({ subscriptionId } = await chain.fundFromWallet({
    epoch, sessionKey: session.address, planDigest: ethers.ZeroHash,
    budgets: [{ serviceId: SERVICE, serviceClass: SERVICE_CLASS_INFERENCE, value, maxPricePerUnit: 10n ** 12n }],
  }));
}

describe('landing on Hardhat', () => {
  beforeAll(async () => {
    fileSnapshot = await takeSnapshot();
    buyerChain = chainOf(HARDHAT_KEYS.EXTRA1);
    domain = (await buyerChain.getMarketplaceContracts()).requestDomain;
  }, 120_000);
  afterAll(async () => { await revertSnapshot(fileSnapshot); });
  beforeEach(async () => {
    testSnapshot = await takeSnapshot();
    dirs = [];
    await fund(HARDHAT_KEYS.EXTRA1, 10n ** 21n);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await revertSnapshot(testSnapshot);
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('lands at the landing interval, and at every tick of the last stretch', async () => {
    const seller = await sellerOf(HARDHAT_KEYS.CORE_OP);
    await giveScore(seller.gate.identityId);
    const { startsAt, endsAt } = await buyerChain.getEpochTimes();
    const interval = LANDING.landingIntervalMinutes * 60;
    const nextLandingTime = async () => startsAt + (Math.floor(((await buyerChain.getEpochTimes()).now - startsAt) / interval) + 1) * interval;
    await travelTo(await nextLandingTime() + 1);
    await serve(seller, 3);
    await travelBy(31);
    expect(sent(await seller.lander.tick())).toEqual([3]);
    // Until the next landing time nothing is due; then it is.
    await serve(seller, 2, 3);
    await travelBy(31);
    expect(await seller.lander.tick()).toEqual({ stopped: 'not-due' });
    await travelTo(await nextLandingTime() + 1);
    expect(sent(await seller.lander.tick())).toEqual([2]);

    // The last 20 minutes: every tick.
    await travelTo(endsAt - 19 * 60);
    for (const nonce of [5, 6]) {
      await serve(seller, 1, nonce);
      await travelBy(31);
      expect(sent(await seller.lander.tick())).toEqual([1]);
    }
    const { epoch } = await buyerChain.getEpochTimes();
    expect(seller.ledger.epochReport(epoch).summary).toMatchObject({ counts: { landed: 7, served: 0 }, counted: String(7n * 10n * PRICE) });
    expect(await buyerChain.budgetUsed(subscriptionId, 0)).toBe(7n * 10n * PRICE);
  });

  it('sends nothing in the last 30 seconds, and misses what did not land once the epoch ends', async () => {
    const seller = await sellerOf(HARDHAT_KEYS.CORE_OP);
    await giveScore(seller.gate.identityId);
    const { epoch, endsAt } = await buyerChain.getEpochTimes();
    await travelTo(endsAt - 600);
    await serve(seller, 2);
    await travelTo(endsAt - 20);
    const wallet = new Wallet(HARDHAT_KEYS.CORE_OP).address;
    const nonce = await provider().getTransactionCount(wallet);
    expect(await seller.lander.tick()).toEqual({ stopped: 'end-margin' });
    expect(await provider().getTransactionCount(wallet)).toBe(nonce);
    await travelTo(endsAt + 10);
    await seller.lander.tick();
    expect(seller.ledger.epochReport(epoch).summary.counts).toMatchObject({ missed: 2, served: 0 });
  });

  it('waits for the node score: NoNodeScore until the first proof, then lands', async () => {
    const seller = await sellerOf(HARDHAT_KEYS.CORE_OP);
    await serve(seller, 2);
    await travelBy(31);
    seller.lander.landNow();
    expect(await seller.lander.tick()).toEqual({ stopped: 'no-node-score' });
    // The contract refuses the batch for the same reason.
    const items = seller.ledger.inState('served').map(receiptItemOfCall);
    const err = await chainOf(HARDHAT_KEYS.CORE_OP).submitReceiptBatch([{ subscriptionId, budgetIndex: 0, minCounted: 0n, items }]).catch((e: unknown) => e);
    expect(enrichEvmError(err)).toBe('NoNodeScore');
    await giveScore(seller.gate.identityId);
    // The retry the first tick left makes this one due.
    expect(sent(await seller.lander.tick())).toEqual([2]);
  });

  it('counts the receipts of two sellers over one budget in the order they landed', async () => {
    // A budget of 35,000 wei; each seller serves two calls of 10,000, each allowed 25,000.
    await fund(HARDHAT_KEYS.EXTRA2, 35_000n);
    const first = await sellerOf(HARDHAT_KEYS.CORE_OP);
    const second = await sellerOf(HARDHAT_KEYS.REC1_OP);
    expect(second.gate).toMatchObject({ open: true });
    await giveScore(first.gate.identityId);
    await giveScore(second.gate.identityId);
    await serve(first, 2, 0, 25n);
    await serve(second, 2, 0, 25n);
    await travelBy(31);
    second.lander.landNow();
    expect(await second.lander.tick()).toMatchObject({ sent: [{ items: 2, value: 20_000n, counted: 20_000n }] });
    first.lander.landNow();
    expect(await first.lander.tick()).toMatchObject({ sent: [{ items: 2, value: 20_000n, counted: 15_000n }] });
    expect(await buyerChain.budgetLeft(subscriptionId, 0)).toBe(0n);
  });

  it("refuses a batch after the epoch's end with OutsideEpoch, and misses its receipts", async () => {
    const seller = await sellerOf(HARDHAT_KEYS.CORE_OP);
    await giveScore(seller.gate.identityId);
    const { epoch, endsAt } = await buyerChain.getEpochTimes();
    await serve(seller, 2);
    await travelTo(endsAt + 60);
    // A score in the new epoch, so the batch is refused for its group, not for the node.
    await giveScore(seller.gate.identityId);
    const items = seller.ledger.inState('served').map(receiptItemOfCall);
    const err = await chainOf(HARDHAT_KEYS.CORE_OP).submitReceiptBatch([{ subscriptionId, budgetIndex: 0, minCounted: 0n, items }]).catch((e: unknown) => e);
    expect(receiptBatchFaultOf(err)).toEqual({ groupIndex: 0, itemIndex: null, fault: 'OutsideEpoch' });
    await seller.lander.tick();
    expect(seller.ledger.epochReport(epoch).summary.counts).toMatchObject({ missed: 2, served: 0 });
  });

  it('sends nothing again after a crash right after a send', async () => {
    const dir = await newDir();
    const crashing = chainOf(HARDHAT_KEYS.CORE_OP);
    const before = await sellerOf(HARDHAT_KEYS.CORE_OP, { dir, chain: crashing });
    await giveScore(before.gate.identityId);
    await serve(before, 3);
    await travelBy(31);
    // The process stops once the batch is sent and mined, before it learns so.
    const send = crashing.submitReceiptBatch.bind(crashing);
    vi.spyOn(crashing, 'submitReceiptBatch').mockImplementation(async (groups, opts) => {
      await send(groups, opts);
      throw new Error('the node stopped');
    });
    before.lander.landNow();
    expect(await before.lander.tick()).toEqual({ sent: [], refused: 0, waiting: true });
    expect(before.ledger.pendingBatches()).toHaveLength(1);

    const restarted = chainOf(HARDHAT_KEYS.CORE_OP);
    const sends = vi.spyOn(restarted, 'submitReceiptBatch');
    const after = await sellerOf(HARDHAT_KEYS.CORE_OP, { dir, chain: restarted });
    expect(after.ledger.pendingBatches()).toHaveLength(0);
    after.lander.landNow();
    expect(await after.lander.tick()).toEqual({ stopped: 'nothing-ready' });
    expect(sends).not.toHaveBeenCalled();
    const { epoch } = await buyerChain.getEpochTimes();
    expect(after.ledger.epochReport(epoch).summary.counts).toMatchObject({ landed: 3, sent: 0, served: 0 });
    expect(await buyerChain.budgetUsed(subscriptionId, 0)).toBe(3n * 10n * PRICE);
  });

  it("splits a backlog of 300 receipts by the chain's bounds", async () => {
    const seller = await sellerOf(HARDHAT_KEYS.CORE_OP);
    await giveScore(seller.gate.identityId);
    await serve(seller, 300);
    await travelBy(31);
    const { maxItems } = await buyerChain.batchState();
    expect(maxItems).toBeLessThan(300);
    seller.lander.landNow();
    const report = await seller.lander.tick();
    expect(sent(report)).toEqual([maxItems, 300 - maxItems]);
    expect('sent' in report && report.sent.every((b) => b.counted === b.value)).toBe(true);
    expect(await buyerChain.budgetUsed(subscriptionId, 0)).toBe(300n * 10n * PRICE);
  }, 300_000);
});
