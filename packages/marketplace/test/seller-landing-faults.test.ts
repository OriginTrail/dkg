// SPDX-License-Identifier: Apache-2.0
/**
 * Landing with one buyer's receipts faulting, against MockChainAdapter's
 * marketplace, on a clock the tests set: each group's faults are its own. A
 * group past `maxFaultDrops` in a tick waits for a later one, and the other
 * buyers' receipts land in the same tick, also when the faulting group would
 * fill every batch the tick may send.
 */
import { mkdtemp, rm } from 'node:fs/promises';
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
  requestFromWire,
  requestToWire,
  serviceIdOf,
  type Connector,
  type LandingReport,
  type LandingSettings,
} from '../src/index.js';

const SELLER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const SESSION = new ethers.Wallet(`0x${'33'.repeat(32)}`);
const STRANGER = new ethers.Wallet(`0x${'44'.repeat(32)}`);
const FAULTY = ethers.getAddress(`0x${'b1'.repeat(20)}`);
const HONEST = ethers.getAddress(`0x${'b2'.repeat(20)}`);
const MODEL = 'urn:test:model:landing-faults';
const A = serviceIdOf(MODEL);
const PRICE = 10n;
const BODY = { messages: [{ role: 'user' as const, content: 'synthetic question' }], max_tokens: 50 };
const HOUR = 3_600;

const backend: Connector = { kind: 'openai', complete: async () => ({ content: 'synthetic answer', promptTokens: 12, completionTokens: 8 }) };

let dir: string;
let chain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
let clock: number;

async function started(landing: Partial<LandingSettings> = {}): Promise<Seller> {
  const seller = new Seller({
    chain, dir, signer: SELLER.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
    services: [{ model: MODEL, serviceId: A, pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed', connector: backend }],
    landing: { ...DEFAULT_LANDING, ...landing },
    log: () => undefined,
  });
  await seller.load();
  await seller.tick();
  return seller;
}

async function fund(buyer: string): Promise<string> {
  const { epoch } = await chain.getEpochTimes();
  await chain.approveServiceSubscriptionsWallet(10n ** 24n, { from: buyer });
  const budgets = [{ serviceId: A, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 6n, maxPricePerUnit: 100n }];
  return (await chain.fundFromWallet({ epoch, sessionKey: SESSION.address, planDigest: ethers.ZeroHash, budgets }, { from: buyer })).subscriptionId;
}

async function serve(seller: Seller, subscriptionId: string, nonces: number[]): Promise<void> {
  const { now } = await chain.getEpochTimes();
  for (const nonce of nonces) {
    const request: ServiceRequest = {
      subscriptionId, serviceId: A, seller: seller.gate.identityId, nonce: BigInt(nonce), pricePerUnit: PRICE,
      maxUnits: 1_000n, maxValueWei: 10_000n, issuedAt: now, expiry: now + 600,
    };
    const answer = await seller.serve({ request: requestToWire(request), signature: signServiceRequest(SESSION.privateKey, domain, request), body: BODY }, 'buyer-peer');
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
  }
}

/** `count` receipts on the faulty buyer's subscription whose requests another key signed: each faults `BadSignature`. */
async function forge(seller: Seller, subscriptionId: string, count: number): Promise<void> {
  const [template] = seller.ledger.inState('served').filter((c) => c.subscriptionId === subscriptionId);
  for (let i = 0; i < count; i++) {
    const request = { ...requestFromWire(template!.request), nonce: BigInt(100 + i) };
    await seller.ledger.recordServed({
      ...template!, requestDigest: ethers.id(`forged ${i}`), request: requestToWire(request), signature: signServiceRequest(STRANGER.privateKey, domain, request),
    });
  }
}

const statesOf = (seller: Seller, subscriptionId: string) => {
  const states: Record<string, number> = {};
  for (const state of ['served', 'sent', 'landed', 'refused', 'missed'] as const) {
    states[state] = seller.ledger.inState(state).filter((c) => c.subscriptionId === subscriptionId).length;
  }
  return states;
};
const items = (report: LandingReport) => ('sent' in report ? report.sent.map((b) => b.items) : report);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-landing-faults-'));
  const mock = new MockChainAdapter('mock:31337', SELLER.address);
  mock.setMockACKSigner(SELLER);
  await mock.ensureProfile();
  chain = marketplaceChainOf(mock)!;
  const real = chain.getEpochTimes.bind(chain);
  vi.spyOn(chain, 'getEpochTimes').mockImplementation(async (): Promise<EpochTimes> => {
    const t = await real();
    return { ...t, now: t.startsAt + clock };
  });
  domain = (await chain.getMarketplaceContracts()).requestDomain;
  clock = HOUR;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("one buyer's faulting receipts", () => {
  it("do not hold back another buyer's: past its drops a group waits, and the rest of the batch lands", async () => {
    const faulty = await fund(FAULTY);
    const honest = await fund(HONEST);
    const seller = await started();
    // The faulty buyer's receipts are the oldest, so they come first: one of its own, and twelve that fault.
    await serve(seller, faulty, [0]);
    await forge(seller, faulty, 12);
    clock += 60;
    await serve(seller, honest, [0, 1]);
    clock += 31;
    seller.lander.landNow();
    const first = await seller.lander.tick();
    expect(first).toMatchObject({ refused: DEFAULT_LANDING.maxFaultDrops, waiting: false });
    expect(items(first)).toEqual([2]);
    expect(statesOf(seller, honest)).toMatchObject({ landed: 2, served: 0 });
    expect(statesOf(seller, faulty)).toMatchObject({ refused: 8, served: 5, landed: 0 });

    // A later tick drops the rest of its faults, and its own receipt lands.
    seller.lander.landNow();
    const second = await seller.lander.tick();
    expect(second).toMatchObject({ refused: 4 });
    expect(items(second)).toEqual([1]);
    expect(statesOf(seller, faulty)).toMatchObject({ refused: 12, served: 0, landed: 1 });
  });

  it("do not take the tick's batches when the faulting group would fill them all", async () => {
    vi.spyOn(chain, 'batchState').mockResolvedValue({ activationEpoch: 1, paused: false, maxGroups: 32, maxItems: 4 });
    const faulty = await fund(FAULTY);
    const honest = await fund(HONEST);
    const seller = await started({ maxFaultDrops: 2, maxBatchesPerTick: 3 });
    await serve(seller, faulty, [0]);
    await forge(seller, faulty, 20);
    clock += 60;
    await serve(seller, honest, [0, 1, 2, 3, 4]);
    clock += 31;
    seller.lander.landNow();
    const report = await seller.lander.tick();
    expect(report).toMatchObject({ refused: 2, waiting: false });
    expect(items(report)).toEqual([4, 1]);
    expect(statesOf(seller, honest)).toMatchObject({ landed: 5, served: 0 });
    expect(statesOf(seller, faulty)).toMatchObject({ refused: 2, served: 19 });
  });
});
