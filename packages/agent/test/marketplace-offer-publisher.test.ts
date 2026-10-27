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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_CONTEXT_GRAPH } from '@origintrail-official/dkg-core';
import {
  CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST,
  QUERY_COST_SCHEDULE_V1_DIGEST,
  STUB_WORDS_DIGEST,
  countTokens,
  offeringIdFor,
  queryAdmissionUnits,
} from '@origintrail-official/dkg-marketplace';
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
import { mountConnectorOffering, resolveStaticOffering } from '../src/marketplace/seller-offerings.js';
import type { MarketplaceOfferingConfig } from '../src/marketplace/config.js';

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

/** Legacy row keys → offer predicates (the tests author rows; discovery reads `?g ?offer ?p ?o` triples). */
const ROW_PREDICATE: Record<string, string> = {
  offeringId: `${MKT_NAMESPACE}offeringId`,
  serviceType: `${MKT_NAMESPACE}serviceType`,
  unit: `${MKT_NAMESPACE}unit`,
  ask: `${MKT_NAMESPACE}askPerUnitWei`,
  sellerIdentityId: `${MKT_NAMESPACE}sellerIdentityId`,
  sellerPeerId: `${MKT_NAMESPACE}sellerPeerId`,
  sellerAddress: `${MKT_NAMESPACE}sellerAddress`,
  revision: `${MKT_NAMESPACE}revision`,
  modelId: `${MKT_NAMESPACE}modelId`,
  capacity: `${MKT_NAMESPACE}capacityUnitsPerMin`,
  expiresAt: `${MKT_NAMESPACE}expiresAt`,
};

/** One offer row as the triple-scan bindings the discovery query returns. */
function triplesOf(row: Record<string, string>): Array<Record<string, string>> {
  return Object.entries(row)
    .filter(([key, value]) => key !== 'g' && key !== 'offer' && value !== '')
    .map(([key, value]) => ({ g: row.g, offer: row.offer, p: ROW_PREDICATE[key] ?? key, o: value }));
}
const triples = (...rows: Array<Record<string, string>>) => rows.flatMap(triplesOf);

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
        return { type: 'bindings', bindings: triples(...rows) };
      },
    });
    const offers = await source.discoverOffers();

    expect(seen).toHaveLength(1);
    expect(seen[0].options).toEqual({ contextGraphId: MARKETPLACE_CONTEXT_GRAPH, includeSharedMemory: true });
    expect(seen[0].sparql).toContain(MKT_NAMESPACE);
    expect(seen[0].sparql).toContain('GRAPH ?g');
    // A triple scan: no per-predicate OPTIONAL fan-out, no truncating LIMIT.
    expect(seen[0].sparql).not.toMatch(/OPTIONAL|LIMIT/);
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
    const offers = parseMarketplaceOfferBindings(triples(
      // A different author advertising this seller's offer (forged or shadowing).
      goodRow({ g: kaGraph('_verifiable_memory', OTHER_AUTHOR), ask: '"1"', revision: '"99"' }),
      // Legacy root-scoped shared-memory bucket: no author to check.
      goodRow({ g: `did:dkg:context-graph:${MARKETPLACE_CONTEXT_GRAPH}/_shared_memory`, ask: '"2"', revision: '"98"' }),
      // Another graph entirely.
      goodRow({ g: `did:dkg:context-graph:elsewhere/_verifiable_memory/${SELLER.sellerAddress}/1`, ask: '"3"' }),
      // No sellerAddress: nothing to bind the author to.
      goodRow({ g: kaGraph('_verifiable_memory', SELLER.sellerAddress, 2), sellerAddress: '', ask: '"4"' }),
      goodRow({ g: kaGraph('_verifiable_memory', SELLER.sellerAddress.toUpperCase().replace('0X', '0x')) }),
    ));
    expect(offers).toHaveLength(1);
    expect(offers[0].askPerUnitWei).toBe(500_000_000_000n);
  });

  it('keeps only the newest revision per (seller, offering) — no stale ask while an update is in flight', () => {
    const updated = parseMarketplaceOfferBindings(triples(
      // Old version still in Verifiable Memory, new version already shared.
      goodRow({ ask: '"800000000000"', revision: '"10"' }),
      goodRow({ g: kaGraph('_shared_memory', SELLER.sellerAddress), ask: '"450000000000"', revision: '"11"' }),
    ));
    expect(updated.map((offer) => offer.askPerUnitWei)).toEqual([450_000_000_000n]);

    // Byte-identical twin in both layers: one offer, Verifiable Memory wins the tie.
    const twin = parseMarketplaceOfferBindings(triples(
      goodRow({ g: kaGraph('_shared_memory', SELLER.sellerAddress), ask: '"450000000000"', modelId: '"swm"' }),
      goodRow({ ask: '"450000000000"', modelId: '"vm"' }),
    ));
    expect(twin).toHaveLength(1);
    expect(twin[0].modelId).toBe('vm');

    // Different sellers and different offerings stay separate.
    const many = parseMarketplaceOfferBindings(triples(
      goodRow(),
      goodRow({ offeringId: '"0xabc"', offer: 'urn:x:knowledge' }),
      goodRow({
        g: kaGraph('_verifiable_memory', OTHER_AUTHOR),
        sellerAddress: `"${OTHER_AUTHOR}"`,
        sellerIdentityId: '"8"',
        sellerPeerId: '"12D3KooWOther"',
        offer: 'urn:x:other',
      }),
    ));
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
      query: async () => ({ type: 'bindings', bindings: triples(...steps[step++]) }),
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
    const g = kaGraph('_verifiable_memory', SELLER.sellerAddress);
    const [offer] = parseMarketplaceOfferBindings(quads.map((q) => ({ g, offer: q.subject, p: q.predicate, o: q.object })));
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

  it('query executor meters with the static cost schedule and fails closed before execution', async () => {
    const sparql = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }';
    const admission = queryAdmissionUnits(sparql);
    expect(admission).toBe(13n); // GV-8: no LIMIT → +10 surcharge
    const executor = createQueryExecutor(async () => ({ rowCount: 5, result: { bindings: [1, 2, 3, 4, 5] } }));
    const executed = await executor.execute(encode({ sparql }), { maxUnits: 100n });
    expect(executed.unitsServed).toBe(admission + 1n);
    expect(JSON.parse(new TextDecoder().decode(executed.resultBytes))).toEqual({
      schema: 'sparql-result/v1',
      result: { bindings: [1, 2, 3, 4, 5] },
      rowCount: 5,
      metering: {
        scheduleDigest: QUERY_COST_SCHEDULE_V1_DIGEST,
        admissionUnits: 13,
        deliveryUnits: 1,
        servedUnits: 14,
        rowCount: 5,
      },
    });

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

describe('marketplace offer extensions (connectors, metering pin, model facts, query schedule)', () => {
  const g = kaGraph('_verifiable_memory', SELLER.sellerAddress);
  const toTriples = (quads: readonly Quad[]) => quads.map((q) => ({ g, offer: q.subject, p: q.predicate, o: q.object }));

  async function chatOffering(overrides: Partial<MarketplaceOfferingConfig> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dkg-mkt-offer-ext-'));
    const secretEnvFile = join(dir, 'upstream.env');
    writeFileSync(secretEnvFile, 'MY_UPSTREAM_KEY=sk-never-published\n', { mode: 0o600 });
    const config: MarketplaceOfferingConfig = {
      offeringLocalId: 'devnet-chat', serviceType: 'inference', unit: 'token', modelId: 'Stub-Chat',
      askPerUnitWei: 500_000_000_000n,
      connector: {
        kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:18080/v1', upstreamModel: 'stub-chat',
        secretEnvFile, secretEnvKey: 'MY_UPSTREAM_KEY', contextLength: 32_768n,
      },
      metering: { tokenizer: { kind: 'stub-words-v1' } },
      model: { displayName: 'Stub "Chat"', quantization: 'q4' },
      allowedBuyers: ['0x00000000000000000000000000000000000000Bb'],
      ...overrides,
    };
    const deps = { log: { info: () => {}, warn: () => {} }, queryFn: async () => ({ result: null }) };
    try {
      const { offering: mounted } = await mountConnectorOffering(config, deps);
      return { mounted, config, secretEnvFile };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('publishes the chat pin and model facts, never endpoints, paths, keys or the allow list — and parses them back', async () => {
    const { mounted, secretEnvFile } = await chatOffering();
    const quads = buildMarketplaceOfferQuads(mounted, SELLER, 7n);
    const objects = quads.map((q) => q.object).join('\n');
    for (const secret of ['127.0.0.1:18080', secretEnvFile, 'MY_UPSTREAM_KEY', 'sk-never-published', '0x00000000000000000000000000000000000000', 'http://']) {
      expect(objects).not.toContain(secret);
    }
    expect(objectOf(quads, `${MKT_NAMESPACE}apiShape`)).toBe('"openai-chat/v1"');
    expect(objectOf(quads, `${MKT_NAMESPACE}tokenizerDigest`)).toBe(`"${STUB_WORDS_DIGEST}"`);
    expect(objectOf(quads, `${MKT_NAMESPACE}modelId`)).toBe('"stub-chat"');

    const [offer] = parseMarketplaceOfferBindings(toTriples(quads));
    expect(offer).toMatchObject({
      modelId: 'stub-chat',
      apiShape: 'openai-chat/v1',
      toolTransport: 'native',
      metering: {
        basis: 'pinned',
        tokenizer: { kind: 'stub-words-v1', digest: STUB_WORDS_DIGEST },
        chatTemplate: { id: 'openai-chat-count/v1', digest: CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST },
      },
      model: {
        provenanceClass: 'upstream-claimed', upstreamModel: 'stub-chat', contextLength: 32_768n,
        displayName: 'Stub "Chat"', quantization: 'q4',
      },
      access: 'restricted',
    });
    expect(offer).not.toHaveProperty('queryCost');
    // Facts must round-trip exactly: control characters and backslashes are refused at mount.
    await expect(chatOffering({ model: { displayName: 'bad\\name' } })).rejects.toMatchObject({ code: 'CONNECTOR_CONFIG' });
  });

  it('a local-query offering publishes the query cost schedule pin', () => {
    const resolved = resolveStaticOffering(
      { offeringLocalId: 'devnet-knowledge', serviceType: 'query', unit: 'query-unit', askPerUnitWei: 1n },
      { log: { info: () => {}, warn: () => {} }, queryFn: async () => ({ result: null }) },
    );
    const [offer] = parseMarketplaceOfferBindings(toTriples(buildMarketplaceOfferQuads(resolved, SELLER, 1n)));
    expect(offer.queryCost).toEqual({ schedule: 'dkg-mkt-query-cost/1', digest: QUERY_COST_SCHEDULE_V1_DIGEST });
    expect(offer.apiShape).toBeUndefined();
  });

  it('a pin change republishes as a KA update; an unchanged pinned offer sends nothing', async () => {
    const { mounted } = await chatOffering();
    const { port, calls } = fakeAssetPort();
    await publishMarketplaceOfferings(port, [mounted], SELLER, { nowMs: () => 1_000 });
    calls.length = 0;
    const unchanged = await publishMarketplaceOfferings(port, [mounted], SELLER, { nowMs: () => 2_000 });
    expect(unchanged.assets[0].outcome).toBe('unchanged');
    expect(calls.filter((c) => c.startsWith('publish:'))).toEqual([]);
    const repinned = { ...mounted, metering: { basis: 'provider-reported' as const } };
    const republished = await publishMarketplaceOfferings(port, [repinned], SELLER, { nowMs: () => 3_000 });
    expect(republished.assets[0]).toMatchObject({ outcome: 'published', revision: '3000' });
  });

  it('a malformed extension drops only its own group; the offer stays', async () => {
    const { mounted } = await chatOffering();
    const quads = buildMarketplaceOfferQuads(mounted, SELLER, 7n);
    const swap = (predicate: string, object: string) =>
      quads.map((q) => (q.predicate === `${MKT_NAMESPACE}${predicate}` ? { ...q, object } : q));
    const badDigest = parseMarketplaceOfferBindings(toTriples(swap('tokenizerDigest', '"sha256:nothex"')))[0];
    expect(badDigest.metering).toBeUndefined();
    expect(badDigest).toMatchObject({ apiShape: 'openai-chat/v1', model: { provenanceClass: 'upstream-claimed' } });
    // A stub-words pin must carry the stub-words digest.
    const wrongStub = parseMarketplaceOfferBindings(toTriples(swap('tokenizerDigest', `"sha256:${'1'.repeat(64)}"`)))[0];
    expect(wrongStub.metering).toBeUndefined();
    const badContext = parseMarketplaceOfferBindings(toTriples(swap('contextLength', '"12.5"')))[0];
    expect(badContext.model).toBeUndefined();
    expect(badContext.metering?.basis).toBe('pinned');
    const badEnum = parseMarketplaceOfferBindings(toTriples(swap('toolTransport', '"telepathy"')))[0];
    expect(badEnum.toolTransport).toBeUndefined();
    expect(badEnum.askPerUnitWei).toBe(500_000_000_000n);
  });

  it('triple-scan safety: duplicated extension values drop their groups in linear time; >64 triples or a duplicated core predicate skip the offer', async () => {
    const { mounted } = await chatOffering();
    const quads = buildMarketplaceOfferQuads(mounted, SELLER, 7n);
    const subject = quads[0].subject;
    const ext = ['apiShape', 'toolTransport', 'meteringBasis', 'tokenizerKind', 'tokenizerDigest', 'chatTemplate',
      'provenanceClass', 'upstreamModel', 'contextLength', 'modelDisplayName'];
    const spam: Quad[] = ext.flatMap((local) => [1, 2, 3, 4].map((i) => ({
      subject, predicate: `${MKT_NAMESPACE}${local}`, object: `"junk-${i}"`, graph: '',
    })));
    const started = performance.now();
    const [offer] = parseMarketplaceOfferBindings(toTriples([...quads.filter((q) => !ext.some((l) => q.predicate.endsWith(`#${l}`))), ...spam]));
    expect(performance.now() - started).toBeLessThan(100);
    expect(offer.askPerUnitWei).toBe(500_000_000_000n);
    expect(offer.apiShape).toBeUndefined();
    expect(offer.metering).toBeUndefined();
    expect(offer.model).toBeUndefined();

    const oversized = Array.from({ length: 70 }, (_, i) => ({ subject, predicate: `${MKT_NAMESPACE}junk${i}`, object: '"x"', graph: '' }));
    expect(parseMarketplaceOfferBindings(toTriples([...quads, ...oversized]))).toEqual([]);
    const twoAsks = [...quads, { subject, predicate: `${MKT_NAMESPACE}askPerUnitWei`, object: '"1"', graph: '' }];
    expect(parseMarketplaceOfferBindings(toTriples(twoAsks))).toEqual([]);
  });
});
