// SPDX-License-Identifier: Apache-2.0
/**
 * A seller whose backend refuses a call, and the buyer that sent it, against
 * MockChainAdapter with the real seller in the same process as the far end and
 * its real connectors, over a stubbed `fetch`. One seller sells two services,
 * each on its own backend model:
 *   - a refusal about the call itself (400, 404, 413, 415, 422) is
 *     `BadRequest`, not to retry: the buyer tries other sellers first, and
 *     still routes the seller's other service to it;
 *   - no answer, a timeout, and 401, 403, 408, 409, 429 and 5xx are
 *     `UpstreamError`, to retry, as before: the buyer leaves the seller out of
 *     every service for ten minutes;
 *   - when the backend refuses a call with tools (400 or 422) and has shown
 *     nothing of tools, the seller checks with minimal calls with tools of its
 *     own, the model's choice and then the function named: both refused, the
 *     service stops saying it takes tools until the node restarts, so the
 *     buyer answers its calls with tools itself, and they hold nothing; either
 *     served, the refusal was that call's own, and a backend that takes named
 *     calls alone keeps them. A service whose backend has served a call with
 *     tools keeps them, unchecked.
 * The service backend itself (seller-backend.ts) is driven by hand at the end,
 * through `complete`: a refused call answered within its time limit however
 * long the check takes, on a fake clock; a buyer's call with tools served
 * while a check is out; one check at a time; and a check asked again after one
 * that said nothing.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, marketplaceChainOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import {
  AccessKeys,
  Buyer,
  BuyerStore,
  Gateway,
  MAX_UNSETTLED_PER_SELLER,
  Router,
  Seller,
  UpstreamError,
  connectorOf,
  decodeMessage,
  encodeMessage,
  serviceIdOf,
  signServiceOffer,
  type AccessKey,
  type ChatMessage,
  type Completion,
  type CompletionCall,
  type Connector,
  type GatewayAnswer,
  type QuoteResponse,
  type ServeResponse,
  type ToolCalls,
  type ToolSpec,
} from '../src/index.js';
import { ServiceBackend, TOOLS_CHECKS, TOOLS_CHECK_WAIT_MS } from '../src/seller-backend.js';

const NODE = new ethers.Wallet(`0x${'22'.repeat(32)}`);
/** The seller's two services: each a model URN, and the backend's own model name. */
const A = { model: 'urn:test:model:refusals-a', backend: 'backend-a' };
const B = { model: 'urn:test:model:refusals-b', backend: 'backend-b' };
const PRICE = 10n;
const QUESTION = { role: 'user', content: 'synthetic question' } satisfies ChatMessage;
const TOOLS = [{ type: 'function', function: { name: 'list_deployments', parameters: { type: 'object', properties: {} } } }] satisfies ToolSpec[];
const CALLS = [{ id: 'call_1', type: 'function', function: { name: 'list_deployments', arguments: '{}' } }] satisfies ToolCalls;
/** A call's history with a tool call and its result, and no tools: it needs a seller that takes them all the same. */
const TURN = [QUESTION, { role: 'assistant', content: null, tool_calls: CALLS }, { role: 'tool', tool_call_id: 'call_1', content: '[]' }] satisfies ChatMessage[];
const OK = { choices: [{ message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 5 } };
/** What a backend whose model takes no function tools on chat completions answers a call with tools. */
const NO_TOOLS = { error: { message: 'Function tools are not supported for this model on chat completions.', type: 'invalid_request_error' } };

/**
 * What the stubbed backend answers: a status and its body, `after` so many milliseconds; `hang` until the connector's
 * time limit; `stall`, never, past any time limit; or `down`, no answer at all.
 */
type Reply = { status: number; body?: unknown; after?: number } | 'hang' | 'stall' | 'down';
/** A reply, or what picks one for the request sent. */
type Answer = Reply | ((sent: Record<string, unknown>) => Reply);

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let seller: Seller;
let router: Router;
let gateway: Gateway;
let caller: { key: AccessKey };
/** backend model => what it answers a call with tools, and one without. */
let replies: Record<string, { tools: Answer; text: Answer }>;
/** Every request a backend got. */
let requests: Array<Record<string, unknown>>;
/** What the seller answered each `serve` the gateway sent. */
let answers: ServeResponse[];
let logs: string[];
/** While set, the buyer's quotes say the seller takes tools, as a quote kept from before it stopped would. */
let staleTools: boolean;

const body = (a: GatewayAnswer) => a.body as { error?: { code: string }; sellerCode?: string; retry?: boolean };
const chat = (model: string, extra: Record<string, unknown> = {}) => ({ model, messages: [QUESTION], max_tokens: 20, ...extra });
const withTools = (model: string) => chat(model, { tools: TOOLS });
const call = (c: unknown) => gateway.chatCompletion(caller, c);
const quoted = async (s: Seller, model: string) => (await s.quote({ services: [serviceIdOf(model)] })).offers[0]!;
/** Whether a backend request is one of the seller's own checks of its tools. */
const isCheck = (sent: Record<string, unknown>) =>
  Array.isArray(sent.tools) && (sent.tools as ToolSpec[])[0]?.function.name === TOOLS_CHECKS[0]!.tools![0]!.function.name;
/** Whether a request names the function the model must call. */
const named = (sent: Record<string, unknown>) => typeof sent.tool_choice === 'object' && sent.tool_choice !== null;
const checks = () => requests.filter(isCheck).length;

/** `fetch` as the backends answer it: by the request's model, and whether it carries tools. */
function stubBackends(): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(sent);
    const answer = replies[String(sent.model)]![sent.tools ? 'tools' : 'text'];
    const reply = typeof answer === 'function' ? answer(sent) : answer;
    if (reply === 'down') throw new TypeError('fetch failed');
    if (reply === 'hang') return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    if (reply === 'stall') return new Promise<Response>(() => {});
    if (reply.after) await new Promise((resolve) => setTimeout(resolve, reply.after));
    const said = reply.body ?? (reply.status < 300 ? OK : { error: { message: 'synthetic refusal' } });
    return new Response(JSON.stringify(said), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }));
}

/**
 * The seller of A and B, each taking tools, on its directory: a second one there is the first restarted. `timeoutMs`
 * is each backend's time limit.
 */
function sellerOf(timeoutMs = 2_000): Seller {
  return new Seller({
    chain, dir: join(dir, 'seller'), signer: NODE.address, peerId: 'seller-peer', stopServingSeconds: 180, tickSeconds: 300,
    services: [A, B].map((s) => ({
      model: s.model, serviceId: serviceIdOf(s.model), pricePerUnit: PRICE, capacity: null, provenance: 'upstream-claimed' as const, tools: true,
      // The base is never reached: `fetch` is stubbed.
      connector: connectorOf({ kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: s.backend, timeoutMs }), backendTimeoutMs: timeoutMs,
    })),
    log: (message) => logs.push(message),
  });
}

/** A buyer funding both services, and its gateway, routed to the seller in this process, whose backends have `timeoutMs`. */
async function setUp(timeoutMs?: number): Promise<void> {
  await mock.ensureProfile();
  const buyer = new Buyer({ chain, store: new BuyerStore(join(dir, 'buyer')), config: { enabled: true, buyerWallet: NODE.address, prefundLeadSeconds: 7_200, tickSeconds: 300 } });
  const { epoch } = await chain.getEpochTimes();
  await buyer.fund({ epoch, source: { kind: 'wallet' }, services: [A, B].map((s) => ({ serviceId: serviceIdOf(s.model), serviceClass: 1, value: 10n ** 6n, maxPricePerUnit: 100n })) });
  seller = sellerOf(timeoutMs);
  await seller.load();
  await seller.tick();
  const domain = (await chain.getMarketplaceContracts()).requestDomain;
  const offers = await Promise.all([A, B].map((s) => signServiceOffer(chain, NODE.address, domain, {
    seller: seller.gate.identityId, serviceId: serviceIdOf(s.model), serviceClass: 1, unit: 'token', model: s.model, provenance: 'upstream-claimed',
    capacity: null, peerId: 'seller-peer', pricePerUnit: PRICE, priceEpoch: epoch, validUntilEpoch: epoch + 12, withdrawn: false, signedAt: 1,
  })));
  router = new Router({
    chain,
    offers: async () => offers,
    quote: async (_peer, services): Promise<QuoteResponse> => {
      const quote = await seller.quote({ services });
      return staleTools ? { ...quote, offers: quote.offers.map((o) => ({ ...o, tools: true as const })) } : quote;
    },
  });
  const keys = new AccessKeys(join(dir, 'buyer'));
  gateway = new Gateway({
    chain, buyerWallet: NODE.address, store: buyer.store, router, keys, dir: join(dir, 'buyer'),
    send: async (_peer, payload) => {
      const answer = await seller.serve(decodeMessage(payload), 'buyer-peer');
      answers.push(answer);
      return encodeMessage(answer);
    },
  });
  await gateway.load();
  caller = { key: (await keys.make({ label: 'test-agent', budget: 10n ** 30n, services: null, rps: 1_000, expiresAt: null }, 0)).key };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-backend-refusals-'));
  mock = new MockChainAdapter('mock:31337', NODE.address);
  mock.setMockACKSigner(NODE);
  chain = marketplaceChainOf(mock)!;
  replies = { [A.backend]: { tools: { status: 200 }, text: { status: 200 } }, [B.backend]: { tools: { status: 200 }, text: { status: 200 } } };
  requests = [];
  answers = [];
  logs = [];
  staleTools = false;
  stubBackends();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('a call its backend refuses about the call itself', () => {
  it("is refused not to retry: the buyer keeps the seller's other service, and stops sending the service calls with tools", async () => {
    await setUp();
    const demote = vi.spyOn(router, 'demote');
    const unreachable = vi.spyOn(router, 'unreachable');
    // The backend refuses every call with tools on one model, and serves the calls without.
    replies[A.backend]!.tools = { status: 400, body: NO_TOOLS };
    expect(await call(withTools(A.model))).toMatchObject({ status: 502, body: { error: { code: 'seller_refused' }, sellerCode: 'BadRequest', retry: false } });
    expect(answers).toEqual([{ ok: false, code: 'BadRequest', retry: false, message: "the service's backend refused the call (400)" }]);
    expect(demote).toHaveBeenCalledWith(seller.gate.identityId);
    expect(unreachable).not.toHaveBeenCalled();
    // The seller checked with its own minimal calls with tools, both refused too, before it answered: the tools are off.
    expect(checks()).toBe(2);
    expect(logs).toContain(`[marketplace] the backend of ${A.model} failed: the backend answered 400: ${NO_TOOLS.error.message}`);
    expect(logs).toContain(
      `[marketplace] ${A.model} takes no tool calls until the node restarts: its backend refused minimal calls with tools too: the backend answered 400: ${NO_TOOLS.error.message}`,
    );
    expect(await quoted(seller, A.model)).not.toHaveProperty('tools');
    expect(await quoted(seller, B.model)).toMatchObject({ tools: true });

    // The seller's other service, with tools or without, and this one's calls without tools, still go to it.
    for (const c of [withTools(B.model), chat(B.model), chat(A.model)]) expect((await call(c)).status).toBe(200);
    // A client that keeps sending calls with tools is answered by the buyer, before anything is signed or sent.
    const sent = answers.length;
    for (let i = 0; i < MAX_UNSETTLED_PER_SELLER; i++) {
      expect(await call(withTools(A.model))).toMatchObject({ status: 400, body: { error: { code: 'tools_unsupported' } } });
    }
    expect(answers).toHaveLength(sent);
    // One refused call holds its value, and the seller stays in routing: under the limit of refused calls per epoch.
    expect((await gateway.activity()).calls.filter((c) => c.problem)).toEqual([expect.objectContaining({ problem: 'BadRequest' })]);
    expect((await call(chat(B.model))).status).toBe(200);

    // Restarted, with its settings fixed or not, the seller says the service takes tools again.
    const restarted = sellerOf();
    await restarted.load();
    await restarted.tick();
    expect(await quoted(restarted, A.model)).toMatchObject({ tools: true });
  });

  it.each([400, 404, 413, 415, 422])('is refused as BadRequest when the backend answers %i, and its tools stay on unless the status is about what a call carries', async (status) => {
    await setUp();
    const unreachable = vi.spyOn(router, 'unreachable');
    replies[A.backend] = { tools: { status }, text: { status } };
    expect(body(await call(chat(A.model)))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    expect(answers.at(-1)).toEqual({ ok: false, code: 'BadRequest', retry: false, message: `the service's backend refused the call (${status})` });
    expect((await call(chat(B.model))).status).toBe(200);
    // A call without tools leaves the service's tools on.
    expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
    expect(body(await call(withTools(A.model)))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    // 400 and 422 say the backend cannot take what the call carries, so the seller checks, and its own call is refused
    // too; 404, 413 and 415 are about the model, the size or the form, with no check.
    if (status === 400 || status === 422) expect(await quoted(seller, A.model)).not.toHaveProperty('tools');
    else expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
    expect(checks()).toBe(status === 400 || status === 422 ? 2 : 0);
    expect(unreachable).not.toHaveBeenCalled();
  });

  it("is answered when the check never answers, and the seller's other service stays routed", async () => {
    // The buyer's call is refused late in its backend's 400 ms, and the check then answers nothing at all. When the
    // answer comes, to the millisecond, is pinned on a fake clock with the service backend alone, below.
    await setUp(400);
    replies[A.backend]!.tools = (sent) => (isCheck(sent) ? 'stall' : { status: 400, body: NO_TOOLS, after: 250 });
    expect(await call(withTools(A.model))).toMatchObject({ status: 502, body: { error: { code: 'seller_refused' }, sellerCode: 'BadRequest', retry: false } });
    expect(checks()).toBe(1);
    // The buyer only demoted the seller, nothing is known of the tools, and the other service is routed.
    expect((await call(chat(B.model))).status).toBe(200);
    expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
  });

  it('refuses a call with tools from a buyer whose quote is from before, without running the backend', async () => {
    await setUp();
    replies[A.backend]!.tools = { status: 400, body: NO_TOOLS };
    expect(body(await call(withTools(A.model)))).toMatchObject({ sellerCode: 'BadRequest' });
    const before = requests.length;
    staleTools = true;
    expect(body(await call(withTools(A.model)))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    expect(answers.at(-1)).toEqual({ ok: false, code: 'BadRequest', retry: false, message: 'this service takes no tool calls' });
    expect(requests).toHaveLength(before);
  });
});

describe("a service's tools", () => {
  it("stay on when a buyer's call with tools was refused for what it carries: the seller's own call is served, and the next valid call reaches the backend", async () => {
    await setUp();
    // The backend refuses a tool whose parameters are not an object schema; the wire takes any object there.
    const invalid = [{ type: 'function', function: { name: 'list_deployments', parameters: { type: 'invalid-type' } } }];
    replies[A.backend]!.tools = (sent) => ((sent.tools as ToolSpec[]).every((t) => t.function.parameters?.type === 'object') ? { status: 200 } : { status: 400 });
    expect(body(await call(chat(A.model, { tools: invalid })))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    expect(checks()).toBe(1);
    expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
    expect(logs.filter((l) => l.includes('takes no tool calls'))).toEqual([]);
    const before = requests.length;
    expect((await call(withTools(A.model))).status).toBe(200);
    expect(requests).toHaveLength(before + 1);
    // Its backend has shown it takes tools: a refusal after that is the call's own, and is not checked again.
    expect(body(await call(chat(A.model, { tools: invalid })))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    expect(checks()).toBe(1);
    expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
  });

  it('stay on when the check says nothing, and the next such refusal checks again', async () => {
    await setUp();
    // The first check finds the backend busy; the next ones find both ways refused.
    const checkReplies: Reply[] = [{ status: 503 }, { status: 400, body: NO_TOOLS }, { status: 400, body: NO_TOOLS }];
    replies[A.backend]!.tools = (sent) => (isCheck(sent) ? checkReplies.shift()! : { status: 400, body: NO_TOOLS });
    expect(body(await call(withTools(A.model)))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
    expect(checks()).toBe(1);
    expect(body(await call(withTools(A.model)))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    expect(await quoted(seller, A.model)).not.toHaveProperty('tools');
    expect(checks()).toBe(3);
  });

  it('stay on when the backend refuses functions with no parameters: the check names one, and a call with one still reaches it', async () => {
    await setUp();
    const empty = (t: ToolSpec) => Object.keys((t.function.parameters?.properties ?? {}) as Record<string, unknown>).length === 0;
    replies[A.backend]!.tools = (sent) => ((sent.tools as ToolSpec[]).some(empty) ? { status: 400, body: { error: { message: 'synthetic: properties must not be empty' } } } : { status: 200 });
    // The buyer's function takes no parameters, so the backend refuses it; the check's has one, and is served.
    expect(TOOLS[0].function.parameters.properties).toEqual({});
    expect(body(await call(withTools(A.model)))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    expect(checks()).toBe(1);
    expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
    const withParameter = [{ type: 'function', function: { name: 'get_status', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }];
    const before = requests.length;
    expect((await call(chat(A.model, { tools: withParameter }))).status).toBe(200);
    expect(requests).toHaveLength(before + 1);
  });

  it("stay on when the backend takes the function named but not its own choice: a named call still reaches it", async () => {
    await setUp();
    // As a server whose automatic choice of tools is not turned on: it refuses calls that leave the choice to the model.
    replies[A.backend]!.tools = (sent) => (named(sent) ? { status: 200 } : { status: 400, body: { error: { message: 'synthetic: automatic tool choice is off' } } });
    expect(body(await call(withTools(A.model)))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    // Its own choice refused, the function named served.
    expect(requests.filter(isCheck).map(named)).toEqual([false, true]);
    expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
    expect(logs.filter((l) => l.includes('takes no tool calls'))).toEqual([]);
    const before = requests.length;
    const namedCall = chat(A.model, { tools: TOOLS, tool_choice: { type: 'function', function: { name: TOOLS[0].function.name } } });
    expect((await call(namedCall)).status).toBe(200);
    expect(requests).toHaveLength(before + 1);
    expect(named(requests.at(-1)!)).toBe(true);
  });

  it("stay on once its backend has served a call with tools: a later refusal is that call's own, and is not checked", async () => {
    await setUp();
    expect((await call(withTools(A.model))).status).toBe(200);
    // Say the next call is longer than the model takes.
    replies[A.backend]!.tools = { status: 400, body: { error: { message: 'synthetic: the input is too long' } } };
    expect(body(await call(withTools(A.model)))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
    expect(checks()).toBe(0);
    expect(logs.filter((l) => l.includes('takes no tool calls'))).toEqual([]);
    replies[A.backend]!.tools = { status: 200 };
    expect((await call(withTools(A.model))).status).toBe(200);
  });

  it('stay on when the refused call carries none: a call without tools, or with only their history', async () => {
    await setUp();
    replies[A.backend]!.text = { status: 400 };
    for (const c of [chat(A.model), { model: A.model, messages: TURN, max_tokens: 20 }]) {
      expect(body(await call(c))).toMatchObject({ sellerCode: 'BadRequest', retry: false });
    }
    // The history went to the backend without tools.
    expect(requests.map((r) => 'tools' in r)).toEqual([false, false]);
    expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
  });
});

describe("a call whose backend fails for the seller's key, quota or load, or does not answer", () => {
  it.each([
    ['answers 401', { status: 401 }],
    ['answers 403', { status: 403 }],
    ['answers 408', { status: 408 }],
    ['answers 409', { status: 409 }],
    ['answers 429', { status: 429 }],
    ['answers 500', { status: 500 }],
    ['answers 502', { status: 502 }],
    ['answers 503', { status: 503 }],
    ['times out', 'hang'],
    ['cannot be reached', 'down'],
  ] satisfies Array<[string, Reply]>)('is refused as UpstreamError, to retry, when the backend %s: the buyer leaves the seller out for ten minutes, as before', async (_what, reply) => {
    // A backend that times out takes its whole time limit: a short one here.
    await setUp(reply === 'hang' ? 100 : undefined);
    const demote = vi.spyOn(router, 'demote');
    const unreachable = vi.spyOn(router, 'unreachable');
    replies[A.backend] = { tools: reply, text: reply };
    expect(await call(withTools(A.model))).toMatchObject({ status: 502, body: { error: { code: 'seller_refused' }, sellerCode: 'UpstreamError', retry: true } });
    expect(answers).toEqual([{ ok: false, code: 'UpstreamError', retry: true }]);
    expect(unreachable).toHaveBeenCalledWith(seller.gate.identityId);
    expect(demote).not.toHaveBeenCalled();
    // Out of every service for now, the other one too, as before; and the service still takes tools, unchecked.
    expect(body(await call(chat(B.model))).error?.code).toBe('no_seller');
    expect(await quoted(seller, A.model)).toMatchObject({ tools: true });
    expect(checks()).toBe(0);
  });
});


describe('a service backend, driven by hand', () => {
  const SERVED: Completion = { content: 'OK', promptTokens: 3, completionTokens: 1 };
  const WITH_TOOLS: CompletionCall = { messages: [QUESTION], maxTokens: 20, tools: TOOLS };
  const WITHOUT_TOOLS: CompletionCall = { messages: [QUESTION], maxTokens: 20 };
  const refusedWith = (status: number) => new UpstreamError(`the backend answered ${status}: synthetic refusal`, status);
  const backendOf = (connector: Connector, settings: { takesTools?: boolean; timeoutMs?: number } = {}) =>
    new ServiceBackend(connector, { model: A.model, takesTools: settings.takesTools ?? true, timeoutMs: settings.timeoutMs ?? 60_000 }, (m) => logs.push(m));

  /** A connector whose calls wait, in the order they came, until the test settles them. */
  function heldConnector() {
    const held: Array<{ call: CompletionCall; resolve: (c: Completion) => void; reject: (err: unknown) => void }> = [];
    const connector: Connector = {
      kind: 'openai',
      complete: (c) => new Promise<Completion>((resolve, reject) => { held.push({ call: c, resolve, reject }); }),
    };
    return { connector, held };
  }

  /** A call's end, once it comes: the completion, or the error it failed with. */
  function track(work: Promise<Completion>): { end: () => Completion | unknown; done: () => boolean; finished: Promise<void> } {
    let state: { end: unknown } | undefined;
    const finished = work.then((c) => { state = { end: c }; }, (err: unknown) => { state = { end: err }; });
    return { end: () => state?.end, done: () => state !== undefined, finished };
  }

  it('answers a refused call with tools at its time limit, counted from when it went to the backend, however long the check takes', async () => {
    vi.useFakeTimers();
    const { connector, held } = heldConnector();
    const backend = backendOf(connector, { timeoutMs: 400 });
    const refusal = refusedWith(400);
    const sentAt = Date.now();
    const call = track(backend.complete(WITH_TOOLS));
    // The backend refuses it 250 ms in; the check then never answers.
    await vi.advanceTimersByTimeAsync(250);
    held[0]!.reject(refusal);
    await vi.advanceTimersByTimeAsync(0);
    expect(held.map((h) => h.call)).toEqual([WITH_TOOLS, TOOLS_CHECKS[0]]);
    await vi.advanceTimersByTimeAsync(149);
    expect(call.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // At 400 ms, with its own error.
    expect(call.done()).toBe(true);
    expect(Date.now() - sentAt).toBe(400);
    expect(call.end()).toBe(refusal);

    // With a long time limit, the wait for the check is what ends first.
    const { connector: slow, held: slowHeld } = heldConnector();
    const patient = backendOf(slow, { timeoutMs: 60_000 });
    const other = track(patient.complete(WITH_TOOLS));
    slowHeld[0]!.reject(refusedWith(422));
    await vi.advanceTimersByTimeAsync(TOOLS_CHECK_WAIT_MS - 1);
    expect(other.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(other.done()).toBe(true);
    // The check goes on, and what it finds still counts.
    slowHeld[1]!.reject(refusedWith(400));
    await vi.advanceTimersByTimeAsync(0);
    expect(slowHeld[2]!.call).toBe(TOOLS_CHECKS[1]);
    slowHeld[2]!.reject(refusedWith(400));
    await vi.advanceTimersByTimeAsync(0);
    expect(patient.takesTools).toBe(false);
  });

  it("keeps the tools of a backend that serves a buyer's call with tools while a check is out, whatever the check comes to", async () => {
    const { connector, held } = heldConnector();
    const backend = backendOf(connector);
    const refusal = refusedWith(400);
    const refused = track(backend.complete(WITH_TOOLS));
    held[0]!.reject(refusal);
    // The check of the model's own choice is refused; the one with the function named goes out.
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[1]!.reject(refusedWith(400));
    await vi.waitFor(() => expect(held).toHaveLength(3));
    expect(held[2]!.call).toBe(TOOLS_CHECKS[1]);
    // Another buyer's call with tools is served while it is out.
    const served = backend.complete(WITH_TOOLS);
    held[3]!.resolve(SERVED);
    expect(await served).toEqual(SERVED);
    // The named check comes back refused, after that: the tools stay, and the refused call fails with its own error.
    held[2]!.reject(refusedWith(400));
    await refused.finished;
    expect(refused.end()).toBe(refusal);
    expect(backend.takesTools).toBe(true);
    expect(logs).toEqual([]);
    // Its backend has shown it takes tools: a refusal now is the call's own, with no check.
    const later = track(backend.complete(WITH_TOOLS));
    held[4]!.reject(refusedWith(400));
    await later.finished;
    expect(held).toHaveLength(5);
  });

  it('checks once at a time, for calls with tools refused with 400 or 422 alone, and again after a check that said nothing', async () => {
    const { connector, held } = heldConnector();
    const backend = backendOf(connector);
    // Two calls refused at once share one check.
    const first = track(backend.complete(WITH_TOOLS));
    const second = track(backend.complete(WITH_TOOLS));
    held[0]!.reject(refusedWith(400));
    held[1]!.reject(refusedWith(422));
    await vi.waitFor(() => expect(held).toHaveLength(3));
    // It says nothing: no answer.
    held[2]!.reject(new UpstreamError('the backend did not answer: synthetic'));
    await Promise.all([first.finished, second.finished]);
    expect(held).toHaveLength(3);
    expect(backend.takesTools).toBe(true);
    // Refusals about the model, the size or the form, and calls without tools, check nothing.
    const unchecked: Array<[CompletionCall, number]> = [[WITH_TOOLS, 404], [WITH_TOOLS, 413], [WITH_TOOLS, 415], [WITHOUT_TOOLS, 400]];
    for (const [c, status] of unchecked) {
      const failed = track(backend.complete(c));
      held.at(-1)!.reject(refusedWith(status));
      await failed.finished;
    }
    expect(held).toHaveLength(7);
    // The next refusal checks again: both ways refused, and the service's tools go off.
    const third = track(backend.complete(WITH_TOOLS));
    held[7]!.reject(refusedWith(400));
    await vi.waitFor(() => expect(held).toHaveLength(9));
    held[8]!.reject(refusedWith(422));
    await vi.waitFor(() => expect(held).toHaveLength(10));
    held[9]!.reject(refusedWith(400));
    await third.finished;
    expect(backend.takesTools).toBe(false);
    expect(logs).toEqual([`[marketplace] ${A.model} takes no tool calls until the node restarts: its backend refused minimal calls with tools too: the backend answered 400: synthetic refusal`]);
    // A buyer's call with tools that was out, served after all, shows the backend takes them.
    const late = backend.complete(WITH_TOOLS);
    held[10]!.resolve(SERVED);
    await late;
    expect(backend.takesTools).toBe(true);
  });

  it('is up or down by its last call, and takes no tools when its settings say none', async () => {
    const { connector, held } = heldConnector();
    const backend = backendOf(connector, { takesTools: false });
    expect([backend.state, backend.takesTools]).toEqual(['up', false]);
    const failed = track(backend.complete(WITH_TOOLS));
    held[0]!.reject(refusedWith(500));
    await failed.finished;
    expect(failed.end()).toBeInstanceOf(UpstreamError);
    expect(backend.state).toBe('down');
    const served = backend.complete(WITH_TOOLS);
    held[1]!.resolve(SERVED);
    await served;
    expect([backend.state, backend.takesTools]).toEqual(['up', false]);
  });
});
