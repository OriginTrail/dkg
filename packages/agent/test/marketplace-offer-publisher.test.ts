/**
 * OT-RFC-27 marketplace offer publication/discovery and executor metering —
 * the agent-side pieces that do not need a p2p pair: offer-KA quad building,
 * the publish loop over the offer-asset port (fake ports: anchor first, one
 * KA per offering, unchanged offers left alone, a reprice published as the
 * next version of the SAME asset with a larger revision), SPARQL-row parsing
 * back into typed offers (KA-author authority, newest revision per seller
 * and offering), and the executors' deterministic unit schedules with their
 * fail-closed `maxUnits` behaviour.
 */
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_CONTEXT_GRAPH } from '@origintrail-official/dkg-core';
import { countTokens, offeringIdFor, queryUnits } from '@origintrail-official/dkg-marketplace';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  MKT_NAMESPACE,
  buildMarketplaceOfferQuads,
  createContextGraphOfferSource,
  marketplaceOfferAssetName,
  marketplaceOfferSubject,
  parseMarketplaceOfferBindings,
  publishMarketplaceOfferings,
  type MarketplaceOfferAssetPort,
} from '../src/marketplace/offer-publisher.js';
import {
  MarketplaceExecutionError,
  createQueryExecutor,
  createStubInferenceExecutor,
} from '../src/marketplace/executors.js';
import type { MarketplaceSellerOffering } from '../src/marketplace/seller-service.js';

const SELLER = {
  sellerIdentityId: 7n,
  sellerPeerId: '12D3KooWSellerSellerSellerSellerSellerSellerSell',
  sellerAddress: '0x1111111111111111111111111111111111111111',
};
const OTHER_AUTHOR = '0x2222222222222222222222222222222222222222';

function offering(overrides: Partial<MarketplaceSellerOffering> = {}): MarketplaceSellerOffering {
  return {
    offeringLocalId: 'devnet-llm',
    offeringId: offeringIdFor('devnet-llm'),
    serviceType: 'inference',
    unit: 'token',
    askPerUnitWei: 500_000_000_000n,
    executor: createStubInferenceExecutor(),
    ...overrides,
  };
}

const knowledgeOffering = () => offering({
  offeringLocalId: 'devnet-knowledge',
  offeringId: offeringIdFor('devnet-knowledge'),
  serviceType: 'query',
  unit: 'query-unit',
  askPerUnitWei: 15_000_000_000_000n,
});

/** An in-memory offer-asset port: each publish replaces the asset's confirmed content. */
function fakeAssetPort() {
  const confirmed = new Map<string, Quad[]>();
  const calls: string[] = [];
  const port: MarketplaceOfferAssetPort = {
    async readPublishedOffer(assetName, subject) {
      expect(subject).toMatch(/^urn:dkg:marketplace:offer:/);
      calls.push(`read:${assetName}`);
      return confirmed.get(assetName) ?? null;
    },
    async publishOfferAsset(assetName, quads) {
      calls.push(`publish:${assetName}`);
      confirmed.set(assetName, quads);
      return { ual: `did:dkg:test/${SELLER.sellerAddress}/${assetName}` };
    },
  };
  return { port, confirmed, calls };
}

function objectOf(quads: readonly Quad[], predicate: string): string | undefined {
  return quads.find((quad) => quad.predicate === predicate)?.object;
}

const kaGraph = (layer: '_verifiable_memory' | '_shared_memory', author: string, number = 1) =>
  `did:dkg:context-graph:${MARKETPLACE_CONTEXT_GRAPH}/${layer}/${author.toLowerCase()}/${number}`;

describe('marketplace offer publication', () => {
  it('publishes one mkt: vocabulary offer KA per offering, anchoring the CG first', async () => {
    const { port, confirmed, calls } = fakeAssetPort();
    const result = await publishMarketplaceOfferings(port, [offering(), knowledgeOffering()], SELLER, {
      ensureAnchor: async () => { calls.push('anchor'); },
      nowMs: () => 1_700_000_000_000,
    });

    const llmAsset = marketplaceOfferAssetName(offering());
    const knowledgeAsset = marketplaceOfferAssetName(knowledgeOffering());
    expect(llmAsset).toBe('marketplace-offer-devnet-llm');
    expect(calls).toEqual([
      'anchor',
      `read:${llmAsset}`, `publish:${llmAsset}`,
      `read:${knowledgeAsset}`, `publish:${knowledgeAsset}`,
    ]);
    expect(result.published).toEqual([
      marketplaceOfferSubject(SELLER.sellerPeerId, 'devnet-llm'),
      marketplaceOfferSubject(SELLER.sellerPeerId, 'devnet-knowledge'),
    ]);
    expect(result.assets.map((asset) => [asset.assetName, asset.outcome, asset.revision])).toEqual([
      [llmAsset, 'published', '1700000000000'],
      [knowledgeAsset, 'published', '1700000000000'],
    ]);

    const quads = confirmed.get(llmAsset)!;
    const subject = marketplaceOfferSubject(SELLER.sellerPeerId, 'devnet-llm');
    expect(quads.every((q) => q.subject === subject && q.graph === '')).toBe(true);
    expect(objectOf(quads, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type')).toBe(`${MKT_NAMESPACE}Offer`);
    expect(objectOf(quads, `${MKT_NAMESPACE}offeringId`)).toBe(`"${offeringIdFor('devnet-llm')}"`);
    expect(objectOf(quads, `${MKT_NAMESPACE}askPerUnitWei`)).toBe('"500000000000"');
    expect(objectOf(quads, `${MKT_NAMESPACE}sellerIdentityId`)).toBe('"7"');
    expect(objectOf(quads, `${MKT_NAMESPACE}sellerAddress`)).toBe(`"${SELLER.sellerAddress}"`);
    expect(objectOf(quads, `${MKT_NAMESPACE}revision`)).toBe('"1700000000000"');
  });

  it('an anchor failure aborts before any offer asset is touched', async () => {
    const { port, calls } = fakeAssetPort();
    await expect(publishMarketplaceOfferings(port, [offering()], SELLER, {
      ensureAnchor: async () => { throw new Error('anchored at slot 3 but not bound yet'); },
    })).rejects.toThrow(/not bound yet/);
    expect(calls).toEqual([]);
  });

  it('leaves an unchanged offer alone and publishes a reprice as the next version of the SAME asset', async () => {
    const { port, confirmed, calls } = fakeAssetPort();
    let now = 1_000;
    const nowMs = () => now;
    await publishMarketplaceOfferings(port, [offering(), knowledgeOffering()], SELLER, { nowMs });
    calls.length = 0;

    // Same content, later clock: nothing is republished (no chain transaction).
    now = 5_000;
    const unchanged = await publishMarketplaceOfferings(port, [offering(), knowledgeOffering()], SELLER, { nowMs });
    expect(calls.filter((call) => call.startsWith('publish:'))).toEqual([]);
    expect(unchanged.assets.map((asset) => [asset.outcome, asset.revision])).toEqual([
      ['unchanged', '1000'],
      ['unchanged', '1000'],
    ]);

    // Reprice ONE offering: only its asset is published, under the same name,
    // with a strictly larger revision — even when the clock went backwards.
    now = 500;
    const repriced = await publishMarketplaceOfferings(
      port,
      [offering({ askPerUnitWei: 450_000_000_000n }), knowledgeOffering()],
      SELLER,
      { nowMs },
    );
    const llmAsset = marketplaceOfferAssetName(offering());
    expect(calls.filter((call) => call.startsWith('publish:'))).toEqual([`publish:${llmAsset}`]);
    expect(repriced.assets.map((asset) => [asset.assetName, asset.outcome, asset.revision])).toEqual([
      [llmAsset, 'published', '1001'],
      [marketplaceOfferAssetName(knowledgeOffering()), 'unchanged', '1000'],
    ]);
    expect(objectOf(confirmed.get(llmAsset)!, `${MKT_NAMESPACE}askPerUnitWei`)).toBe('"450000000000"');
    expect(objectOf(confirmed.get(llmAsset)!, `${MKT_NAMESPACE}revision`)).toBe('"1001"');
  });

  it('names an offering asset by its offering id when the local id is not a safe asset name', () => {
    const unsafe = offering({ offeringLocalId: 'has space/and slash', offeringId: offeringIdFor('has space/and slash') });
    expect(marketplaceOfferAssetName(unsafe)).toBe(`marketplace-offer-${offeringIdFor('has space/and slash')}`);
  });
});

describe('marketplace offer discovery', () => {
  const goodRow = (overrides: Record<string, string> = {}) => ({
    g: kaGraph('_verifiable_memory', SELLER.sellerAddress),
    offer: marketplaceOfferSubject(SELLER.sellerPeerId, 'devnet-llm'),
    offeringId: `"${offeringIdFor('devnet-llm')}"`,
    serviceType: '"inference"',
    unit: '"token"',
    ask: '"500000000000"',
    sellerIdentityId: '"7"',
    sellerPeerId: `"${SELLER.sellerPeerId}"`,
    sellerAddress: `"${SELLER.sellerAddress}"`,
    revision: '"10"',
    modelId: '"devnet-echo"',
    capacity: '"120000"',
    expiresAt: '"1900000600"',
    ...overrides,
  });

  it('round-trips offers through SPARQL bindings and skips malformed rows', async () => {
    const rows = [
      goodRow(),
      goodRow({ offer: 'urn:x:1', offeringId: '"0x01"', ask: '"not-a-number"' }), // malformed ask
      goodRow({ offer: 'urn:x:2', offeringId: '"0x02"', serviceType: '"teleportation"' }), // unknown enum
      goodRow({ offer: 'urn:x:3', offeringId: '"0x03"', sellerIdentityId: '"0"' }), // identity 0
    ];

    const seen: Array<{ sparql: string; options: unknown }> = [];
    const source = createContextGraphOfferSource({
      query: async (sparql, options) => {
        seen.push({ sparql, options });
        return { type: 'bindings', bindings: rows };
      },
    });
    const offers = await source.discoverOffers();

    expect(seen).toHaveLength(1);
    expect(seen[0].options).toEqual({ contextGraphId: MARKETPLACE_CONTEXT_GRAPH, includeSharedMemory: true });
    expect(seen[0].sparql).toContain(MKT_NAMESPACE);
    expect(seen[0].sparql).toContain('GRAPH ?g');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toEqual({
      offerId: marketplaceOfferSubject(SELLER.sellerPeerId, 'devnet-llm'),
      offeringId: offeringIdFor('devnet-llm'),
      serviceType: 'inference',
      unit: 'token',
      askPerUnitWei: 500_000_000_000n,
      sellerIdentityId: 7n,
      sellerPeerId: SELLER.sellerPeerId,
      sellerAddress: SELLER.sellerAddress,
      modelId: 'devnet-echo',
      capacityUnitsPerMin: 120_000n,
      expiresAt: 1_900_000_600,
    });
  });

  it('accepts an offer only from a Knowledge Asset authored by its sellerAddress', () => {
    const offers = parseMarketplaceOfferBindings([
      // A different author advertising this seller's offer (forged or shadowing).
      goodRow({ g: kaGraph('_verifiable_memory', OTHER_AUTHOR), ask: '"1"', revision: '"99"' }),
      // Legacy root-scoped shared-memory bucket: no author to check.
      goodRow({ g: `did:dkg:context-graph:${MARKETPLACE_CONTEXT_GRAPH}/_shared_memory`, ask: '"2"', revision: '"98"' }),
      // Another graph entirely.
      goodRow({ g: `did:dkg:context-graph:elsewhere/_verifiable_memory/${SELLER.sellerAddress}/1`, ask: '"3"' }),
      // No sellerAddress: nothing to bind the author to.
      goodRow({ sellerAddress: '', ask: '"4"' }),
      goodRow({ g: kaGraph('_verifiable_memory', SELLER.sellerAddress.toUpperCase().replace('0X', '0x')) }),
    ]);
    expect(offers).toHaveLength(1);
    expect(offers[0].askPerUnitWei).toBe(500_000_000_000n);
  });

  it('keeps only the newest revision per (seller, offering) — no stale ask while an update is in flight', () => {
    const updated = parseMarketplaceOfferBindings([
      // Old version still in Verifiable Memory, new version already shared.
      goodRow({ ask: '"800000000000"', revision: '"10"' }),
      goodRow({ g: kaGraph('_shared_memory', SELLER.sellerAddress), ask: '"450000000000"', revision: '"11"' }),
    ]);
    expect(updated.map((offer) => offer.askPerUnitWei)).toEqual([450_000_000_000n]);

    // Byte-identical twin in both layers: one offer, Verifiable Memory wins the tie.
    const twin = parseMarketplaceOfferBindings([
      goodRow({ g: kaGraph('_shared_memory', SELLER.sellerAddress), ask: '"450000000000"', modelId: '"swm"' }),
      goodRow({ ask: '"450000000000"', modelId: '"vm"' }),
    ]);
    expect(twin).toHaveLength(1);
    expect(twin[0].modelId).toBe('vm');

    // Different sellers and different offerings stay separate.
    const many = parseMarketplaceOfferBindings([
      goodRow(),
      goodRow({ offeringId: '"0xabc"', offer: 'urn:x:knowledge' }),
      goodRow({
        g: kaGraph('_verifiable_memory', OTHER_AUTHOR),
        sellerAddress: `"${OTHER_AUTHOR}"`,
        sellerIdentityId: '"8"',
        sellerPeerId: '"12D3KooWOther"',
        offer: 'urn:x:other',
      }),
    ]);
    expect(many).toHaveLength(3);
  });

  it('never goes back to an older revision once a newer one was returned (shared copy retracted before VM catches up)', async () => {
    const steps: Array<Array<Record<string, string>>> = [
      [goodRow({ ask: '"800000000000"', revision: '"10"' })],
      // The update is shared: both versions held, the newest wins.
      [
        goodRow({ ask: '"800000000000"', revision: '"10"' }),
        goodRow({ g: kaGraph('_shared_memory', SELLER.sellerAddress), ask: '"450000000000"', revision: '"11"' }),
      ],
      // The seller's update confirmed and the shared copy was retracted, but
      // this node has not reconciled the update into Verifiable Memory yet.
      [goodRow({ ask: '"800000000000"', revision: '"10"' })],
      // Reconciled.
      [goodRow({ ask: '"450000000000"', revision: '"11"' })],
      // A later reprice (back up) is newer again.
      [goodRow({ ask: '"900000000000"', revision: '"12"' })],
      // An offer this node no longer holds is not resurrected.
      [],
    ];
    let step = 0;
    const source = createContextGraphOfferSource({
      query: async () => ({ type: 'bindings', bindings: steps[step++] }),
    });
    const asks: bigint[][] = [];
    for (let i = 0; i < steps.length; i++) {
      asks.push((await source.discoverOffers()).map((offer) => offer.askPerUnitWei));
    }
    expect(asks).toEqual([
      [800_000_000_000n],
      [450_000_000_000n],
      [450_000_000_000n],
      [450_000_000_000n],
      [900_000_000_000n],
      [],
    ]);
  });

  it('parses the quads it publishes (publish → bindings → offer round trip)', () => {
    const quads = buildMarketplaceOfferQuads(offering(), SELLER, 42n);
    const row: Record<string, string> = { g: kaGraph('_verifiable_memory', SELLER.sellerAddress), offer: quads[0].subject };
    const keyByPredicate: Record<string, string> = {
      [`${MKT_NAMESPACE}offeringId`]: 'offeringId',
      [`${MKT_NAMESPACE}serviceType`]: 'serviceType',
      [`${MKT_NAMESPACE}unit`]: 'unit',
      [`${MKT_NAMESPACE}askPerUnitWei`]: 'ask',
      [`${MKT_NAMESPACE}sellerIdentityId`]: 'sellerIdentityId',
      [`${MKT_NAMESPACE}sellerPeerId`]: 'sellerPeerId',
      [`${MKT_NAMESPACE}sellerAddress`]: 'sellerAddress',
      [`${MKT_NAMESPACE}revision`]: 'revision',
    };
    for (const quad of quads) {
      const key = keyByPredicate[quad.predicate];
      if (key) row[key] = quad.object;
    }
    const [offer] = parseMarketplaceOfferBindings([row]);
    expect(offer.offeringId).toBe(offeringIdFor('devnet-llm'));
    expect(offer.askPerUnitWei).toBe(500_000_000_000n);
    expect(offer.sellerIdentityId).toBe(7n);
    expect(offer.sellerAddress).toBe(SELLER.sellerAddress);
  });
});

describe('marketplace executors', () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  it('stub inference meters prompt + echo and truncates the echo to fit maxUnits', async () => {
    const executor = createStubInferenceExecutor();
    const prompt = 'twelve chars'; // 12 bytes → 3 tokens
    const full = await executor.execute(encode({ prompt }), { maxUnits: 100n });
    expect(full.unitsServed).toBe(2n * countTokens(prompt));
    expect(JSON.parse(new TextDecoder().decode(full.resultBytes))).toEqual({ output: prompt, truncated: false });

    // Budget of 4 tokens: 3 for the prompt, 1 left for the echo.
    const trimmed = await executor.execute(encode({ prompt }), { maxUnits: 4n });
    const parsed = JSON.parse(new TextDecoder().decode(trimmed.resultBytes)) as { output: string; truncated: boolean };
    expect(parsed.truncated).toBe(true);
    expect(countTokens(parsed.output) <= 1n).toBe(true);
    expect(trimmed.unitsServed).toBe(countTokens(prompt) + countTokens(parsed.output));
    expect(trimmed.unitsServed <= 4n).toBe(true);
  });

  it('stub inference fails closed when the prompt alone exceeds maxUnits', async () => {
    const executor = createStubInferenceExecutor();
    await expect(executor.execute(encode({ prompt: 'far too long for two tokens' }), { maxUnits: 2n }))
      .rejects.toMatchObject({ name: 'MarketplaceExecutionError', code: 'OVER_MAX_UNITS' });
    await expect(executor.execute(encode({ nope: true }), { maxUnits: 10n }))
      .rejects.toMatchObject({ code: 'BAD_PAYLOAD' });
    await expect(executor.execute(new TextEncoder().encode('not json'), { maxUnits: 10n }))
      .rejects.toMatchObject({ code: 'BAD_PAYLOAD' });
  });

  it('query executor meters with the shared schedule and fails closed over maxUnits', async () => {
    const sparql = 'SELECT * WHERE { ?s ?p ?o }';
    const executor = createQueryExecutor(async () => ({ rowCount: 5, result: { rows: 5 } }));
    const executed = await executor.execute(encode({ sparql }), { maxUnits: 100n });
    expect(executed.unitsServed).toBe(queryUnits(sparql, 5));
    expect(JSON.parse(new TextDecoder().decode(executed.resultBytes))).toEqual({ result: { rows: 5 } });

    await expect(executor.execute(encode({ sparql }), { maxUnits: 5n }))
      .rejects.toMatchObject({ code: 'OVER_MAX_UNITS' });

    const failing = createQueryExecutor(async () => {
      throw new Error('store offline');
    });
    const failure = await failing.execute(encode({ sparql }), { maxUnits: 100n }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MarketplaceExecutionError);
    expect((failure as MarketplaceExecutionError).code).toBe('EXECUTION_FAILED');
    expect((failure as MarketplaceExecutionError).message).toContain('store offline');
  });
});
