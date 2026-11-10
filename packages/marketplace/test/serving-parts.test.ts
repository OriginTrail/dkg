// SPDX-License-Identifier: Apache-2.0
/**
 * The parts the seller is built from: the wire's checks, offers in and out of
 * Verifiable Memory with their schedule and how the router reads them, the
 * OpenAI-compatible backend against a stub on loopback, the journal and the
 * per-key lock, and the seller's settings.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import { SERVICE_CLASS_INFERENCE, requestDomain } from '@origintrail-official/dkg-chain';
import {
  DEFAULT_LANDING,
  Journal,
  KeyedLock,
  UpstreamError,
  WireError,
  connectorOf,
  decodeMessage,
  encodeMessage,
  inferenceBodyFromWire,
  Router,
  offerIn,
  offerPriceIn,
  quoteRequestFromWire,
  quoteResponseFromWire,
  receiptFromWire,
  receiptToWire,
  requestFromWire,
  resolveSellerConfig,
  scheduledPrice,
  serveResponseFromWire,
  serviceIdOf,
  serviceOfferFromWire,
  serviceOfferQuads,
  serviceOfferSignerOf,
  serviceOfferToWire,
  serviceOffersFromBindings,
  serviceOffersQuery,
  signServiceOffer,
  type ServiceOffer,
} from '../src/index.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'marketplace-parts-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the wire', () => {
  const request = {
    subscriptionId: `0x${'aa'.repeat(32)}`, serviceId: `0x${'bb'.repeat(32)}`, seller: '7', nonce: '0', pricePerUnit: '10',
    maxUnits: '100', maxValueWei: '1000', issuedAt: 1_800_000_000, expiry: 1_800_000_600,
  };

  it('takes well-formed requests, bodies and quotes, and refuses the rest', () => {
    expect(requestFromWire(request)).toMatchObject({ seller: 7n, nonce: 0n, maxValueWei: 1000n });
    for (const bad of [{ ...request, nonce: '-1' }, { ...request, seller: '01' }, { ...request, maxUnits: String(1n << 64n) }, { ...request, issuedAt: 1.5 }, null]) {
      expect(() => requestFromWire(bad)).toThrow(WireError);
    }
    expect(inferenceBodyFromWire({ messages: [{ role: 'user', content: 'q' }], max_tokens: 5 }).max_tokens).toBe(5);
    for (const bad of [{ messages: [{ role: 'tool', content: 'q' }], max_tokens: 5 }, { messages: [{ role: 'user', content: 'q' }], max_tokens: 0 }]) {
      expect(() => inferenceBodyFromWire(bad)).toThrow(WireError);
    }
    expect(() => quoteRequestFromWire({ services: Array(33).fill(request.serviceId) })).toThrow(/at most 32/);
    expect(decodeMessage(encodeMessage({ a: '1' }))).toEqual({ a: '1' });
    expect(() => decodeMessage(new Uint8Array([0x7b]))).toThrow(WireError);
    const receipt = { requestDigest: request.subscriptionId, resultCommitment: request.serviceId, units: 3n, valueWei: 30n, completedAt: 5 };
    expect(receiptFromWire(receiptToWire(receipt))).toEqual(receipt);
    expect(() => receiptFromWire({ ...receiptToWire(receipt), units: 3 })).toThrow(WireError);
  });

  const offer = { serviceId: `0x${'BB'.repeat(32)}`, pricePerUnit: '10', available: true, capacity: 4 };
  const quote = { seller: '7', epoch: 663, offers: [offer, { ...offer, capacity: null, available: false }] };

  it("reads a seller's quote whole, and refuses one that is not", () => {
    expect(quoteResponseFromWire(quote)).toEqual({
      seller: '7', epoch: 663,
      offers: [{ ...offer, serviceId: offer.serviceId.toLowerCase() }, { ...offer, serviceId: offer.serviceId.toLowerCase(), capacity: null, available: false }],
    });
    expect(quoteResponseFromWire({ ...quote, offers: [] }).offers).toEqual([]);
  });

  it.each([
    ['not an object', null],
    ['offers not a list', { ...quote, offers: 'none' }],
    ['too many offers', { ...quote, offers: Array(33).fill(offer) }],
    ['a seller that is not a decimal string', { ...quote, seller: 7 }],
    ['an epoch that is not a number', { ...quote, epoch: '663' }],
    ['an epoch that is not whole', { ...quote, epoch: 1.5 }],
    ['a negative epoch', { ...quote, epoch: -1 }],
    ['an offer that is not an object', { ...quote, offers: [null] }],
    ['an offer that does not say whether it is available', { ...quote, offers: [{ ...offer, available: 'yes' }] }],
    ['an offer of no service', { ...quote, offers: [{ ...offer, serviceId: '0x01' }] }],
    ['a price that is not a decimal string', { ...quote, offers: [{ ...offer, pricePerUnit: 10 }] }],
    ['a price past 96 bits', { ...quote, offers: [{ ...offer, pricePerUnit: String(1n << 96n) }] }],
    ['a capacity that is not whole', { ...quote, offers: [{ ...offer, capacity: 'four' }] }],
  ])('refuses a quote with %s', (_what, raw) => {
    expect(() => quoteResponseFromWire(raw)).toThrow(WireError);
  });

  const served = { ok: true, result: { content: 'synthetic answer' }, receipt: { anything: 1 }, receiptSignature: '0x00', budgetIndex: 0 };

  it("reads a seller's serve answer, its receipt as it came, and its refusals", () => {
    expect(serveResponseFromWire(served)).toEqual(served);
    expect(serveResponseFromWire({ ...served, receipt: undefined })).toEqual({ ...served, receipt: undefined });
    expect(serveResponseFromWire({ ok: false, code: 'WrongPrice', retry: true })).toEqual({ ok: false, code: 'WrongPrice', retry: true });
    expect(serveResponseFromWire({ ok: false, code: 'BadRequest', retry: false, message: 'messages must be a list' }))
      .toEqual({ ok: false, code: 'BadRequest', retry: false, message: 'messages must be a list' });
  });

  it.each([
    ['not an object', 'RESPONSE_GONE'],
    ['no ok', { ...served, ok: 'yes' }],
    ['a refusal with an unknown code', { ok: false, code: 'NoSuchCode', retry: true }],
    ['a refusal whose code is a property every object has', { ok: false, code: 'toString', retry: true }],
    ['a refusal whose code is not text', { ok: false, code: 7, retry: true }],
    ['a refusal that does not say whether to retry', { ok: false, code: 'WrongPrice' }],
    ['a refusal whose message is not text', { ok: false, code: 'WrongPrice', retry: true, message: 7 }],
    ['a result that is not an object', { ...served, result: 'synthetic answer' }],
    ['a result without text', { ...served, result: { content: 7 } }],
    ['a receipt signature that is not text', { ...served, receiptSignature: 7 }],
    ['a budget index that is not whole', { ...served, budgetIndex: '0' }],
  ])('refuses a serve answer with %s', (_what, raw) => {
    expect(() => serveResponseFromWire(raw)).toThrow(WireError);
  });
});

describe('offers', () => {
  const wallet = ethers.Wallet.createRandom();
  const domain = requestDomain(31337, ethers.Wallet.createRandom().address);
  /** Signs as the chain adapter signs for a wallet it holds. */
  const holder = { signTypedDataAs: async (_address: string, d: ethers.TypedDataDomain, t: Record<string, ethers.TypedDataField[]>, v: Record<string, unknown>) => wallet.signTypedData(d, t, v) };
  const unsigned: Omit<ServiceOffer, 'signature'> = {
    seller: 7n, serviceId: serviceIdOf('urn:test:model:a'), serviceClass: SERVICE_CLASS_INFERENCE, unit: 'token', model: 'urn:test:model:a',
    provenance: 'weights-pinned', tokenizerBundle: 'test-bundle', capacity: 4, peerId: 'seller-peer', pricePerUnit: 10n ** 12n, priceEpoch: 663,
    nextPricePerUnit: 2n * 10n ** 12n, validUntilEpoch: 675, withdrawn: false, signedAt: 1_800_000_000,
  };
  let offer: ServiceOffer;
  beforeEach(async () => { offer = await signServiceOffer(holder, wallet.address, domain, unsigned); });
  /** The rows a query of these quads returns: each value as the store gives it back. */
  const rowsOf = (quads: ReturnType<typeof serviceOfferQuads>) => {
    const row: Record<string, string> = { offer: quads[0]!.subject };
    for (const q of quads) if (q.predicate.startsWith('https://dkg.network/marketplace#')) row[q.predicate.split('#')[1]!] = q.object;
    return [row];
  };

  it('go out as quads under a subject named after the signature, and come back as offers, through JSON too', () => {
    const quads = serviceOfferQuads(offer);
    expect(new Set(quads.map((q) => q.subject))).toEqual(new Set([`urn:dkg:marketplace:offer:${ethers.keccak256(offer.signature)}`]));
    expect(serviceOffersFromBindings(rowsOf(quads))).toEqual([offer]);
    expect(serviceOffersQuery()).toContain('<https://dkg.network/marketplace#ServiceOffer>');
    expect(serviceOffersQuery()).not.toContain('OPTIONAL');
    expect(serviceOfferFromWire(JSON.parse(JSON.stringify(serviceOfferToWire(offer))))).toEqual(offer);
  });

  it('carry a capacity, a tokenizer and a next price of none as 0 and the empty string, and a withdrawal', () => {
    const bare: ServiceOffer = { ...offer, capacity: null, provenance: 'upstream-claimed', withdrawn: true };
    delete bare.tokenizerBundle;
    delete bare.nextPricePerUnit;
    const quads = serviceOfferQuads(bare);
    const object = (name: string) => quads.find((q) => q.predicate.endsWith(`#${name}`))!.object;
    expect([object('capacity'), object('tokenizerBundle'), object('nextPricePerUnit'), object('withdrawn')]).toEqual(['"0"', '""', '"0"', '"true"']);
    expect(serviceOffersFromBindings(rowsOf(quads))).toEqual([bare]);
    expect(serviceOfferFromWire(serviceOfferToWire(bare))).toEqual(bare);
    expect(serviceOffersFromBindings([{ ...rowsOf(quads)[0], unit: '"query-unit"' }])).toEqual([]);
  });

  it('drop what does not hold together, and what is not signed', () => {
    const rows = rowsOf(serviceOfferQuads(offer));
    for (const change of [
      { serviceId: `"${serviceIdOf('urn:test:model:b')}"` }, { pricePerUnit: '"ten"' }, { pricePerUnit: '"0"' }, { nextPricePerUnit: '"01"' },
      { seller: '"0"' }, { capacity: '"four"' }, { provenance: '"self-reported"' }, { tokenizerBundle: undefined }, { peerId: '""' },
      { priceEpoch: '"next"' }, { validUntilEpoch: '"-1"' }, { withdrawn: '"maybe"' }, { signedAt: '"soon"' }, { signedAt: '"01"' },
      { signature: undefined }, { signature: '"unsigned"' }, { serviceClass: '"query"' },
    ]) {
      expect(serviceOffersFromBindings([{ ...rows[0], ...change } as Record<string, unknown>]), JSON.stringify(change)).toEqual([]);
    }
  });

  it('are signed over every field, and recover to their signer in their domain only', () => {
    expect(serviceOfferSignerOf(domain, offer)).toBe(wallet.address);
    expect(serviceOfferSignerOf(requestDomain(1, domain.verifyingContract), offer)).not.toBe(wallet.address);
    const tampered: Partial<Omit<ServiceOffer, 'signature'>>[] = [
      { seller: 8n }, { serviceId: serviceIdOf('urn:test:model:b') }, { serviceClass: 2 }, { unit: 'query-unit' as 'token' },
      { model: 'urn:test:model:b' }, { provenance: 'upstream-claimed' }, { tokenizerBundle: 'other-bundle' }, { tokenizerBundle: undefined },
      { capacity: null }, { capacity: 5 }, { peerId: 'other-peer' }, { pricePerUnit: 10n ** 12n + 1n }, { priceEpoch: 664 },
      { nextPricePerUnit: undefined }, { validUntilEpoch: 676 }, { withdrawn: true }, { signedAt: 1_800_000_001 },
    ];
    for (const change of tampered) expect(serviceOfferSignerOf(domain, { ...offer, ...change }), JSON.stringify(Object.keys(change))).not.toBe(wallet.address);
    // A signature that recovers to no one, and a field that does not fit its type.
    expect(serviceOfferSignerOf(domain, { ...offer, signature: '0x00' })).toBeNull();
    expect(serviceOfferSignerOf(domain, { ...offer, pricePerUnit: 1n << 96n })).toBeNull();
  });

  it('price each epoch by their schedule: the price from its epoch on, the next price after it, none past the last epoch or once withdrawn', () => {
    expect([662, 663, 664, 670, 675, 676].map((e) => offerPriceIn(offer, e))).toEqual([null, 10n ** 12n, 2n * 10n ** 12n, 2n * 10n ** 12n, 2n * 10n ** 12n, null]);
    const flat = { ...offer, nextPricePerUnit: undefined };
    expect([663, 664].map((e) => offerPriceIn(flat, e))).toEqual([10n ** 12n, 10n ** 12n]);
    expect(offerPriceIn({ ...offer, withdrawn: true }, 663)).toBeNull();
    // The schedule alone, its validity aside.
    expect(scheduledPrice({ ...offer, withdrawn: true }, 700)).toBe(2n * 10n ** 12n);
    expect(offerIn(offer, 664)).toEqual({
      seller: 7n, serviceId: offer.serviceId, serviceClass: SERVICE_CLASS_INFERENCE, unit: 'token', pricePerUnit: 2n * 10n ** 12n, epoch: 664, capacity: 4,
      model: 'urn:test:model:a', provenance: 'weights-pinned', tokenizerBundle: 'test-bundle', peerId: 'seller-peer', signedAt: offer.signedAt, signature: offer.signature,
    });
    expect(offerIn({ ...offer, tokenizerBundle: undefined }, 663)).not.toHaveProperty('tokenizerBundle');
    expect(offerIn(offer, 676)).toBeNull();
  });

  it('are routed by the newest a seller signed for a service, which a withdrawal or its last epoch ends', async () => {
    const signed = (over: Partial<Omit<ServiceOffer, 'signature'>>) => signServiceOffer(holder, wallet.address, domain, { ...unsigned, ...over });
    const router = (offers: ServiceOffer[]) => new Router({
      chain: {
        getMarketplaceContracts: async () => ({ requestDomain: domain }) as never,
        getIdentityIdForAddress: async (address) => (address === wallet.address ? 7n : 0n),
        isShardingTableMember: async () => true,
      },
      offers: async () => offers,
      quote: async () => { throw new Error('not asked'); },
    });
    // Withdrawn later: an older copy does not bring it back.
    const live = await signed({ signedAt: 1_800_000_000 });
    const withdrawn = await signed({ signedAt: 1_800_000_100, withdrawn: true });
    expect(await router([live, withdrawn]).offersOf([663])).toEqual([]);
    expect((await router([live]).offersOf([663, 664])).map((o) => [o.epoch, o.pricePerUnit])).toEqual([[663, 10n ** 12n], [664, 2n * 10n ** 12n]]);
    // Past its last epoch it prices nothing; a newer offer valid longer does.
    const longer = await signed({ signedAt: 1_800_000_200, validUntilEpoch: 690 });
    expect(await router([live]).offersOf([680])).toEqual([]);
    expect((await router([live, longer]).offersOf([680])).map((o) => o.signedAt)).toEqual([1_800_000_200]);
  });
});

describe('the OpenAI-compatible backend', () => {
  let server: Server;
  let base: string;
  let seen: { auth?: string; body?: Record<string, unknown>; path?: string };
  let reply: { status: number; body: unknown };

  beforeEach(async () => {
    seen = {};
    reply = { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'synthetic answer' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } };
    server = createServer(async (req: IncomingMessage, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      seen = { auth: req.headers.authorization, body: JSON.parse(text), path: req.url };
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterEach(async () => { await new Promise((resolve) => server.close(resolve)); });

  it('calls chat completions with the model and the token limit, and reads the counts', async () => {
    const backend = connectorOf({ kind: 'llamacpp', baseUrl: base, model: 'test-model' });
    expect(await backend.complete({ messages: [{ role: 'user', content: 'q' }], maxTokens: 7 }))
      .toEqual({ content: 'synthetic answer', promptTokens: 3, completionTokens: 2 });
    expect(seen.body).toMatchObject({ model: 'test-model', max_tokens: 7, stream: false });
    expect(seen.auth).toBeUndefined();
    expect(seen.path).toBe('/v1/chat/completions');
  });

  it('drops trailing slashes from the base URL', async () => {
    await connectorOf({ kind: 'llamacpp', baseUrl: `${base}///`, model: 'test-model' }).complete({ messages: [], maxTokens: 1 });
    expect(seen.path).toBe('/v1/chat/completions');
  });

  it("sends an upstream's key from its environment variable, and fails without text and counts", async () => {
    const key = `test-${randomBytes(8).toString('hex')}`;
    const env = 'MARKETPLACE_TEST_UPSTREAM_KEY';
    const backend = connectorOf({ kind: 'openai', baseUrl: base, model: 'test-model', apiKeyEnv: env });
    await expect(backend.complete({ messages: [], maxTokens: 1 })).rejects.toThrow(`${env} is not set`);
    process.env[env] = key;
    try {
      await backend.complete({ messages: [], maxTokens: 1 });
      expect(seen.auth).toBe(`Bearer ${key}`);
      reply = { status: 200, body: { choices: [{ message: { content: 'x' } }] } };
      await expect(backend.complete({ messages: [], maxTokens: 1 })).rejects.toThrow(UpstreamError);
      reply = { status: 500, body: {} };
      await expect(backend.complete({ messages: [], maxTokens: 1 })).rejects.toThrow('the backend answered 500');
    } finally {
      delete process.env[env];
    }
    expect(() => connectorOf({ kind: 'llamacpp', baseUrl: 'http://192.0.2.1:8080/v1', model: 'm' })).toThrow(/loopback only/);
  });
});

describe('the journal and the lock', () => {
  it('keeps what was appended, and skips a torn last line', async () => {
    const journal = new Journal<{ n: number }>(join(dir, 'sub', 'log.jsonl'));
    expect(await journal.read()).toEqual([]);
    await journal.append({ n: 1 });
    await journal.append({ n: 2 });
    await writeFile(journal.file, `${await readFile(journal.file, 'utf8')}{"n":`);
    expect(await journal.read()).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('runs calls under one key one at a time, in order, and others alongside', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const step = (name: string, ms: number) => async () => { await new Promise((r) => setTimeout(r, ms)); order.push(name); };
    await Promise.all([lock.run('a', step('a1', 20)), lock.run('a', step('a2', 1)), lock.run('b', step('b1', 5))]);
    expect(order).toEqual(['b1', 'a1', 'a2']);
    await expect(lock.run('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lock.run('a', async () => 'after')).toBe('after');
  });
});

describe("the seller's settings", () => {
  const service = { model: 'urn:test:model:a', pricePerUnit: '1000', backend: { kind: 'llamacpp' as const, baseUrl: 'http://127.0.0.1:8080/v1', model: 'm' } };

  it('are off unless enabled, and take their defaults', () => {
    expect(resolveSellerConfig(undefined)).toBeNull();
    expect(resolveSellerConfig({ seller: { services: [service] } })).toBeNull();
    expect(resolveSellerConfig({ contextGraphId: 'cg', seller: { enabled: true, services: [service] } })).toEqual({
      contextGraphId: 'cg', stopServingSeconds: 180, tickSeconds: 300, landing: DEFAULT_LANDING,
      // A llama.cpp backend takes no tool calls unless the settings say it does.
      services: [{ model: 'urn:test:model:a', serviceId: serviceIdOf('urn:test:model:a'), pricePerUnit: 1000n, capacity: null, provenance: 'weights-pinned', tools: false, backend: service.backend }],
    });
    const landing = { landingIntervalMinutes: 60, finalLandingSeconds: 0, nearLimitShare: 0, baseFeeCeilingGwei: 0.5, lastStretchBaseFeeCeilingGwei: 2 };
    expect(resolveSellerConfig({ seller: { enabled: true, services: [service], landing } })!.landing).toEqual({
      ...DEFAULT_LANDING, landingIntervalMinutes: 60, finalLandingSeconds: 0, nearLimitShare: 0, baseFeeCeiling: 500_000_000n, lastStretchBaseFeeCeiling: 2_000_000_000n,
    });
  });

  it.each([
    [{ services: [] }, /at least one service/],
    [{ services: [{ ...service, model: '' }] }, /model's URN/],
    [{ services: [service, service] }, /listed twice/],
    [{ services: [{ ...service, pricePerUnit: '0' }] }, /above 0/],
    [{ services: [{ ...service, capacity: 0 }] }, /capacity/],
    [{ services: [{ ...service, backend: { ...service.backend, kind: 'unknown-kind' } }] }, /openai or llamacpp/],
    [{ services: [{ ...service, backend: { ...service.backend, apiKeyEnv: 'lower' } }] }, /environment variable/],
    [{ services: [service], stopServingSeconds: -1 }, /stopServingSeconds/],
    [{ services: [service], tickSeconds: 0 }, /tickSeconds/],
    [{ services: [{ ...service, backend: { ...service.backend, baseUrl: 'not a url' } }] }, /baseUrl/],
    [{ services: [{ ...service, backend: { ...service.backend, model: '' } }] }, /backend's model/],
    [{ services: [{ ...service, pricePerUnit: 5 }] }, /pricePerUnit/],
    [{ services: [service], landing: { landingIntervalMinutes: 0 } }, /landingIntervalMinutes must be a whole number of at least 1/],
    [{ services: [service], landing: { maxFaultDrops: 1.5 } }, /maxFaultDrops/],
    [{ services: [service], landing: { nearLimitShare: 2 } }, /nearLimitShare must be a share from 0 to 1/],
    [{ services: [service], landing: { baseFeeCeilingGwei: 0 } }, /baseFeeCeilingGwei must be a positive number of gwei/],
  ])('refuses %j', (seller, message) => {
    expect(() => resolveSellerConfig({ seller: { enabled: true, ...seller } as never })).toThrow(message);
  });
});
