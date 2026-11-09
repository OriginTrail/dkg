// SPDX-License-Identifier: Apache-2.0
/**
 * The seller's offer job (offer-job.ts) against MockChainAdapter, with the
 * offers' assets in memory in place of Verifiable Memory: one asset per
 * service, published once and updated only when its signed terms change (a
 * price included, and the epoch turning only when the schedule no longer
 * holds), nothing sent after a restart, an unchanged offer signed again when
 * the node's signing wallet changes, an asset extended with two epochs or
 * fewer left and paid for once when the publish after it fails, a withdrawal,
 * a seller without TRAC left unlisted with the reason and a backoff, a
 * confirmed publish whose catalog record is owed, what was published kept by
 * graph and read back checked, and the job's runs beside the landing tick.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, marketplaceChainOf, type MarketplaceChainAdapter, type MarketplaceDomain } from '@origintrail-official/dkg-chain';
import {
  MARKETPLACE_NS,
  MAX_OFFER_BACKOFF_SECONDS,
  Router,
  Seller,
  TERM_EPOCHS,
  listingProblemOf,
  offeringView,
  serviceIdOf,
  serviceOfferSignerOf,
  serviceOffersFromBindings,
  type OfferAssets,
  type OfferQuad,
  type SellerService,
  type ServiceOffer,
} from '../src/index.js';

const SELLER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const MODEL_A = 'urn:test:model:offer-a';
const MODEL_B = 'urn:test:model:offer-b';
const A = serviceIdOf(MODEL_A);
const B = serviceIdOf(MODEL_B);
const PRICE = 10n;
const EVIDENCE = { version: 1, transactionHash: `0x${'77'.repeat(32)}` };
const GRAPH = 'test-marketplace';
const OTHER_GRAPH = 'test-marketplace-2';
/** Where the job keeps what it published. */
const FILE = 'seller-offers-by-graph.json';

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
let logs: string[];
let assets: Assets;

/** Offers' assets in memory: what each publish was given, as a buyer would read it, and the id its name keeps. */
interface Assets extends OfferAssets {
  published: Array<{ name: string; offer: ServiceOffer; kaId: bigint }>;
  attempts: number;
  recovered: unknown[];
  /** An error to throw for a publish of `name`, or none. */
  fail?: (name: string) => unknown;
}

function offerIn(quads: OfferQuad[]): ServiceOffer {
  const row: Record<string, string> = {};
  for (const q of quads) if (q.predicate.startsWith(MARKETPLACE_NS)) row[q.predicate.slice(MARKETPLACE_NS.length)] = q.object;
  return serviceOffersFromBindings([row])[0]!;
}

/** Register `kaId` on the mock chain as a new asset stored for the term from now. */
async function onChain(kaId: bigint): Promise<void> {
  const { epoch } = await chain.getEpochTimes();
  mock.__registerKC({ kaId, contextGraphId: 1n, merkleRootHex: ethers.ZeroHash, chunks: [], byteSize: 1_024n, startEpoch: BigInt(epoch), endEpoch: BigInt(epoch + TERM_EPOCHS), tokenAmount: 1n });
}

/** A graph's assets in memory; the ids of another graph's start after `firstKaId`, so no two graphs share one. */
function memoryAssets(contextGraphId = GRAPH, firstKaId = 1): Assets {
  const ids = new Map<string, bigint>();
  const a: Assets = {
    contextGraphId,
    published: [],
    attempts: 0,
    recovered: [],
    async publish(name, quads) {
      a.attempts++;
      const failure = a.fail?.(name);
      if (failure) throw failure;
      let kaId = ids.get(name);
      if (kaId === undefined) {
        ids.set(name, kaId = BigInt(firstKaId + ids.size));
        await onChain(kaId);
      }
      a.published.push({ name, offer: offerIn(quads), kaId });
      return { kaId };
    },
    async recover(evidence) { a.recovered.push(evidence); },
  };
  return a;
}

const connector = { kind: 'openai' as const, complete: async () => ({ content: 'synthetic answer', promptTokens: 1, completionTokens: 1 }) };
const serviceOf = (model: string): SellerService => ({ model, serviceId: serviceIdOf(model), pricePerUnit: PRICE, capacity: 4, provenance: 'upstream-claimed', connector });

function sellerWith(services: SellerService[] = [serviceOf(MODEL_A), serviceOf(MODEL_B)], offers: OfferAssets = assets, signer = SELLER.address): Seller {
  return new Seller({ chain, dir, services, signer, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300, offers, log: (m) => logs.push(m) });
}

/** A tick, then a run of the offer job once the tick's own run is done. */
async function settle(seller: Seller): Promise<void> {
  await seller.tick();
  await seller.offers!.run();
}

/** How far the tests moved the chain's clock on, in seconds; it stands still otherwise. */
let ahead: number;

/** Move the chain's clock `seconds` on within the epoch. */
function later(seconds: number): void {
  ahead += seconds;
}

const offersOf = (serviceId: string) => assets.published.filter((p) => p.name === `offer-${serviceId}`).map((p) => p.offer);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-offers-'));
  mock = new MockChainAdapter('mock:31337', SELLER.address);
  mock.setMockACKSigner(SELLER);
  await mock.ensureProfile();
  chain = marketplaceChainOf(mock)!;
  domain = (await chain.getMarketplaceContracts()).requestDomain;
  logs = [];
  assets = memoryAssets();
  // The mock's clock is this host's, frozen here, so a second turning mid-test moves no time the tests compare.
  ahead = 0;
  const frozen = (await chain.getEpochTimes()).now;
  const real = chain.getEpochTimes.bind(chain);
  vi.spyOn(chain, 'getEpochTimes').mockImplementation(async () => {
    const t = await real();
    return { ...t, now: Math.max(frozen + ahead, t.startsAt) };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the offer job', () => {
  it('publishes one asset per service, signed and naming its peer, valid for its term, and nothing more while nothing changes or after a restart', async () => {
    const seller = sellerWith([serviceOf(MODEL_A), { ...serviceOf(MODEL_B), tokenizerBundle: 'test-bundle' }]);
    await seller.load();
    await settle(seller);
    const { epoch, now } = await chain.getEpochTimes();
    expect(assets.published.map((p) => p.name).sort()).toEqual([`offer-${A}`, `offer-${B}`].sort());
    expect(offersOf(B)[0]!.tokenizerBundle).toBe('test-bundle');
    for (const { offer } of assets.published) {
      expect(offer).toMatchObject({
        seller: seller.gate.identityId, unit: 'token', capacity: 4, provenance: 'upstream-claimed', peerId: 'seller-peer',
        pricePerUnit: PRICE, priceEpoch: epoch, validUntilEpoch: epoch + TERM_EPOCHS, withdrawn: false,
      });
      expect(offer).not.toHaveProperty('nextPricePerUnit');
      expect(offer.signedAt).toBeGreaterThanOrEqual(now);
      expect(serviceOfferSignerOf(domain, offer)).toBe(SELLER.address);
    }
    expect(seller.offers!.listingOf(A, epoch)).toEqual({ listed: true, kaId: String(assets.published.find((p) => p.name === `offer-${A}`)!.kaId), validUntilEpoch: epoch + TERM_EPOCHS, withdrawn: false });
    expect((await offeringView(seller, A)).listing).toMatchObject({ listed: true });
    await settle(seller);
    // A restart reads what was published, and sends nothing.
    const restarted = sellerWith([serviceOf(MODEL_A), { ...serviceOf(MODEL_B), tokenizerBundle: 'test-bundle' }]);
    await restarted.load();
    await settle(restarted);
    expect(assets.published).toHaveLength(2);
    expect(restarted.offers!.listingOf(B, epoch)).toMatchObject({ listed: true });
    expect(logs.filter((m) => /published the offer/.test(m))).toHaveLength(2);
  });

  it('updates the same asset when a price changes, signed later each time, and keeps its schedule across the epoch turn while it holds', async () => {
    const seller = sellerWith();
    await seller.load();
    await settle(seller);
    const { epoch } = await chain.getEpochTimes();
    await seller.setNextPrice(A, 30n);
    await settle(seller);
    await seller.setNextPrice(A, PRICE);
    await settle(seller);
    await seller.setNextPrice(A, 30n);
    await settle(seller);
    expect(offersOf(A).map((o) => [o.pricePerUnit, o.nextPricePerUnit])).toEqual([[PRICE, undefined], [PRICE, 30n], [PRICE, undefined], [PRICE, 30n]]);
    expect(new Set(assets.published.filter((p) => p.name === `offer-${A}`).map((p) => p.kaId)).size).toBe(1);
    expect(offersOf(A).map((o) => o.signedAt)).toEqual(offersOf(A).map((o) => o.signedAt).sort((x, y) => x - y));
    expect(new Set(offersOf(A).map((o) => o.signedAt)).size).toBe(4);
    expect(offersOf(B)).toHaveLength(1);

    // The next epoch: A's 30 holds now, and the epoch after goes back to the settings' price; B's schedule still holds.
    mock.__advanceEpoch();
    await settle(seller);
    expect(offersOf(A).at(-1)).toMatchObject({ pricePerUnit: 30n, priceEpoch: epoch + 1, nextPricePerUnit: PRICE });
    expect(offersOf(B)).toHaveLength(1);
    await settle(seller);
    expect(assets.published).toHaveLength(6);
  });

  it('extends an asset with two epochs or fewer left, and publishes its new last epoch', async () => {
    const seller = sellerWith();
    await seller.load();
    await settle(seller);
    const { epoch } = await chain.getEpochTimes();
    const extensions = vi.spyOn(chain, 'extendKnowledgeAssetLifetime');
    for (let i = 0; i < TERM_EPOCHS - 3; i++) mock.__advanceEpoch();
    await settle(seller);
    expect(extensions).not.toHaveBeenCalled();
    mock.__advanceEpoch();
    await settle(seller);
    expect(extensions.mock.calls.map(([, epochs]) => epochs)).toEqual([TERM_EPOCHS, TERM_EPOCHS]);
    expect(assets.published.slice(2).map((p) => p.offer.validUntilEpoch)).toEqual([epoch + 2 * TERM_EPOCHS, epoch + 2 * TERM_EPOCHS]);
    expect(logs).toContainEqual(expect.stringMatching(new RegExp(`stored through epoch ${epoch + 2 * TERM_EPOCHS}`)));
    await settle(seller);
    expect(extensions).toHaveBeenCalledTimes(2);
  });

  it("signs an unchanged offer again when the node's signing wallet changes, so a buyer keeps it once the old wallet is retired", async () => {
    const seller = sellerWith([serviceOf(MODEL_A)]);
    await seller.load();
    await settle(seller);
    const { epoch } = await chain.getEpochTimes();
    const identityId = seller.gate.identityId;
    // The node now signs with wallet B, an operational wallet of the same identity; its terms are unchanged.
    const rotated = new ethers.Wallet(`0x${'33'.repeat(32)}`);
    mock.seedIdentity(rotated.address, identityId);
    mock.setMockACKSigner(rotated);
    const restarted = sellerWith([serviceOf(MODEL_A)], assets, rotated.address);
    await restarted.load();
    await settle(restarted);
    expect(offersOf(A).map((o) => serviceOfferSignerOf(domain, o))).toEqual([SELLER.address, rotated.address]);
    const { signedAt: _signedAt, signature: _signature, ...terms } = offersOf(A)[0]!;
    expect(offersOf(A)[1]).toMatchObject(terms);
    expect(new Set(assets.published.map((p) => p.kaId)).size).toBe(1);
    // A buyer that sees the old wallet retired keeps the offer the new one signed.
    const wallets = new Map([[rotated.address, identityId]]);
    const router = new Router({
      chain: {
        getMarketplaceContracts: () => chain.getMarketplaceContracts(),
        getIdentityIdForAddress: async (wallet: string) => wallets.get(ethers.getAddress(wallet)) ?? 0n,
        isShardingTableMember: async () => true,
      },
      offers: async () => assets.published.map((p) => p.offer),
      quote: async () => { throw new Error('no quote is asked for'); },
    });
    expect((await router.offersOf([epoch])).map((o) => o.signature)).toEqual([offersOf(A)[1]!.signature]);
    // Signed by the node's wallet, the unchanged offer is not sent again, after a restart either.
    await settle(restarted);
    const again = sellerWith([serviceOf(MODEL_A)], assets, rotated.address);
    await again.load();
    await settle(again);
    expect(offersOf(A)).toHaveLength(2);
  });

  it('pays for an extension once: when the publish after it fails, a restart publishes the new last epoch and pays nothing more', async () => {
    const seller = sellerWith([serviceOf(MODEL_A)]);
    await seller.load();
    await settle(seller);
    const { epoch } = await chain.getEpochTimes();
    const kaId = assets.published[0]!.kaId;
    const extensions = vi.spyOn(chain, 'extendKnowledgeAssetLifetime');
    for (let i = 0; i < TERM_EPOCHS - 2; i++) mock.__advanceEpoch();
    assets.fail = () => Object.assign(new Error('collected 0/3'), { name: 'QuorumUnmetError' });
    await settle(seller);
    // Paid on chain, the offer not published: the asset is stored through its new last epoch, the offer still names the old one.
    expect(extensions).toHaveBeenCalledTimes(1);
    expect((await chain.getKnowledgeAssetUpdateContext(kaId)).endEpoch).toBe(BigInt(epoch + 2 * TERM_EPOCHS));
    expect(offersOf(A).map((o) => o.validUntilEpoch)).toEqual([epoch + TERM_EPOCHS]);
    expect(seller.offers!.listingOf(A, epoch + TERM_EPOCHS - 2)).toMatchObject({ listed: true, validUntilEpoch: epoch + TERM_EPOCHS, problem: 'no-ack-quorum' });
    // The restart reads the asset's end epoch from the chain, not from what it kept, and publishes it without paying again.
    assets.fail = undefined;
    const restarted = sellerWith([serviceOf(MODEL_A)]);
    await restarted.load();
    await settle(restarted);
    expect(extensions).toHaveBeenCalledTimes(1);
    expect(assets.published.map((p) => [p.kaId, p.offer.validUntilEpoch])).toEqual([[kaId, epoch + TERM_EPOCHS], [kaId, epoch + 2 * TERM_EPOCHS]]);
    expect(restarted.offers!.listingOf(A, epoch + TERM_EPOCHS - 2)).toEqual({ listed: true, kaId: String(kaId), validUntilEpoch: epoch + 2 * TERM_EPOCHS, withdrawn: false });
    await settle(restarted);
    expect(extensions).toHaveBeenCalledTimes(1);
    expect(assets.published).toHaveLength(2);
  });

  it('withdraws a service the settings no longer name, once, keeping its terms, and extends it no more', async () => {
    const seller = sellerWith();
    await seller.load();
    await settle(seller);
    const { epoch } = await chain.getEpochTimes();
    const narrowed = sellerWith([serviceOf(MODEL_A)]);
    await narrowed.load();
    await settle(narrowed);
    expect(offersOf(B)).toHaveLength(2);
    expect(offersOf(B)[1]).toMatchObject({ ...offersOf(B)[0], withdrawn: true, signedAt: expect.any(Number), signature: expect.any(String) });
    expect(narrowed.offers!.listingOf(B, epoch)).toMatchObject({ listed: false, withdrawn: true });
    await settle(narrowed);
    expect(offersOf(B)).toHaveLength(2);
    const extensions = vi.spyOn(chain, 'extendKnowledgeAssetLifetime');
    for (let i = 0; i < TERM_EPOCHS - 2; i++) mock.__advanceEpoch();
    await settle(narrowed);
    expect(extensions.mock.calls.map(([kaId]) => kaId)).toEqual([assets.published[0]!.name === `offer-${A}` ? assets.published[0]!.kaId : assets.published[1]!.kaId]);
    expect(offersOf(B)).toHaveLength(2);
    // Past its last epoch there is nothing left to withdraw.
    for (let i = 0; i < 3; i++) mock.__advanceEpoch();
    await settle(narrowed);
    expect(offersOf(B)).toHaveLength(2);
  });

  it('stays unlisted without TRAC, says why, and tries again after a backoff that doubles', async () => {
    const seller = sellerWith([serviceOf(MODEL_A)]);
    await seller.load();
    const broke = Object.assign(new Error('No operational wallet has enough funds to publish'), { name: 'InsufficientPublisherFundsError', code: 'NO_FUNDED_PUBLISHER_WALLET' });
    assets.fail = () => broke;
    await settle(seller);
    const { epoch, now } = await chain.getEpochTimes();
    expect(seller.offers!.listingOf(A, epoch)).toEqual({ listed: false, problem: 'no-trac', message: broke.message, retryAt: now + 300 });
    expect(assets.attempts).toBe(1);
    await settle(seller);
    expect(assets.attempts).toBe(1);
    later(300);
    await settle(seller);
    expect(assets.attempts).toBe(2);
    expect(seller.offers!.listingOf(A, epoch).retryAt).toBe(now + 300 + 600);
    expect(logs.filter((m) => /not kept \(no-trac\), tried again in 300 s/.test(m))).toHaveLength(1);
    // Asked to run now, as when the graph admits the node: the backoff goes.
    assets.fail = undefined;
    seller.offers!.poke(true);
    await seller.offers!.run();
    expect(assets.published).toHaveLength(1);
    expect(seller.offers!.listingOf(A, epoch)).toMatchObject({ listed: true });
    expect(seller.offers!.listingOf(A, epoch)).not.toHaveProperty('problem');
  });

  it('waits at most an hour between tries', async () => {
    const seller = sellerWith([serviceOf(MODEL_A)]);
    await seller.load();
    assets.fail = () => Object.assign(new Error('collected 0/3'), { name: 'QuorumUnmetError' });
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await settle(seller);
      const { epoch, now } = await chain.getEpochTimes();
      const listing = seller.offers!.listingOf(A, epoch);
      expect(listing.problem).toBe('no-ack-quorum');
      waits.push(listing.retryAt! - now);
      later(listing.retryAt! - now);
    }
    expect(waits).toEqual([300, 600, 1_200, 2_400, MAX_OFFER_BACKOFF_SECONDS, MAX_OFFER_BACKOFF_SECONDS]);
    // Something thrown that is not an error is shown as it is.
    assets.fail = () => 'the graph is away';
    seller.offers!.poke(true);
    await seller.offers!.run();
    const { epoch } = await chain.getEpochTimes();
    expect(seller.offers!.listingOf(A, epoch)).toMatchObject({ problem: 'error', message: 'the graph is away' });
  });

  it('keeps a publish confirmed while its catalog record was not, finishes it from its evidence, and never publishes it again', async () => {
    const seller = sellerWith();
    await seller.load();
    assets.fail = (name) => {
      if (name !== `offer-${A}`) return undefined;
      assets.fail = undefined;
      void onChain(77n);
      return Object.assign(new Error('Confirmed publication catalog obligation was not durably recorded'), {
        code: 'CONFIRMED_CATALOG_OBLIGATION_PENDING', transaction: { batchId: 77n }, recoveryEvidence: EVIDENCE,
      });
    };
    await settle(seller);
    const { epoch } = await chain.getEpochTimes();
    expect(seller.offers!.listingOf(A, epoch)).toMatchObject({ listed: false, kaId: '77', problem: 'catalog-pending' });
    expect(offersOf(A)).toEqual([]);
    // A restart keeps it pending.
    const restarted = sellerWith();
    await restarted.load();
    later(300);
    await settle(restarted);
    expect(assets.recovered).toEqual([EVIDENCE]);
    expect(offersOf(A)).toEqual([]);
    expect(restarted.offers!.listingOf(A, epoch)).toMatchObject({ listed: true, kaId: '77' });
    expect(logs).toContainEqual(expect.stringMatching(/is on chain and its catalog record kept/));
    await settle(restarted);
    expect(assets.recovered).toHaveLength(1);
  });

  it('publishes again a confirmed publish whose error carries no evidence to finish it from', async () => {
    const seller = sellerWith([serviceOf(MODEL_A)]);
    await seller.load();
    assets.fail = () => {
      assets.fail = undefined;
      return Object.assign(new Error('pending'), { code: 'CONFIRMED_CATALOG_OBLIGATION_PENDING', transaction: { kaId: 5n } });
    };
    await settle(seller);
    const { epoch } = await chain.getEpochTimes();
    expect(seller.offers!.listingOf(A, epoch)).toEqual({ listed: false, problem: 'catalog-pending', message: 'pending', retryAt: expect.any(Number) });
    seller.offers!.poke(true);
    await seller.offers!.run();
    expect(offersOf(A)).toHaveLength(1);
  });

  it('leaves its offers alone while it is not a Core Node, and says so; an asset that expired is left as it is', async () => {
    vi.spyOn(chain, 'isShardingTableMember').mockResolvedValueOnce(false);
    const seller = sellerWith();
    await seller.load();
    await settle(seller);
    const { epoch } = await chain.getEpochTimes();
    expect(assets.attempts).toBe(0);
    expect(seller.offers!.listingOf(A, epoch)).toEqual({ listed: false, problem: 'not-core-node' });
    await settle(seller);
    expect(assets.published).toHaveLength(2);
    for (let i = 0; i <= TERM_EPOCHS; i++) mock.__advanceEpoch();
    await settle(seller);
    expect(seller.offers!.listingOf(A, epoch + TERM_EPOCHS + 1)).toMatchObject({ listed: false, problem: 'expired', message: expect.stringMatching(/expired after epoch/) });
    expect(assets.published).toHaveLength(2);
    // Dropped from the settings once expired: nothing is left to withdraw.
    const narrowed = sellerWith([serviceOf(MODEL_A)]);
    await narrowed.load();
    await settle(narrowed);
    expect(assets.published).toHaveLength(2);
    expect(narrowed.offers!.listingOf(B, epoch + TERM_EPOCHS + 1)).toEqual({ listed: false, kaId: expect.any(String), validUntilEpoch: epoch + TERM_EPOCHS, withdrawn: false });
  });

  it('runs beside the landing tick: a slow publish holds no tick, a run asked for meanwhile follows it, and stop waits for it', async () => {
    let release!: () => void;
    let held = new Promise<void>((resolve) => { release = resolve; });
    const slow = memoryAssets();
    const publish = slow.publish.bind(slow);
    slow.publish = async (name, quads) => {
      await held;
      return publish(name, quads);
    };
    const seller = sellerWith([serviceOf(MODEL_A)], slow);
    await seller.load();
    expect(await seller.tick()).toBeGreaterThan(0);
    expect(slow.published).toEqual([]);
    await seller.setNextPrice(A, 30n);
    seller.offers!.poke();
    release();
    await vi.waitFor(() => expect(slow.published.map((p) => p.offer.nextPricePerUnit)).toEqual([undefined, 30n]));
    // A run in progress at stop is waited for, and none follows it.
    held = new Promise<void>((resolve) => { release = resolve; });
    await seller.setNextPrice(A, 40n);
    seller.offers!.poke();
    seller.offers!.poke();
    let stopped = false;
    const stopping = seller.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(slow.published).toHaveLength(3);
    seller.offers!.poke();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slow.published).toHaveLength(3);
  });

  it('logs a run that fails as a whole, and refuses to start on a record it cannot read', async () => {
    const seller = sellerWith();
    await seller.load();
    vi.spyOn(chain, 'getEpochTimes').mockRejectedValueOnce(new Error('socket hang up'));
    seller.offers!.poke();
    await vi.waitFor(() => expect(logs).toContainEqual(expect.stringMatching(/offers were not kept: socket hang up/)));
    await mkdir(join(dir, FILE));
    await expect(sellerWith().load()).rejects.toThrow();
  });

  it('keeps what it published by graph: the same graph after a restart sends nothing, and another graph gets offers of its own', async () => {
    const seller = sellerWith([serviceOf(MODEL_A)]);
    await seller.load();
    await settle(seller);
    const { epoch } = await chain.getEpochTimes();
    const restarted = sellerWith([serviceOf(MODEL_A)]);
    await restarted.load();
    await settle(restarted);
    expect(assets.published).toHaveLength(1);
    // The settings name another graph: the offer is published there as an asset of its own, its terms unchanged.
    const other = memoryAssets(OTHER_GRAPH, 101);
    const moved = sellerWith([serviceOf(MODEL_A)], other);
    await moved.load();
    await settle(moved);
    expect(other.published.map((p) => [p.name, p.kaId])).toEqual([[`offer-${A}`, 101n]]);
    expect(moved.offers!.listingOf(A, epoch)).toMatchObject({ listed: true, kaId: '101' });
    // Back to the first graph: what was published there is kept, and nothing is sent again.
    const back = sellerWith([serviceOf(MODEL_A)]);
    await back.load();
    await settle(back);
    expect([assets.published.length, other.published.length]).toEqual([1, 1]);
    expect(back.offers!.listingOf(A, epoch)).toMatchObject({ listed: true, kaId: String(assets.published[0]!.kaId) });
    const kept = JSON.parse(await readFile(join(dir, FILE), 'utf8'));
    expect(Object.keys(kept).sort()).toEqual([GRAPH, OTHER_GRAPH].sort());
    expect(kept[OTHER_GRAPH][A].kaId).toBe('101');
  });

  it("reads back only records that hold an asset id and its offer as published, and fails the load on any other; other graphs' are kept as they are", async () => {
    const seller = sellerWith([serviceOf(MODEL_A)]);
    await seller.load();
    await settle(seller);
    const file = join(dir, FILE);
    const kept = JSON.parse(await readFile(file, 'utf8'));
    // Another graph's entry is not read, and is written back as it was; the file kept before offers were kept by graph is not read.
    await writeFile(file, JSON.stringify({ ...kept, [OTHER_GRAPH]: 'not read' }));
    await writeFile(join(dir, 'seller-offers.json'), 'not read');
    const restarted = sellerWith();
    await restarted.load();
    await settle(restarted);
    expect([offersOf(A).length, offersOf(B).length]).toEqual([1, 1]);
    expect(JSON.parse(await readFile(file, 'utf8'))[OTHER_GRAPH]).toBe('not read');
    const record = kept[GRAPH][A];
    const broken: Array<[unknown, RegExp]> = [
      ['not json', /JSON/],
      ['[]', /holds no offers by graph/],
      [{ [GRAPH]: [] }, /in "test-marketplace", holds no offers by service/],
      [{ [GRAPH]: { [A]: 'a record' } }, /holds no published offer for/],
      [{ [GRAPH]: { [A]: { offer: record.offer } } }, /holds no published offer for/],
      [{ [GRAPH]: { [A]: { ...record, kaId: '0' } } }, /holds no published offer for/],
      [{ [GRAPH]: { [A]: { kaId: record.kaId } } }, /holds no published offer for/],
      [{ [GRAPH]: { [A]: { ...record, offer: { ...record.offer, capacity: 0 } } } }, /holds no published offer for/],
      [{ [GRAPH]: { [A]: { ...record, offer: { ...record.offer, provenance: 'other' } } } }, /holds no published offer for/],
      [{ [GRAPH]: { [A]: { ...record, offer: { ...record.offer, signedAt: String(record.offer.signedAt) } } } }, /holds no published offer for/],
      [{ [GRAPH]: { [A]: { ...record, offer: { ...record.offer, pricePerUnit: 'ten' } } } }, /holds no published offer for/],
      [{ [GRAPH]: { [B]: record } }, new RegExp(`holds no published offer for ${B}`)],
    ];
    for (const [content, message] of broken) {
      await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
      await expect(sellerWith().load(), JSON.stringify(content)).rejects.toThrow(message);
    }
  });
});

describe('why an offer run failed', () => {
  const revert = (signature: string, args: unknown[]) => {
    const iface = new ethers.Interface([`error ${signature}`]);
    return { data: iface.encodeErrorResult(iface.fragments[0] as ethers.ErrorFragment, args) };
  };

  it('is read from the code, the name or the revert of what was thrown', () => {
    expect([
      { code: 'MARKETPLACE_NOT_ADMITTED' }, { code: 'CONFIRMED_CATALOG_OBLIGATION_PENDING' }, { code: 'CG_NOT_REGISTERED' },
      { code: 'NO_FUNDED_PUBLISHER_WALLET' }, { name: 'InsufficientPublisherFundsError' }, { name: 'QuorumUnmetError' },
      revert('TooLowBalance(address tokenAddress, uint256 balance, uint256 expected)', [ethers.ZeroAddress, 0, 1]),
      revert('ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)', [ethers.ZeroAddress, 0, 1]),
      revert('KnowledgeAssetExpired(uint256 id, uint256 currentEpoch, uint256 endEpoch)', [1, 3, 2]), { code: 'OFFER_EXPIRED' },
      new Error('anything else'), null,
    ].map(listingProblemOf)).toEqual([
      'not-admitted', 'catalog-pending', 'graph-not-registered', 'no-trac', 'no-trac', 'no-ack-quorum', 'no-trac', 'no-trac', 'expired', 'expired', 'error', 'error',
    ]);
  });
});
