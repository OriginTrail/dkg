// SPDX-License-Identifier: Apache-2.0
/**
 * The parts the seller is built from: the wire's checks, offers in and out of
 * shared memory, the OpenAI-compatible backend against a stub on loopback, the
 * journal and the per-key lock, and the seller's settings.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SERVICE_CLASS_INFERENCE } from '@origintrail-official/dkg-chain';
import {
  Journal,
  KeyedLock,
  UpstreamError,
  WireError,
  connectorOf,
  decodeMessage,
  encodeMessage,
  inferenceBodyFromWire,
  offerQuads,
  offersFromBindings,
  offersQuery,
  quoteRequestFromWire,
  receiptFromWire,
  receiptToWire,
  requestFromWire,
  resolveSellerConfig,
  serviceIdOf,
  type Offer,
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
});

describe('offers', () => {
  const offer: Offer = {
    seller: 7n, serviceId: serviceIdOf('urn:test:model:a'), serviceClass: SERVICE_CLASS_INFERENCE, unit: 'token', pricePerUnit: 10n ** 12n,
    epoch: 663, capacity: 4, model: 'urn:test:model:a', provenance: 'weights-pinned', tokenizerBundle: 'test-bundle',
  };
  /** The rows a query of these quads returns: each value as the store gives it back. */
  const rowsOf = (quads: ReturnType<typeof offerQuads>) => {
    const row: Record<string, string> = { offer: quads[0]!.subject };
    for (const q of quads) if (q.predicate.startsWith('https://dkg.network/marketplace#')) row[q.predicate.split('#')[1]!] = q.object;
    return [row];
  };

  it('go out as quads with one subject per seller, service and epoch, and come back as offers', () => {
    const quads = offerQuads(offer);
    expect(new Set(quads.map((q) => q.subject))).toEqual(new Set([`urn:dkg:marketplace:offer:7:${offer.serviceId}:663`]));
    expect(offersFromBindings(rowsOf(quads))).toEqual([offer]);
    expect(offersQuery([663, 664])).toContain('VALUES ?epoch { "663" "664" }');
  });

  it('drop what does not hold together', () => {
    const rows = rowsOf(offerQuads(offer));
    expect(offersFromBindings([{ ...rows[0], serviceId: `"${serviceIdOf('urn:test:model:b')}"` }])).toEqual([]);
    expect(offersFromBindings([{ ...rows[0], pricePerUnit: '"ten"' }])).toEqual([]);
    expect(offersFromBindings([{ ...rows[0], seller: '"0"' }])).toEqual([]);
    expect(offersFromBindings([{ ...rows[0], capacity: undefined as unknown as string }])[0]!.capacity).toBeNull();
  });
});

describe('the OpenAI-compatible backend', () => {
  let server: Server;
  let base: string;
  let seen: { auth?: string; body?: Record<string, unknown> };
  let reply: { status: number; body: unknown };

  beforeEach(async () => {
    seen = {};
    reply = { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'synthetic answer' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } };
    server = createServer(async (req: IncomingMessage, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      seen = { auth: req.headers.authorization, body: JSON.parse(text) };
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
      contextGraphId: 'cg', stopServingSeconds: 180, tickSeconds: 300,
      services: [{ model: 'urn:test:model:a', serviceId: serviceIdOf('urn:test:model:a'), pricePerUnit: 1000n, capacity: null, provenance: 'weights-pinned', backend: service.backend }],
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
  ])('refuses %j', (seller, message) => {
    expect(() => resolveSellerConfig({ seller: { enabled: true, ...seller } as never })).toThrow(message);
  });
});
