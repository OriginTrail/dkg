/**
 * OT-RFC-27 marketplace offer publication/discovery and executor metering —
 * the agent-side pieces that do not need a p2p pair: offer-KA quad building,
 * CG-backed publish (fake ports), SPARQL-row parsing back into typed offers,
 * and the executors' deterministic unit schedules with their fail-closed
 * `maxUnits` behaviour.
 */
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_CONTEXT_GRAPH } from '@origintrail-official/dkg-core';
import { countTokens, offeringIdFor, queryUnits } from '@origintrail-official/dkg-marketplace';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  MKT_NAMESPACE,
  buildMarketplaceOfferQuads,
  createContextGraphOfferSource,
  marketplaceOfferSubject,
  parseMarketplaceOfferBindings,
  publishMarketplaceOfferings,
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

describe('marketplace offer publication', () => {
  it('builds the mkt: vocabulary offer KA, creating the marketplace CG when missing', async () => {
    const created: string[] = [];
    const shared: Array<{ contextGraphId: string; quads: Quad[] }> = [];
    let exists = false;
    const port = {
      contextGraphExists: async () => exists,
      createContextGraph: async (opts: { id: string; name: string; description?: string }) => {
        created.push(opts.id);
        exists = true;
      },
      share: async (contextGraphId: string, quads: Quad[]) => {
        shared.push({ contextGraphId, quads });
        return { shareOperationId: `op-${shared.length}` };
      },
    };

    const result = await publishMarketplaceOfferings(
      port,
      [offering(), offering({ offeringLocalId: 'devnet-knowledge', offeringId: offeringIdFor('devnet-knowledge'), serviceType: 'query', unit: 'query-unit', askPerUnitWei: 15_000_000_000_000n })],
      SELLER,
    );

    expect(created).toEqual([MARKETPLACE_CONTEXT_GRAPH]);
    expect(shared).toHaveLength(2);
    expect(shared[0].contextGraphId).toBe(MARKETPLACE_CONTEXT_GRAPH);
    expect(result.published).toEqual([
      marketplaceOfferSubject(SELLER.sellerPeerId, 'devnet-llm'),
      marketplaceOfferSubject(SELLER.sellerPeerId, 'devnet-knowledge'),
    ]);

    const quads = shared[0].quads;
    const subject = marketplaceOfferSubject(SELLER.sellerPeerId, 'devnet-llm');
    expect(quads.every((q) => q.subject === subject && q.graph === '')).toBe(true);
    const byPredicate = new Map(quads.map((q) => [q.predicate, q.object]));
    expect(byPredicate.get('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')).toBe(`${MKT_NAMESPACE}Offer`);
    expect(byPredicate.get(`${MKT_NAMESPACE}offeringId`)).toBe(`"${offeringIdFor('devnet-llm')}"`);
    expect(byPredicate.get(`${MKT_NAMESPACE}askPerUnitWei`)).toBe('"500000000000"');
    expect(byPredicate.get(`${MKT_NAMESPACE}sellerIdentityId`)).toBe('"7"');
    expect(byPredicate.get(`${MKT_NAMESPACE}sellerAddress`)).toBe(`"${SELLER.sellerAddress}"`);

    // Already-existing CG: no second create.
    await publishMarketplaceOfferings(port, [offering()], SELLER);
    expect(created).toEqual([MARKETPLACE_CONTEXT_GRAPH]);
  });

  it('round-trips offers through SPARQL bindings and skips malformed rows', async () => {
    const goodRow = {
      offer: marketplaceOfferSubject(SELLER.sellerPeerId, 'devnet-llm'),
      offeringId: `"${offeringIdFor('devnet-llm')}"`,
      serviceType: '"inference"',
      unit: '"token"',
      ask: '"500000000000"',
      sellerIdentityId: '"7"',
      sellerPeerId: `"${SELLER.sellerPeerId}"`,
      sellerAddress: `"${SELLER.sellerAddress}"`,
      modelId: '"devnet-echo"',
      capacity: '"120000"',
      expiresAt: '"1900000600"',
    };
    const rows = [
      goodRow,
      { ...goodRow, ask: '"not-a-number"' }, // malformed ask → skipped
      { ...goodRow, serviceType: '"teleportation"' }, // unknown enum → skipped
      { ...goodRow, sellerIdentityId: '"0"' }, // identity 0 → skipped
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

  it('parses the quads it publishes (publish → bindings → offer round trip)', () => {
    const quads = buildMarketplaceOfferQuads(offering(), SELLER);
    const row: Record<string, string> = { offer: quads[0].subject };
    const keyByPredicate: Record<string, string> = {
      [`${MKT_NAMESPACE}offeringId`]: 'offeringId',
      [`${MKT_NAMESPACE}serviceType`]: 'serviceType',
      [`${MKT_NAMESPACE}unit`]: 'unit',
      [`${MKT_NAMESPACE}askPerUnitWei`]: 'ask',
      [`${MKT_NAMESPACE}sellerIdentityId`]: 'sellerIdentityId',
      [`${MKT_NAMESPACE}sellerPeerId`]: 'sellerPeerId',
      [`${MKT_NAMESPACE}sellerAddress`]: 'sellerAddress',
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
