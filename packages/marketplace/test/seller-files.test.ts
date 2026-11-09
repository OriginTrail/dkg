// SPDX-License-Identifier: Apache-2.0
/**
 * The seller's files when something went wrong with them, against
 * MockChainAdapter's marketplace: a prices file left empty or not prices (as
 * a power loss after a rename that was never synced can leave it), a ledger
 * journal that cannot be read, and one with entries that lack the shape of
 * their type, are each logged and kept aside, and the seller starts on safe
 * defaults; a journal it may not read stays where it is and fails the load.
 * The prices are on disk before they are renamed over the old ones.
 */
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  SERVICE_CLASS_INFERENCE,
  hashServiceRequest,
  marketplaceChainOf,
  signServiceRequest,
  type EpochTimes,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import {
  Journal,
  Seller,
  SellerLedger,
  requestToWire,
  serviceIdOf,
  type Connector,
} from '../src/index.js';

const SELLER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const SESSION = new ethers.Wallet(`0x${'33'.repeat(32)}`);
const BUYER = ethers.getAddress(`0x${'b1'.repeat(20)}`);
const MODEL = 'urn:test:model:files';
const A = serviceIdOf(MODEL);
const PRICE = 10n;
const BODY = { messages: [{ role: 'user' as const, content: 'synthetic question' }], max_tokens: 50 };

const backend: Connector = { kind: 'openai', complete: async () => ({ content: 'synthetic answer', promptTokens: 12, completionTokens: 8 }) };

let dir: string;
let chain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
let clock: number;
let logs: string[];

const pricesFile = () => join(dir, 'seller-prices.json');
const journalFile = () => join(dir, 'seller-ledger.jsonl');
const asideOf = async (name: string) => (await readdir(dir)).filter((f) => f.startsWith(`${name}.bad-`)).map((f) => join(dir, f));

function sellerWith(): Seller {
  return new Seller({
    chain, dir, signer: SELLER.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
    services: [{ model: MODEL, serviceId: A, pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed', connector: backend }],
    log: (m) => logs.push(m),
  });
}

async function started(): Promise<Seller> {
  const seller = sellerWith();
  await seller.load();
  await seller.tick();
  return seller;
}

async function fund(): Promise<string> {
  const { epoch } = await chain.getEpochTimes();
  await chain.approveServiceSubscriptionsWallet(10n ** 24n, { from: BUYER });
  const budgets = [{ serviceId: A, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 6n, maxPricePerUnit: 100n }];
  return (await chain.fundFromWallet({ epoch, sessionKey: SESSION.address, planDigest: ethers.ZeroHash, budgets }, { from: BUYER })).subscriptionId;
}

/** Serve one call on `subscriptionId`; its request digest. */
async function serveOne(seller: Seller, subscriptionId: string, nonce = 0n): Promise<string> {
  const { now } = await chain.getEpochTimes();
  const request: ServiceRequest = {
    subscriptionId, serviceId: A, seller: seller.gate.identityId, nonce, pricePerUnit: PRICE,
    maxUnits: 1_000n, maxValueWei: 10_000n, issuedAt: now, expiry: now + 600,
  };
  const answer = await seller.serve({ request: requestToWire(request), signature: signServiceRequest(SESSION.privateKey, domain, request), body: BODY }, 'buyer-peer');
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  return hashServiceRequest(domain, { ...request });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-seller-files-'));
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
  clock = 3_600;
  logs = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('a prices file', () => {
  it.each([
    ['empty', () => ''],
    ['not JSON', () => '{"0xab'],
    ['not prices', async () => JSON.stringify({ [A]: { [String((await chain.getEpochTimes()).epoch)]: 'ten' } })],
  ])('that is %s is kept aside and logged, and the price is frozen again from the settings', async (_kind, contents) => {
    const text = await contents();
    await writeFile(pricesFile(), text);
    const seller = await started();
    const [aside] = await asideOf('seller-prices.json');
    expect(await readFile(aside!, 'utf8')).toBe(text);
    expect(logs).toEqual([expect.stringMatching(/prices .* could not be read; it was moved to .*seller-prices\.json\.bad-/)]);
    expect((await seller.quote({ services: [A] })).offers).toMatchObject([{ pricePerUnit: String(PRICE) }]);
    const { epoch } = await chain.getEpochTimes();
    expect(JSON.parse(await readFile(pricesFile(), 'utf8'))).toEqual({ [A]: { [String(epoch)]: String(PRICE) } });
  });
});

describe("the ledger's journal", () => {
  it('that it may not read stays where it is and fails the load, so selling stays off until it reads', async () => {
    const seller = await started();
    const digest = await serveOne(seller, await fund());
    for (const code of ['EACCES', 'EPERM']) {
      const reads = vi.spyOn(Journal.prototype, 'read').mockRejectedValueOnce(Object.assign(new Error(`${code}: operation not permitted`), { code }));
      await expect(new SellerLedger(dir).load()).rejects.toThrow(code);
      reads.mockRestore();
    }
    expect(await asideOf('seller-ledger.jsonl')).toEqual([]);
    // Once it can read the journal again, the epoch's calls are all there.
    const reread = new SellerLedger(dir);
    await reread.load();
    expect(reread.stateOf(digest)).toBe('served');
  });

  it('that cannot be read is moved aside and logged, and the ledger starts empty in a new one', async () => {
    // A directory where the journal goes: reading it fails with EISDIR.
    await mkdir(journalFile());
    await writeFile(join(journalFile(), 'left behind'), 'x');
    const seller = await started();
    expect(await asideOf('seller-ledger.jsonl')).toHaveLength(1);
    expect(logs).toEqual([expect.stringMatching(/ledger .* could not be read .*; it was moved to .*seller-ledger\.jsonl\.bad-.*, and the ledger starts empty/)]);
    const digest = await serveOne(seller, await fund());
    const reread = new SellerLedger(dir);
    await reread.load();
    expect(reread.stateOf(digest)).toBe('served');
  });

  it('with entries that lack the shape of their type leaves them out, keeps a copy, and is written again without them', async () => {
    const seller = await started();
    const digest = await serveOne(seller, await fund());
    const good = await readFile(journalFile(), 'utf8');
    await appendFile(journalFile(), [
      JSON.stringify({ type: 'served', requestDigest: ethers.id('no request') }),
      JSON.stringify({ type: 'sent', batchId: 'b', epoch: 1, at: 1, hash: ethers.id('tx'), wallet: SELLER.address, nonce: null, digests: 'not a list' }),
      JSON.stringify({ type: 'sent', batchId: 'c', epoch: 1, at: 1, hash: ethers.id('tx'), wallet: SELLER.address, nonce: 0, digests: [], signedTx: 7 }),
      '',
    ].join('\n'));
    const restarted = sellerWith();
    await restarted.load();
    await restarted.tick();
    expect(restarted.ledger.stateOf(digest)).toBe('served');
    expect(restarted.ledger.pendingBatches()).toEqual([]);
    const [copy] = await asideOf('seller-ledger.jsonl');
    expect((await readFile(copy!, 'utf8')).trim().split('\n')).toHaveLength(4);
    expect(await readFile(journalFile(), 'utf8')).toBe(good);
    expect(logs).toEqual([expect.stringMatching(/3 entries of the seller's ledger .* left out; the journal as it was is at .*seller-ledger\.jsonl\.bad-/)]);
    // Landing goes on.
    clock += 31;
    restarted.lander.landNow();
    expect(await restarted.lander.tick()).toMatchObject({ sent: [{ items: 1 }], refused: 0 });
  });
});

describe('the prices file', () => {
  it('is on disk before it is renamed over the old one', async () => {
    const probe = await open(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
    await probe.close();
    const original = proto.sync;
    // What the prices file holds when each file is synced: the old prices, until the rename.
    const seen: string[] = [];
    vi.spyOn(proto, 'sync').mockImplementation(async function (this: unknown) {
      seen.push(await readFile(pricesFile(), 'utf8').catch(() => 'none'));
      return original.call(this);
    });
    const seller = await started();
    await seller.quote({ services: [A] });
    const frozen = await readFile(pricesFile(), 'utf8');
    seen.length = 0;
    await seller.setNextPrice(A, 20n);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(frozen);
    expect(await readFile(pricesFile(), 'utf8')).toMatch(/"20"/);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
