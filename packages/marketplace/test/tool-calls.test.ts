// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAI tool calls through the marketplace, and what came with them: the
 * wire's tools, tool calls and tool results, and its bounds; a text call
 * encoded, counted and committed as 10.1.0 did; the seller's quote saying it
 * takes tools; the router and gateway sending a call with tools only to such
 * a seller, and refusing it before anything is signed when none is; the
 * backend sending tools and reading the calls back; the receipt committing to
 * the calls; an answer its backend stopped short returning text alone; a call
 * kept across the seller's restart; the usage split; and access keys' 64-bit
 * ids. The router's choice among sellers that take tools and sellers that do
 * not is in gateway-router.test.ts.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, marketplaceChainOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import {
  AccessKeys,
  Buyer,
  BuyerStore,
  Gateway,
  Router,
  Seller,
  SellerLedger,
  UpstreamError,
  WireError,
  connectorOf,
  decodeMessage,
  encodeMessage,
  inferenceBodyFromWire,
  quoteResponseFromWire,
  resultBytesOf,
  resultCommitmentOf,
  serveResponseFromWire,
  serviceIdOf,
  signServiceOffer,
  unitsBound,
  usesTools,
  type AccessKey,
  type ChatMessage,
  type Completion,
  type CompletionCall,
  type Connector,
  type GatewayAnswer,
  type ServeResponse,
  type ServiceOffer,
  type ToolCalls,
  type ToolSpec,
} from '../src/index.js';
import { UNITS_FOR_TOOLS, UNITS_PER_CALL, UNITS_PER_MESSAGE, UNITS_PER_TOOL, inputUnitsBound } from '../src/seller-bounds.js';

const NODE = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const MODEL = 'urn:test:model:tools';
const SERVICE = serviceIdOf(MODEL);
const PRICE = 10n;
// Valid fixtures, typed by the contracts they keep; the malformed inputs the decoders refuse are written where they are used.
const QUESTION = { role: 'user', content: 'synthetic question' } satisfies ChatMessage;
const CHAT = { model: MODEL, messages: [QUESTION], max_tokens: 20 };
const TOOLS = [{ type: 'function', function: { name: 'list_deployments', description: 'Lists deployments', parameters: { type: 'object', properties: {} } } }] satisfies ToolSpec[];
const CALLS = [{ id: 'call_1', type: 'function', function: { name: 'list_deployments', arguments: '{}' } }] satisfies ToolCalls;
const TURN = [QUESTION, { role: 'assistant', content: null, tool_calls: CALLS }, { role: 'tool', tool_call_id: 'call_1', content: '[]' }] satisfies ChatMessage[];

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'marketplace-tools-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the wire, with tools', () => {
  it('encodes a call without tools as 10.1.0 did: { messages, max_tokens }, messages { role, content }', () => {
    const body = inferenceBodyFromWire({
      messages: [{ role: 'system', content: 's', name: 'dropped' }, QUESTION, { role: 'assistant', content: 'a', tool_calls: [] }],
      max_tokens: 5, tools: [], tool_choice: 'auto', parallel_tool_calls: true,
    });
    expect(new TextDecoder().decode(encodeMessage(body)))
      .toBe('{"messages":[{"role":"system","content":"s"},{"role":"user","content":"synthetic question"},{"role":"assistant","content":"a"}],"max_tokens":5}');
    expect(usesTools(body)).toBe(false);
  });

  it('takes tools, tool_choice, parallel_tool_calls, tool calls and the results that answer them', () => {
    const body = inferenceBodyFromWire({ messages: TURN, max_tokens: 5, tools: TOOLS, tool_choice: { type: 'function', function: { name: 'list_deployments' } }, parallel_tool_calls: false });
    expect(body).toEqual({ messages: TURN, max_tokens: 5, tools: TOOLS, tool_choice: { type: 'function', function: { name: 'list_deployments' } }, parallel_tool_calls: false });
    expect(usesTools(body)).toBe(true);
    // The last call of a turn may carry the calls and their results and no tools: it still needs a seller that takes them.
    const last = inferenceBodyFromWire({ messages: TURN, max_tokens: 5, tool_choice: 'none' });
    expect(last).toEqual({ messages: TURN, max_tokens: 5 });
    expect(usesTools(last)).toBe(true);
    // A call missing `type`, as some clients send its history, is a function call.
    expect(inferenceBodyFromWire({ messages: [QUESTION, { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] }], max_tokens: 1 }).messages[1])
      .toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] });
  });

  it.each([
    ['a result that answers no call before it', { messages: [QUESTION, { role: 'tool', tool_call_id: 'call_1', content: '[]' }], max_tokens: 5 }],
    ['a result with no id', { messages: [...TURN.slice(0, 2), { role: 'tool', content: '[]' }], max_tokens: 5 }],
    ['a result that is not text', { messages: [...TURN.slice(0, 2), { role: 'tool', tool_call_id: 'call_1', content: { rows: [] } }], max_tokens: 5 }],
    ['a call whose arguments are not text', { messages: [QUESTION, { role: 'assistant', tool_calls: [{ ...CALLS[0], function: { name: 'f', arguments: {} } }] }], max_tokens: 5 }],
    ['a call with a name OpenAI does not take', { messages: [QUESTION, { role: 'assistant', tool_calls: [{ ...CALLS[0], function: { name: 'no spaces', arguments: '{}' } }] }], max_tokens: 5 }],
    ['an assistant whose content is neither text nor null', { messages: [QUESTION, { role: 'assistant', content: 7, tool_calls: CALLS }], max_tokens: 5 }],
    ['a tool listed twice', { messages: [QUESTION], max_tokens: 5, tools: [TOOLS[0], TOOLS[0]] }],
    ['a tool that is not a function', { messages: [QUESTION], max_tokens: 5, tools: [{ type: 'retrieval' }] }],
    ['parameters that are not an object', { messages: [QUESTION], max_tokens: 5, tools: [{ type: 'function', function: { name: 'f', parameters: 'schema' } }] }],
    ['too many tools', { messages: [QUESTION], max_tokens: 5, tools: Array.from({ length: 129 }, (_, i) => ({ type: 'function', function: { name: `f${i}` } })) }],
    ['a tool_choice of a function the call has not', { messages: [QUESTION], max_tokens: 5, tools: TOOLS, tool_choice: { type: 'function', function: { name: 'other' } } }],
    ['a tool_choice the wire does not know', { messages: [QUESTION], max_tokens: 5, tools: TOOLS, tool_choice: 'always' }],
    ['a parallel_tool_calls that is not true or false', { messages: [QUESTION], max_tokens: 5, tools: TOOLS, parallel_tool_calls: 'yes' }],
  ])('refuses a body with %s', (_what, raw) => {
    expect(() => inferenceBodyFromWire(raw)).toThrow(WireError);
  });

  it('commits to a text result as 10.1.0 did, and to a result with tool calls by bytes no text has', () => {
    expect(resultCommitmentOf({ content: 'answer' })).toBe(ethers.keccak256(ethers.toUtf8Bytes('answer')));
    expect(resultCommitmentOf({ content: 'answer', finish_reason: 'length' })).toBe(resultCommitmentOf('answer'));
    const calls = resultBytesOf({ content: null, tool_calls: CALLS });
    expect(calls[0]).toBe(0xff);
    expect(new TextDecoder().decode(calls.subarray(1))).toBe('[null,[["call_1","function","list_deployments","{}"]]]');
    // A text that reads as the calls' JSON is not the calls.
    expect(resultCommitmentOf(new TextDecoder().decode(calls.subarray(1)))).not.toBe(resultCommitmentOf({ content: null, tool_calls: CALLS }));
    // Every part of a call is committed to.
    const other = [{ ...CALLS[0], function: { name: 'list_deployments', arguments: '{"all":true}' } }] satisfies ToolCalls;
    expect(resultCommitmentOf({ content: null, tool_calls: other })).not.toBe(resultCommitmentOf({ content: null, tool_calls: CALLS }));
  });

  const served = { ok: true, result: { content: null, tool_calls: CALLS, finish_reason: 'tool_calls' }, receipt: {}, receiptSignature: '0x00', budgetIndex: 0 };

  it("reads a seller's answer with tool calls and its usage, and drops what is not signed and does not read", () => {
    expect(serveResponseFromWire({ ...served, usage: { promptTokens: 40, completionTokens: 9 } }))
      .toEqual({ ...served, usage: { promptTokens: 40, completionTokens: 9 } });
    expect(serveResponseFromWire({ ...served, usage: { promptTokens: -1, completionTokens: 9 } })).toEqual(served);
    expect(serveResponseFromWire({ ...served, result: { ...served.result, finish_reason: 'function_call' } }))
      .toEqual({ ...served, result: { content: null, tool_calls: CALLS } });
    expect(() => serveResponseFromWire({ ...served, result: { content: null } })).toThrow(WireError);
    expect(() => serveResponseFromWire({ ...served, result: { content: null, tool_calls: [{ id: 'c' }] } })).toThrow(WireError);
  });

  it("reads a quote's tools: true only when it says true", () => {
    const offer = { serviceId: SERVICE, pricePerUnit: '10', available: true, capacity: null };
    expect(quoteResponseFromWire({ seller: '7', epoch: 1, offers: [{ ...offer, tools: true }] }).offers[0]!.tools).toBe(true);
    for (const tools of [undefined, false, 'yes']) {
      expect(quoteResponseFromWire({ seller: '7', epoch: 1, offers: [{ ...offer, tools }] }).offers[0]).not.toHaveProperty('tools');
    }
  });

  it("counts a text call's units as 10.1.0 did, and a call's tools, tool calls and results' ids besides", () => {
    const text = inferenceBodyFromWire({ messages: [QUESTION], max_tokens: 20 });
    expect(inputUnitsBound(text)).toBe(BigInt(UNITS_PER_CALL + 18 + UNITS_PER_MESSAGE));
    expect(unitsBound(text)).toBe(BigInt(UNITS_PER_CALL + 18 + UNITS_PER_MESSAGE + 20));
    const tools = inferenceBodyFromWire({ messages: TURN, max_tokens: 20, tools: TOOLS, tool_choice: 'required' });
    const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
    expect(inputUnitsBound(tools)).toBe(BigInt(
      UNITS_PER_CALL + 3 * UNITS_PER_MESSAGE + 18 + bytes(CALLS) + 2 + 'call_1'.length
        + UNITS_FOR_TOOLS + UNITS_PER_TOOL + bytes(TOOLS) + bytes('required'),
    ));
  });
});

describe('access keys', () => {
  const SCOPES = { label: 'agent', budget: 100n, services: null, rps: 5, expiresAt: null };

  it('have 64-bit ids, and a key whose id is taken is made again', async () => {
    const draws = [Buffer.alloc(24, 1), Buffer.alloc(24, 1), Buffer.alloc(24, 2)];
    const keys = new AccessKeys(dir, undefined, () => draws.shift()!);
    const first = await keys.make(SCOPES, 0);
    expect(first.key.keyId).toBe(`dkgmk_${'01'.repeat(8)}`);
    const second = await keys.make(SCOPES, 0);
    expect(second.key.keyId).toBe(`dkgmk_${'02'.repeat(8)}`);
    expect(await keys.check(first.secret, 1)).toMatchObject({ ok: true, key: { keyId: first.key.keyId } });
    expect(await keys.check(second.secret, 1)).toMatchObject({ ok: true, key: { keyId: second.key.keyId } });
    // A source that never gives another id gives up, and makes nothing.
    const stuck = new AccessKeys(dir, undefined, () => Buffer.alloc(24, 1));
    await expect(stuck.make(SCOPES, 0)).rejects.toThrow(/no key id of its own/);
    expect(await stuck.list()).toHaveLength(2);
  });

  it("keep 10.1.0's 8-digit keys: checked, listed and revoked by their ids", async () => {
    const secret = `dkgmk_${'ab'.repeat(24)}`;
    const make = {
      type: 'make', keyId: secret.slice(0, 14), hash: createHash('sha256').update(secret).digest('hex'),
      label: 'old', budget: '100', services: null, rps: 5, expiresAt: null, at: 1,
    };
    await writeFile(join(dir, 'access-keys.jsonl'), `${JSON.stringify(make)}\n`);
    const keys = new AccessKeys(dir);
    expect(await keys.check(secret, 2)).toMatchObject({ ok: true, key: { keyId: 'dkgmk_abababab' } });
    expect((await keys.make(SCOPES, 2)).key.keyId).toMatch(/^dkgmk_[0-9a-f]{16}$/);
    expect(await keys.revoke('dkgmk_abababab', 3)).toMatchObject({ keyId: 'dkgmk_abababab', revoked: true });
    expect(await keys.check(secret, 4)).toMatchObject({ ok: false, code: 'revoked_key' });
  });
});

describe('the OpenAI-compatible backend, with tools', () => {
  let server: Server;
  let base: string;
  let seen: Record<string, unknown> | undefined;
  let reply: unknown;

  beforeEach(async () => {
    seen = undefined;
    reply = {
      choices: [{ message: { role: 'assistant', content: null, tool_calls: CALLS }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 40, completion_tokens: 9 },
    };
    server = createServer(async (req: IncomingMessage, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      seen = JSON.parse(text);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterEach(async () => { await new Promise((resolve) => server.close(resolve)); });

  it('sends the tools, tool_choice and parallel_tool_calls, and reads the tool calls back', async () => {
    const backend = connectorOf({ kind: 'openai', baseUrl: base, model: 'test-model' });
    const body = inferenceBodyFromWire({ messages: TURN, max_tokens: 7, tools: TOOLS, tool_choice: 'auto', parallel_tool_calls: false });
    expect(await backend.complete({ messages: body.messages, maxTokens: 7, tools: body.tools, toolChoice: 'auto', parallelToolCalls: false }))
      .toEqual({ content: null, tool_calls: CALLS, promptTokens: 40, completionTokens: 9 });
    expect(seen).toEqual({
      model: 'test-model', messages: TURN, max_tokens: 7, temperature: 0, stream: false, tools: TOOLS, tool_choice: 'auto', parallel_tool_calls: false,
    });
  });

  it('sends a call without tools as before, and says when the backend stopped at the length', async () => {
    reply = { choices: [{ message: { role: 'assistant', content: 'cut' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 7 } };
    const backend = connectorOf({ kind: 'openai', baseUrl: base, model: 'test-model' });
    expect(await backend.complete({ messages: [{ role: 'user', content: 'q' }], maxTokens: 7 }))
      .toEqual({ content: 'cut', finishReason: 'length', promptTokens: 3, completionTokens: 7 });
    expect(Object.keys(seen!)).toEqual(['model', 'messages', 'max_tokens', 'temperature', 'stream']);
  });

  it('fails, as nothing served, on tool calls that are not shaped as calls', async () => {
    reply = { choices: [{ message: { content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
    const backend = connectorOf({ kind: 'openai', baseUrl: base, model: 'test-model' });
    await expect(backend.complete({ messages: [{ role: 'user', content: 'q' }], maxTokens: 7, tools: TOOLS })).rejects.toThrow(UpstreamError);
  });
});

describe('a call with tools through the gateway', () => {
  let mock: MockChainAdapter;
  let chain: MarketplaceChainAdapter;
  let seller: Seller;
  let gateway: Gateway;
  let keys: AccessKeys;
  let caller: { key: AccessKey };
  let completion: Completion;
  let seen: CompletionCall[];
  let payloads: string[];
  let answers: ServeResponse[];
  let tamper: ((answer: ServeResponse) => ServeResponse) | undefined;
  let quoteTools: boolean | undefined;

  const backend: Connector = { kind: 'openai', complete: async (c) => { seen.push(c); return completion; } };
  const body = (a: GatewayAnswer) => a.body as any;
  const call = (chat: unknown = CHAT) => gateway.chatCompletion(caller, chat);

  /** The seller, on its directory: a second one there is the first restarted. */
  const sellerOf = (tools: boolean) => new Seller({
    chain, dir: join(dir, 'seller'), signer: NODE.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
    services: [{ model: MODEL, serviceId: SERVICE, pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed', connector: backend, tools }],
  });

  /** Buyer and seller on one mock chain, as gateway.test.ts sets them up; `tools` is whether the seller's service takes them. */
  async function setUp(tools: boolean): Promise<void> {
    mock = new MockChainAdapter('mock:31337', NODE.address);
    mock.setMockACKSigner(NODE);
    chain = marketplaceChainOf(mock)!;
    await mock.ensureProfile();
    const buyer = new Buyer({ chain, store: new BuyerStore(join(dir, 'buyer')), config: { enabled: true, buyerWallet: NODE.address, prefundLeadSeconds: 7_200, tickSeconds: 300 } });
    const { epoch } = await chain.getEpochTimes();
    await buyer.fund({ epoch, source: { kind: 'wallet' }, services: [{ serviceId: SERVICE, serviceClass: 1, value: 10n ** 6n, maxPricePerUnit: 100n }] });
    seller = sellerOf(tools);
    await seller.load();
    await seller.tick();
    const domain = (await chain.getMarketplaceContracts()).requestDomain;
    const offers: ServiceOffer[] = [await signServiceOffer(chain, NODE.address, domain, {
      seller: seller.gate.identityId, serviceId: SERVICE, serviceClass: 1, unit: 'token', model: MODEL, provenance: 'upstream-claimed',
      capacity: null, peerId: 'seller-peer', pricePerUnit: PRICE, priceEpoch: epoch, validUntilEpoch: epoch + 12, withdrawn: false, signedAt: 1,
    })];
    const router = new Router({
      chain,
      offers: async () => offers,
      quote: async (_peer, services) => {
        const quote = await seller.quote({ services });
        // A quote that says more than its seller takes, to reach the seller's own guard.
        return quoteTools === undefined ? quote : { ...quote, offers: quote.offers.map((o) => ({ ...o, tools: quoteTools })) };
      },
    });
    keys = new AccessKeys(join(dir, 'buyer'));
    gateway = new Gateway({
      chain, buyerWallet: NODE.address, store: buyer.store, router, keys, dir: join(dir, 'buyer'),
      send: async (_peer, payload) => {
        payloads.push(new TextDecoder().decode(payload));
        const answer = await seller.serve(decodeMessage(payload), 'buyer-peer');
        answers.push(answer);
        return encodeMessage(tamper ? tamper(answer) : answer);
      },
      modelOf: async () => MODEL,
    });
    await gateway.load();
    caller = { key: (await keys.make({ label: 'test-agent', budget: 10n ** 30n, services: null, rps: 1_000, expiresAt: null }, 0)).key };
  }

  beforeEach(() => {
    seen = [];
    payloads = [];
    answers = [];
    tamper = undefined;
    quoteTools = undefined;
    completion = { content: null, tool_calls: CALLS, promptTokens: 40, completionTokens: 9 };
  });

  it("goes to a seller whose quote says it takes them, and the model's calls come back, committed to, with the usage split", async () => {
    await setUp(true);
    const answer = await call({ ...CHAT, tools: TOOLS, tool_choice: 'auto', parallel_tool_calls: false });
    expect(answer.status).toBe(200);
    expect(body(answer).choices).toEqual([{ index: 0, message: { role: 'assistant', content: null, tool_calls: CALLS }, finish_reason: 'tool_calls' }]);
    expect(body(answer).usage).toEqual({ prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 });
    expect(seen[0]).toMatchObject({ tools: TOOLS, toolChoice: 'auto', parallelToolCalls: false });
    // The seller's ledger keeps the calls and the split, which a repeat of the call is answered with.
    const ledger = await readFile(join(dir, 'seller', 'seller-ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"tool_calls":[{"id":"call_1"');
    expect(ledger).toContain('"usage":{"promptTokens":40,"completionTokens":9}');

    // The turn's next call carries the results back, and the model answers in text.
    completion = { content: 'No deployments.', promptTokens: 60, completionTokens: 4 };
    const next = await call({ ...CHAT, messages: TURN, tools: TOOLS });
    expect(next.status).toBe(200);
    expect(body(next).choices).toEqual([{ index: 0, message: { role: 'assistant', content: 'No deployments.' }, finish_reason: 'stop' }]);
    expect(seen[1]!.messages).toEqual(TURN);
  });

  it('is refused before anything is signed or sent when no seller that serves takes tools, and a text call still goes', async () => {
    await setUp(false);
    for (const chat of [{ ...CHAT, tools: TOOLS }, { ...CHAT, messages: TURN }]) {
      const answer = await call(chat);
      expect(answer.status).toBe(400);
      expect(body(answer).error).toMatchObject({ code: 'tools_unsupported' });
    }
    expect(payloads).toEqual([]);
    expect(keys.reservedOf(caller.key.keyId)).toBe(0n);
    completion = { content: 'synthetic answer', promptTokens: 7, completionTokens: 5 };
    expect((await call()).status).toBe(200);
  });

  it('sends a text call as 10.1.0 did: its body and its units', async () => {
    await setUp(true);
    completion = { content: 'synthetic answer', promptTokens: 7, completionTokens: 5 };
    const answer = await call();
    expect(answer.status).toBe(200);
    expect(body(answer).choices).toEqual([{ index: 0, message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' }]);
    expect(payloads[0]).toContain('"body":{"messages":[{"role":"user","content":"synthetic question"}],"max_tokens":20}');
    expect(JSON.parse(payloads[0]!).request.maxUnits).toBe(String(UNITS_PER_CALL + 18 + UNITS_PER_MESSAGE + 20));
    expect(seen[0]).toEqual({ messages: [QUESTION], maxTokens: 20 });
  });

  it("is refused by a seller whose service takes no tools, whatever its quote says", async () => {
    await setUp(false);
    quoteTools = true;
    const answer = await call({ ...CHAT, tools: TOOLS });
    expect(answer.status).toBe(502);
    expect(body(answer)).toMatchObject({ sellerCode: 'BadRequest' });
    expect(seen).toEqual([]);
  });

  it('reports the total alone when the split does not add up, and fails a receipt whose calls were changed', async () => {
    await setUp(true);
    tamper = (a) => (a.ok ? { ...a, usage: { promptTokens: 1, completionTokens: 1 } } : a);
    const total = await call({ ...CHAT, tools: TOOLS });
    expect(total.status).toBe(200);
    expect(body(total).usage).toEqual({ total_tokens: 49 });
    const changedCalls = [{ ...CALLS[0], function: { name: 'list_deployments', arguments: '{"all":true}' } }] satisfies ToolCalls;
    tamper = (a) => (a.ok ? { ...a, result: { content: a.result.content, tool_calls: changedCalls } } : a);
    const changed = await call({ ...CHAT, tools: TOOLS });
    expect(changed.status).toBe(502);
    expect(body(changed)).toMatchObject({ error: { code: 'bad_receipt' }, problem: 'result_mismatch' });
  });

  it('answers with text alone when the backend stopped before the end, keeping its reason: its calls may be cut short', async () => {
    await setUp(true);
    // The backend reached its token limit inside a call's arguments.
    completion = {
      content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_deployments', arguments: '{"id":' } }],
      finishReason: 'length', promptTokens: 40, completionTokens: 20,
    };
    const cut = await call({ ...CHAT, tools: TOOLS });
    expect(cut.status).toBe(200);
    expect(body(cut).choices).toEqual([{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }]);
    completion = { content: 'filtered', tool_calls: CALLS, finishReason: 'content_filter', promptTokens: 40, completionTokens: 5 };
    expect(body(await call({ ...CHAT, tools: TOOLS })).choices).toEqual([{ index: 0, message: { role: 'assistant', content: 'filtered' }, finish_reason: 'content_filter' }]);
    // A backend that finished returns its calls whole.
    completion = { content: null, tool_calls: CALLS, promptTokens: 40, completionTokens: 9 };
    expect(body(await call({ ...CHAT, tools: TOOLS })).choices[0].message.tool_calls).toEqual(CALLS);
  });

  it('keeps the calls of a completion whose backend says it stopped for them, or stopped: signed and checked', async () => {
    await setUp(true);
    for (const finishReason of ['tool_calls', 'stop'] as const) {
      completion = { content: null, tool_calls: CALLS, finishReason, promptTokens: 40, completionTokens: 9 };
      const answer = await call({ ...CHAT, tools: TOOLS });
      // A 200 is a receipt the buyer checked: its seller's signature, over a commitment to these calls.
      expect(answer.status).toBe(200);
      expect(body(answer).choices).toEqual([{ index: 0, message: { role: 'assistant', content: null, tool_calls: CALLS }, finish_reason: 'tool_calls' }]);
      const served = answers.at(-1) as { ok: true; result: unknown; receipt: { resultCommitment: string } };
      expect(served.result).toEqual({ content: null, tool_calls: CALLS, finish_reason: 'tool_calls' });
      expect(served.receipt.resultCommitment).toBe(resultCommitmentOf({ content: null, tool_calls: CALLS }));
    }
  });

  it('keeps a call with tool calls across the seller\'s restart: a repeat gets the same answer, with no backend call, and its nonce and value stay counted', async () => {
    await setUp(true);
    expect((await call({ ...CHAT, tools: TOOLS })).status).toBe(200);
    const sent = JSON.parse(payloads[0]!);
    const { subscriptionId, nonce } = sent.request;
    const restarted = sellerOf(true);
    await restarted.load();
    await restarted.tick();
    expect(await restarted.serve(sent, 'buyer-peer')).toEqual(answers[0]);
    expect(answers[0]).toMatchObject({ ok: true, result: { content: null, tool_calls: CALLS, finish_reason: 'tool_calls' }, usage: { promptTokens: 40, completionTokens: 9 } });
    expect(seen).toHaveLength(1);
    expect(restarted.ledger.nonceUsed(subscriptionId, nonce)).toBe(true);
    expect(restarted.ledger.unlanded(subscriptionId, 0)).toBe(seller.ledger.unlanded(subscriptionId, 0));
    expect(restarted.ledger.unlanded(subscriptionId, 0)).toBe(49n * PRICE);
  });

  it('holds what it reads back as the wire decodes it: a kept result whose tool_calls is null holds none', async () => {
    await setUp(true);
    completion = { content: 'text', promptTokens: 7, completionTokens: 5 };
    expect((await call()).status).toBe(200);
    const file = join(dir, 'seller', 'seller-ledger.jsonl');
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const served = lines.find((e) => e.type === 'served');
    served.result.tool_calls = null;
    await writeFile(file, `${lines.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const restarted = sellerOf(true);
    await restarted.load();
    expect(restarted.ledger.served(served.requestDigest)!.result).toStrictEqual({ content: 'text' });
  });

  it('keeps a result read back the same shape across a prune: decoded on the way in, at the load and at the prune alike', async () => {
    const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
    const line = (n: number, epoch: number, result: unknown) => ({
      type: 'served', requestDigest: id(n), subscriptionId: id(100 + epoch), budgetIndex: 0, epoch,
      request: { subscriptionId: id(100 + epoch), serviceId: SERVICE, seller: '1', nonce: String(n), pricePerUnit: '10', maxUnits: '100', maxValueWei: '1000', issuedAt: 1, expiry: 2 },
      signature: `0x${'11'.repeat(64)}`,
      receipt: { requestDigest: id(n), resultCommitment: id(200 + n), units: '12', valueWei: '120', completedAt: 1 },
      receiptSignature: `0x${'22'.repeat(65)}`, result, peerId: 'buyer-peer',
    });
    const file = join(dir, 'seller-ledger.jsonl');
    // Epoch 1 ends and is pruned; epoch 5's result has a `tool_calls: null`, which is none.
    await writeFile(file, `${[line(1, 1, { content: 'old' }), line(2, 5, { content: 'text', tool_calls: null })].map((e) => JSON.stringify(e)).join('\n')}\n`);
    const ledger = new SellerLedger(dir);
    await ledger.load();
    expect(ledger.served(id(2))!.result).toStrictEqual({ content: 'text' });
    await ledger.prune(3);
    expect(ledger.served(id(1))).toBeUndefined();
    expect(ledger.served(id(2))!.result).toStrictEqual({ content: 'text' });
    // Written again as it is held, and read back so.
    expect(await readFile(file, 'utf8')).not.toContain('tool_calls');
    const reread = new SellerLedger(dir);
    await reread.load();
    expect(reread.served(id(2))!.result).toStrictEqual({ content: 'text' });
  });

  it('answers a completion over its units with its text cut short, and no tool calls', async () => {
    await setUp(true);
    // More output than the call's units leave: the seller cuts it, and a cut tool call is no call.
    completion = { content: 'partial text', tool_calls: CALLS, promptTokens: 40, completionTokens: 10_000 };
    const answer = await call({ ...CHAT, tools: TOOLS });
    expect(answer.status).toBe(200);
    const choice = body(answer).choices[0];
    expect(choice.finish_reason).toBe('length');
    expect(choice.message).not.toHaveProperty('tool_calls');
  });
});
