/**
 * OT-RFC-27 buyer chat + gateway calls end to end over an in-process
 * messenger network (one buyer, two sellers, real `Messenger` substrates over
 * router doubles) and ONE shared `MockChainAdapter` marketplace:
 *
 *  - the chat flow with a spend guard (admit / settle exactly once per
 *    outcome), GV-2 numbers and a recount `match`;
 *  - per-offer `maxUnits` for two sellers pinning different tokenizers;
 *  - prompt-transport tool calls, `toolTransport: 'none'` stripping, native
 *    tool slack, and invalid tool responses charged at the receipt value;
 *  - a dishonest seller (servedUnits + 1): settles, `mismatch`, standing
 *    deprioritized → denied → skipped; standings persist across a restart;
 *  - malformed results, caller-fault codes, the chat serve timeout and the
 *    authorization TTL floor; the generic invoke never routes to chat offers;
 *  - the gateway query and model list.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  MARKETPLACE_SERVE_VERSION,
  PROTOCOL_MARKETPLACE_SERVE,
  decodeMarketplaceServeResponse,
  encodeMarketplaceServeRequest,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';
import { MOCK_MARKETPLACE_ADDRESS, MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST,
  QUERY_COST_SCHEDULE_V1_DIGEST,
  TOOL_CALL_SLACK_UNITS,
  chatPromptUpperBound,
  computeAuthDigest,
  createHfBpeEngine,
  createStubWordsEngine,
  eip191SignDigest,
  offeringIdFor,
  type AuthorizationFields,
  type MarketplaceOffer,
  type OfferMetering,
  type PlanPolicy,
  type TokenCountEngine,
} from '@origintrail-official/dkg-marketplace';
import { Messenger } from '../src/p2p/messenger.js';
import {
  MarketplaceSellerService,
  type MarketplaceMessenger,
  type MarketplaceSellerOffering,
} from '../src/marketplace/seller-service.js';
import {
  MarketplaceBuyerService,
  MarketplaceInvokeError,
  MarketplaceRouteError,
} from '../src/marketplace/buyer-service.js';
import {
  MarketplaceInvalidToolResponseError,
  MarketplaceModelNotFoundError,
  MarketplaceRequestError,
  type MarketplaceSpendGuard,
} from '../src/marketplace/buyer-errors.js';
import { listGatewayModels, runChatCompletion, runGatewayQuery, type BuyerChatDeps } from '../src/marketplace/buyer-chat.js';
import { createChatConnectorExecutor } from '../src/marketplace/chat-executor.js';
import { createQueryExecutor, createStubInferenceExecutor, type MarketplaceExecutor } from '../src/marketplace/executors.js';
import type { ChatConnector, ConnectorChatRequest } from '../src/marketplace/connectors/types.js';
import { BuyerTokenizers } from '../src/marketplace/tokenizer-files.js';

const TRAC = 10n ** 18n;
const NOW_SECONDS = 1_900_000_000;
const ASK_A = 500_000_000_000n;
const ASK_B = 800_000_000_000n;
const QUERY_ASK = 15_000_000_000_000n;
const GV2 = [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'hello marketplace world' }];
const TINY_HF_TOKENIZER = JSON.stringify({
  version: '1.0',
  model: { type: 'BPE', vocab: { a: 0, b: 1, c: 2, 'Ġ': 3, ab: 4, abc: 5, 'Ġa': 6 }, merges: ['a b', 'ab c', 'Ġ a'] },
});
const log = { info: () => {}, warn: () => {} };

type InboundHandler = (data: Uint8Array, peerId: { toString(): string; toBytes(): Uint8Array }) => Promise<Uint8Array>;

/** An in-process messenger network: every endpoint can reach every other one. */
function makeNetwork() {
  const handlers = new Map<string, Map<string, InboundHandler>>();
  const endpoint = (peerId: string): Messenger => {
    const own = new Map<string, InboundHandler>();
    handlers.set(peerId, own);
    const router = {
      register(protocolId: string, handler: InboundHandler) { own.set(protocolId, handler); },
      async send(target: string, protocolId: string, data: Uint8Array) {
        const handler = handlers.get(target)?.get(protocolId);
        if (!handler) throw new Error(`no route to ${target}`);
        return handler(data, { toString: () => peerId, toBytes: () => new Uint8Array() });
      },
    };
    return new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore: new InMemoryMessageIdempotencyStore(),
      outboxStore: new InMemoryProtocolOutboxStore({ backoffs: [10], maxAgeMs: 60_000 }),
    });
  };
  return { endpoint };
}

const words = (text: string): string[] => (text.trim() === '' ? [] : text.trim().split(/\s+/));

/** The llm-stub formula, with native tool calls and the prompt-tool envelope. */
function stubConnector(opts: {
  toolTransport?: 'native' | 'prompt' | 'none';
  promptToolName?: string;
  fail?: boolean;
} = {}): { connector: ChatConnector; seen: ConnectorChatRequest[] } {
  const seen: ConnectorChatRequest[] = [];
  return {
    seen,
    connector: {
      description: {
        kind: 'openai-compatible', toolTransport: opts.toolTransport ?? 'native', provenanceClass: 'upstream-claimed',
        upstreamModel: 'stub-chat', upstreamOrigin: 'http://127.0.0.1:18080', secretConfigured: false,
      },
      async complete(request) {
        seen.push(request);
        if (opts.fail) return { ok: false, code: 'UPSTREAM_ERROR', status: 500, detail: 'boom' };
        if (request.tools?.length && request.toolChoice === 'required') {
          return {
            ok: true, content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_stub_1', type: 'function', function: { name: request.tools[0].function.name, arguments: '{"echo":3}' } }],
          };
        }
        if (request.messages[0]?.content.includes('__dkg_tool_calls__')) {
          const name = opts.promptToolName ?? 'lookup';
          return { ok: true, content: JSON.stringify({ __dkg_tool_calls__: [{ name, arguments: { q: 1 } }] }), finishReason: 'stop' };
        }
        const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        const body = words(lastUser).reverse().map((w) => w.toUpperCase());
        const full = [`STUB:${body[0] ?? ''}`, ...body.slice(1), '::', 'ok'];
        const out = full.slice(0, request.maxTokens);
        const prompt = request.messages.reduce((s, m) => s + words(m.content).length + words(m.role).length + 3, 0) + 3;
        return {
          ok: true, content: out.join(' '), finishReason: out.length < full.length ? 'length' : 'stop',
          providerUsage: { promptTokens: prompt, completionTokens: out.length },
        };
      },
      async health() { return { ok: true, latencyMs: 0 }; },
    },
  };
}

interface SellerSpec {
  identity: bigint;
  peer: string;
  ask: bigint;
  engine?: TokenCountEngine;
  transport?: 'native' | 'prompt' | 'none';
  executor?: (honest: MarketplaceExecutor) => MarketplaceExecutor;
  connector?: Parameters<typeof stubConnector>[0];
  allowedBuyers?: string[];
}

const pinOf = (engine: TokenCountEngine): OfferMetering => ({
  basis: 'pinned',
  tokenizer: { kind: engine.kind, digest: engine.digest },
  chatTemplate: { id: 'openai-chat-count/v1', digest: CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST },
});

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function createWorld(specs: SellerSpec[], opts: { authTtlSeconds?: number; tokenizerFiles?: Array<{ kind: 'hf-bpe-v1'; path: string }>; dataDir?: string } = {}) {
  const net = makeNetwork();
  const buyerWallet = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
  const buyerChain = new MockChainAdapter('mock:31337', buyerWallet.address);
  buyerChain.__marketplaceState().nowSeconds = BigInt(NOW_SECONDS);
  const offers: MarketplaceOffer[] = [];
  const sellers: Array<{ spec: SellerSpec; service: MarketplaceSellerService; seen: ConnectorChatRequest[]; wallet: ethers.Wallet }> = [];
  for (const spec of specs) {
    const wallet = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    chain.__attachMarketplaceState(buyerChain.__marketplaceState());
    chain.seedIdentity(wallet.address, spec.identity);
    buyerChain.seedIdentity(wallet.address, spec.identity);
    const service = new MarketplaceSellerService({
      messenger: net.endpoint(spec.peer),
      chain,
      receiptSigner: wallet,
      receiptSignerAddress: wallet.address,
      log,
      now: () => NOW_SECONDS * 1000,
      batching: { maxBatchSize: 100, maxDelayMs: 3_600_000, maxBuyerExposureWei: 1_000_000n * TRAC },
      expiryMarginSeconds: 60,
    });
    const { connector, seen } = stubConnector({ toolTransport: spec.transport, ...spec.connector });
    const engine = spec.engine ?? createStubWordsEngine();
    const honest = createChatConnectorExecutor({ connector, modelId: 'stub-chat', engine });
    const localId = `chat-${spec.identity}`;
    const chatOffering: MarketplaceSellerOffering = {
      offeringLocalId: localId, offeringId: offeringIdFor(localId), serviceType: 'inference', unit: 'token',
      modelId: 'stub-chat', askPerUnitWei: spec.ask, executor: spec.executor ? spec.executor(honest) : honest,
      apiShape: 'openai-chat/v1', toolTransport: spec.transport ?? 'native', metering: pinOf(engine),
      model: { provenanceClass: 'upstream-claimed', contextLength: 32_768n },
      ...(spec.allowedBuyers ? { allowedBuyers: new Set(spec.allowedBuyers.map((a) => a.toLowerCase())), access: 'restricted' as const } : {}),
    };
    const extra: MarketplaceSellerOffering[] = [
      { offeringLocalId: `llm-${spec.identity}`, offeringId: offeringIdFor(`llm-${spec.identity}`), serviceType: 'inference', unit: 'token', askPerUnitWei: spec.ask, executor: createStubInferenceExecutor() },
      {
        offeringLocalId: `kn-${spec.identity}`, offeringId: offeringIdFor(`kn-${spec.identity}`), serviceType: 'query', unit: 'query-unit', askPerUnitWei: QUERY_ASK,
        executor: createQueryExecutor(async () => ({ result: { bindings: [{ s: '1' }, { s: '2' }] } })),
        queryCost: { schedule: 'dkg-mkt-query-cost/1', digest: QUERY_COST_SCHEDULE_V1_DIGEST },
      },
    ];
    service.setOfferings([chatOffering, ...extra]);
    service.registerProtocolHandlers();
    sellers.push({ spec, service, seen, wallet });
    for (const offering of [chatOffering, ...extra]) {
      offers.push({
        offerId: `urn:dkg:marketplace:offer:${spec.peer}:${offering.offeringLocalId}`,
        offeringId: offering.offeringId, serviceType: offering.serviceType, unit: offering.unit,
        askPerUnitWei: offering.askPerUnitWei, sellerIdentityId: spec.identity, sellerPeerId: spec.peer, sellerAddress: wallet.address,
        ...(offering.modelId ? { modelId: offering.modelId } : {}),
        ...(offering.apiShape ? { apiShape: offering.apiShape } : {}),
        ...(offering.toolTransport ? { toolTransport: offering.toolTransport } : {}),
        ...(offering.metering ? { metering: offering.metering } : {}),
        ...(offering.model ? { model: offering.model } : {}),
        ...(offering.queryCost ? { queryCost: offering.queryCost } : {}),
        ...(offering.access ? { access: offering.access } : {}),
      });
    }
  }
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'dkg-mkt-buyer-chat-'));
  if (!opts.dataDir) cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const serveTimeouts: Array<number | undefined> = [];
  const buyerMessenger = net.endpoint('12D3KooWBuyer');
  const recordingMessenger: MarketplaceMessenger = {
    register: (p, h) => buyerMessenger.register(p, h),
    sendReliable: (peer, p, payload, o) => buyerMessenger.sendReliable(peer, p, payload, o),
    sendRequestOwned: (peer, p, payload, o) => {
      if (p.includes('serve')) serveTimeouts.push(o?.timeoutMs);
      return buyerMessenger.sendRequestOwned(peer, p, payload, o);
    },
  };
  const makeBuyer = () => new MarketplaceBuyerService({
    messenger: recordingMessenger,
    chain: buyerChain,
    resolveBuyerAddress: async () => buyerWallet.address,
    offerSource: { discoverOffers: async () => offers },
    log,
    sessionKeyPath: join(dataDir, 'marketplace', 'session-key.json'),
    standingPath: join(dataDir, 'marketplace', 'seller-standing.json'),
    nowSeconds: () => NOW_SECONDS,
    ...(opts.authTtlSeconds !== undefined ? { authTtlSeconds: opts.authTtlSeconds } : {}),
  });
  const buyer = makeBuyer();
  const deps = (b = buyer): BuyerChatDeps => ({ buyer: b, tokenizers: new BuyerTokenizers(opts.tokenizerFiles, log), chatServeTimeoutMs: 200_000 });
  const policy = (extra: Partial<PlanPolicy> = {}): PlanPolicy => ({
    totalBudgetWei: 10n * TRAC,
    buckets: [
      { match: { serviceType: 'inference', modelId: 'stub-chat' }, budgetWei: 4n * TRAC, priceCapWeiPerUnit: 1_000_000_000_000n, maxUnitsPerCall: 4_000n },
      { match: { serviceType: 'inference' }, budgetWei: 3n * TRAC, priceCapWeiPerUnit: 1_000_000_000_000n, maxUnitsPerCall: 4_000n },
      { match: { serviceType: 'query' }, budgetWei: 3n * TRAC, priceCapWeiPerUnit: 20_000_000_000_000n, maxUnitsPerCall: 200n },
    ],
    ...extra,
  });
  const subscribe = (b = buyer, extra: Partial<PlanPolicy> = {}) => b.subscribe({ amountWei: 10n * TRAC, policy: policy(extra), epoch: 1n });
  return { buyer, makeBuyer, deps, offers, sellers, subscribe, serveTimeouts, buyerWallet, dataDir, buyerMessenger };
}

function recordingGuard(opts: { refuse?: Error } = {}) {
  const calls: Array<{ kind: 'admit'; wei: bigint } | { kind: 'settle'; costWei: bigint; servedUnits: bigint; delivery: string }> = [];
  const guard: MarketplaceSpendGuard = {
    admit(worstCaseCostWei) {
      calls.push({ kind: 'admit', wei: worstCaseCostWei });
      if (opts.refuse) throw opts.refuse;
    },
    settle(outcome) { calls.push({ kind: 'settle', ...outcome }); },
  };
  return { guard, calls };
}

const A = { identity: 7n, peer: '12D3KooWSellerA', ask: ASK_A };
/** The rejections of the chat offers only (the harness sellers also carry llm/knowledge offerings). */
const chatReasons = (error: unknown) =>
  (error as MarketplaceRouteError).rejections.filter((r) => r.offerId.includes(':chat-')).map((r) => r.reason);
const B = { identity: 9n, peer: '12D3KooWSellerB', ask: ASK_B };

describe('buyer chat completion over the marketplace', () => {
  it('GV-2 through the cheaper seller: content, usage 17/5/22, recount match, guard admitted + settled once at the receipt value', async () => {
    const w = createWorld([A, B]);
    await w.subscribe();
    const { guard, calls } = recordingGuard();
    const result = await runChatCompletion(w.deps(), { model: 'Stub-Chat', messages: GV2, spendGuard: guard });
    expect(result.model).toBe('stub-chat');
    expect(result.message).toEqual({ role: 'assistant', content: 'STUB:WORLD MARKETPLACE HELLO :: ok' });
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 17, completionTokens: 5, totalTokens: 22 });
    expect(result.recount).toEqual({ verdict: 'match', servedUnits: 22n, recountUnits: 22n });
    expect(result.invoke.seller.identityId).toBe(7n);
    expect(result.invoke.costWei).toBe(22n * ASK_A);
    // Sized per offer: fixed 17 (stub-words pin) + default 256 → 273 units authorized.
    expect(result.invoke.authorization.maxUnits).toBe(273n);
    expect(w.sellers[0].seen[0].maxTokens).toBe(256);
    expect(calls).toEqual([
      { kind: 'admit', wei: 273n * ASK_A },
      { kind: 'settle', costWei: 22n * ASK_A, servedUnits: 22n, delivery: 'served' },
    ]);
    expect(w.buyer.meterState()?.totalReservedWei).toBe(0n);
    expect(w.buyer.meterState()?.totalSettledWei).toBe(22n * ASK_A);
    // The chat serve timeout and the authorization TTL floor (200 s + 300 s over the 600 s default → 600 s).
    expect(w.serveTimeouts).toEqual([200_000]);
  });

  it('honors the chat authorization TTL floor over a short operator TTL', async () => {
    const w = createWorld([A], { authTtlSeconds: 60 });
    await w.subscribe();
    const result = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2 });
    expect(result.invoke.authorization.expiry).toBe(BigInt(NOW_SECONDS + 500));
  });

  it('sizes maxUnits per offer: a pin the buyer holds counts exactly, an unknown pin uses the strict byte bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dkg-mkt-tok-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tokenizerPath = join(dir, 'tokenizer.json');
    writeFileSync(tokenizerPath, TINY_HF_TOKENIZER);
    const hf = createHfBpeEngine(new TextEncoder().encode(TINY_HF_TOKENIZER));
    // B pins the hf engine and is cheaper per unit; the buyer does NOT hold that file.
    const w = createWorld([A, { ...B, ask: 450_000_000_000n, engine: hf }]);
    await w.subscribe();
    const upper = chatPromptUpperBound(GV2, {});
    expect(upper).toBe(56n); // GV-6
    // 273 × 5e11 (A) beats (56+256) × 4.5e11 (B): worst-case preference, not the raw ask.
    const first = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2 });
    expect(first.invoke.seller.identityId).toBe(7n);
    const small = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2, maxTokens: 10 });
    expect(small.invoke.seller.identityId).toBe(7n);
    await w.subscribe(w.buyer, { sellerAllow: [9n] });
    const viaB = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2, maxTokens: 10 });
    expect(viaB.invoke.seller.identityId).toBe(9n);
    expect(viaB.invoke.authorization.maxUnits).toBe(upper + 10n);
    expect(viaB.recount).toMatchObject({ verdict: 'unverifiable', reason: 'no-engine' });

    // With the file, the buyer recounts B exactly.
    const withFile = createWorld([{ ...B, engine: hf }], { tokenizerFiles: [{ kind: 'hf-bpe-v1', path: tokenizerPath }] });
    await withFile.subscribe();
    const exact = await runChatCompletion(withFile.deps(), { model: 'stub-chat', messages: GV2, maxTokens: 10 });
    expect(exact.recount.verdict).toBe('match');
    const fixed = BigInt(hf.encodeCount('You are terse.') + hf.encodeCount('system') + hf.encodeCount('hello marketplace world') + hf.encodeCount('user')) + 9n;
    expect(exact.invoke.authorization.maxUnits).toBe(fixed + 10n);
  });

  it('prompt transport: tools travel in the system protocol and the envelope comes back as tool_calls', async () => {
    const w = createWorld([{ ...A, transport: 'prompt' }]);
    await w.subscribe();
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    const result = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2, tools, toolChoice: 'required' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.message.content).toBeNull();
    expect(result.message.tool_calls).toEqual([
      { id: expect.stringMatching(/^call_dkg_[0-9a-f]{24}$/), type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } },
    ]);
    expect(result.recount.verdict).toBe('match');
    const sent = w.sellers[0].seen[0];
    expect(sent.tools).toBeUndefined();
    expect(sent.messages[0]).toMatchObject({ role: 'system' });
  });

  it('an invalid tool response is charged: the guard settles at the receipt value', async () => {
    const w = createWorld([{ ...A, transport: 'prompt', connector: { promptToolName: 'not_offered' } }]);
    await w.subscribe();
    const { guard, calls } = recordingGuard();
    const error = await runChatCompletion(w.deps(), {
      model: 'stub-chat', messages: GV2, tools: [{ type: 'function', function: { name: 'lookup' } }], toolChoice: 'auto', spendGuard: guard,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarketplaceInvalidToolResponseError);
    const invalid = error as MarketplaceInvalidToolResponseError;
    expect(invalid.costWei).toBe(invalid.invoke.costWei);
    expect(invalid.costWei > 0n).toBe(true);
    expect(calls.at(-1)).toEqual({ kind: 'settle', costWei: invalid.costWei, servedUnits: invalid.servedUnits, delivery: 'served' });
    expect(w.buyer.meterState()?.totalSettledWei).toBe(invalid.costWei);
  });

  it("tools with tool_choice 'none' route to a 'none' transport offer with the tool fields stripped", async () => {
    const w = createWorld([{ ...A, transport: 'none' }]);
    await w.subscribe();
    const result = await runChatCompletion(w.deps(), {
      model: 'stub-chat', messages: GV2, tools: [{ type: 'function', function: { name: 'lookup' } }], toolChoice: 'none',
    });
    expect(result.message.content).toBe('STUB:WORLD MARKETPLACE HELLO :: ok');
    expect(w.sellers[0].seen[0].tools).toBeUndefined();
    expect(result.invoke.authorization.maxUnits).toBe(273n);
    // Required tools cannot route there at all.
    const refused = await runChatCompletion(w.deps(), {
      model: 'stub-chat', messages: GV2, tools: [{ type: 'function', function: { name: 'lookup' } }], toolChoice: 'required',
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(MarketplaceRouteError);
    expect(chatReasons(refused)).toEqual(['tools-unsupported']);
  });

  it('native tools add TOOL_CALL_SLACK_UNITS to the grant while the payload max_tokens stays at the request value', async () => {
    const w = createWorld([A]);
    await w.subscribe();
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    const result = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2, tools, toolChoice: 'required', maxTokens: 50 });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.message.tool_calls?.[0].function.name).toBe('lookup');
    expect(result.recount.verdict).toBe('match');
    const engine = createStubWordsEngine();
    const toolUnits = BigInt(engine.encodeCount(JSON.stringify({ messageMetadata: [{}, {}], tools, tool_choice: 'required' })));
    expect(result.invoke.authorization.maxUnits).toBe(17n + toolUnits + 50n + TOOL_CALL_SLACK_UNITS);
    expect(w.sellers[0].seen[0].maxTokens).toBe(50);
  });

  it('a dishonest seller (servedUnits + 1) still settles, but mismatches, is deprioritized, then denied and skipped; standings persist', async () => {
    const overbill = (honest: MarketplaceExecutor): MarketplaceExecutor => ({
      kind: 'inference',
      async execute(payload, bounds) {
        const served = await honest.execute(payload, bounds);
        return { ...served, unitsServed: served.unitsServed + 1n };
      },
    });
    const w = createWorld([{ ...A, executor: overbill }, { ...B }]);
    await w.subscribe();
    const first = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2 });
    expect(first.invoke.seller.identityId).toBe(7n);
    expect(first.invoke.costWei).toBe(23n * ASK_A); // the receipt settles regardless
    expect(first.recount).toMatchObject({ verdict: 'mismatch', reason: 'metering-block-differs', servedUnits: 23n });
    // Deprioritized: the honest (pricier) seller B now wins.
    const second = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2 });
    expect(second.invoke.seller.identityId).toBe(9n);
    await w.subscribe(w.buyer, { sellerAllow: [7n] });
    await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2 });
    await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2 });
    const denied = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2 }).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(MarketplaceRouteError);
    expect((denied as MarketplaceRouteError).rejections.map((r) => r.reason)).toContain('recount-denied');
    const record = w.buyer.recountSnapshot().find((r) => r.sellerIdentityId === '7');
    expect(record).toMatchObject({ mismatches: 3, standing: 'denied' });

    // A restart reloads the standing from <dataDir>/marketplace/seller-standing.json.
    const restarted = w.makeBuyer();
    expect(restarted.recountSnapshot().find((r) => r.sellerIdentityId === '7')).toMatchObject({ mismatches: 3, standing: 'denied' });
    expect(restarted.resetSellerStanding(7n)).toBe(true);
    expect(restarted.recountSummary()).toEqual({ sellers: 1, deprioritized: 0, denied: 0 });
  });

  it('a non-conforming chat result is MALFORMED_RESULT (charged at the receipt value) and a recount mismatch', async () => {
    const malformed = (): MarketplaceExecutor => ({
      kind: 'inference',
      async execute() {
        return { resultBytes: new TextEncoder().encode(JSON.stringify({ schema: 'openai-chat-result/v1', oops: true })), unitsServed: 5n };
      },
    });
    const w = createWorld([{ ...A, executor: malformed }]);
    await w.subscribe();
    const { guard, calls } = recordingGuard();
    const error = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2, spendGuard: guard }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarketplaceInvokeError);
    expect(error).toMatchObject({ code: 'MALFORMED_RESULT', delivery: 'served' });
    expect(calls.at(-1)).toEqual({ kind: 'settle', costWei: 5n * ASK_A, servedUnits: 5n, delivery: 'served' });
    expect(w.buyer.recountSnapshot()[0]).toMatchObject({ sellerIdentityId: '7', mismatches: 1 });
  });

  it('a guard admit refusal propagates the SAME error, reserves nothing and records nothing', async () => {
    const w = createWorld([A]);
    await w.subscribe();
    const refusal = new Error('key budget exhausted');
    const { guard, calls } = recordingGuard({ refuse: refusal });
    const error = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2, spendGuard: guard }).catch((e: unknown) => e);
    expect(error).toBe(refusal);
    expect(calls).toEqual([{ kind: 'admit', wei: 273n * ASK_A }]);
    expect(w.buyer.meterState()?.totalReservedWei).toBe(0n);
    expect(w.buyer.deliveryHistory().size).toBe(0);
    expect(w.sellers[0].seen).toHaveLength(0);
  });

  it('seller faults count as delivery failures, caller faults do not; a refusal settles the guard not-served', async () => {
    const w = createWorld([{ ...A, connector: { fail: true } }]);
    await w.subscribe();
    const { guard, calls } = recordingGuard();
    const failed = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2, spendGuard: guard }).catch((e: unknown) => e);
    expect(failed).toMatchObject({ name: 'MarketplaceInvokeError', code: 'UPSTREAM_ERROR', delivery: 'not-served' });
    expect(calls.at(-1)).toEqual({ kind: 'settle', costWei: 0n, servedUnits: 0n, delivery: 'not-served' });
    expect(w.buyer.deliveryHistory().get('7')).toEqual({ successes: 0, failures: 1 });
    // OVER_MAX_UNITS is the caller's fault: no delivery failure is recorded.
    const caller = await w.buyer.invoke({
      serviceType: 'inference', payload: { prompt: 'a prompt far longer than two tokens allow' }, maxUnits: 2n,
    }).catch((e: unknown) => e);
    expect(caller).toMatchObject({ code: 'OVER_MAX_UNITS' });
    expect(w.buyer.deliveryHistory().get('7')).toEqual({ successes: 0, failures: 1 });
  });

  it('check order: subscription, normalization, model, bucket; the generic invoke never routes to chat offers', async () => {
    const w = createWorld([A]);
    await expect(runChatCompletion(w.deps(), { model: '!!', messages: [] })).rejects.toMatchObject({ name: 'MarketplaceNotSubscribedError' });
    await w.subscribe();
    await expect(runChatCompletion(w.deps(), { model: '!!', messages: GV2 })).rejects.toMatchObject({ code: 'invalid_model', param: 'model' });
    await expect(runChatCompletion(w.deps(), { model: 'stub-chat', messages: [{ role: 'user', content: '\uD800' }] }))
      .rejects.toBeInstanceOf(MarketplaceRequestError);
    await expect(runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2, stop: ['a', 'b', 'c', 'd', 'e'] }))
      .rejects.toMatchObject({ code: 'invalid_parameter', param: 'stop' });
    await expect(runChatCompletion(w.deps(), { model: 'unknown-model', messages: GV2 })).rejects.toBeInstanceOf(MarketplaceModelNotFoundError);
    await w.subscribe(w.buyer, { buckets: [{ match: { serviceType: 'query' }, budgetWei: TRAC, priceCapWeiPerUnit: 1n, maxUnitsPerCall: 1n }], totalBudgetWei: TRAC });
    await expect(runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2 })).rejects.toMatchObject({ reason: 'no-bucket' });

    await w.subscribe();
    const generic = await w.buyer.invoke({ serviceType: 'inference', modelId: 'stub-chat', payload: { prompt: 'hi' }, maxUnits: 100n })
      .catch((e: unknown) => e);
    expect(generic).toBeInstanceOf(MarketplaceRouteError);
    expect(chatReasons(generic)).toEqual(['api-shape']);
  });

  it('a restricted offer is routed only for allow-listed sellers; its seller refuses other buyers after the signature check', async () => {
    const w = createWorld([{ ...A, allowedBuyers: ['0x00000000000000000000000000000000000000aa'] }]);
    await w.subscribe();
    const unlisted = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2 }).catch((e: unknown) => e);
    expect(chatReasons(unlisted)).toEqual(['restricted']);
    await w.subscribe(w.buyer, { sellerAllow: [7n] });
    const refused = await runChatCompletion(w.deps(), { model: 'stub-chat', messages: GV2 }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'BUYER_NOT_ALLOWED', delivery: 'not-served' });
    expect(w.buyer.deliveryHistory().get('7')).toBeUndefined();

    // No membership oracle: a request with a BAD signature from the same
    // non-allowed buyer is refused BAD_AUTH — the allow list is consulted
    // only after the authorization signature verified.
    const fields: AuthorizationFields = {
      chainId: 31337n, marketplaceAddress: MOCK_MARKETPLACE_ADDRESS, buyer: w.buyerWallet.address, sellerIdentityId: 7n,
      offeringId: offeringIdFor('chat-7'), callId: ethers.hexlify(randomBytes(32)), epoch: 1n, maxUnits: 300n,
      askPerUnitWei: ASK_A, expiry: BigInt(NOW_SECONDS + 600),
    };
    const rogue = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
    const signature = await eip191SignDigest(rogue, computeAuthDigest(fields));
    const sent = await w.buyerMessenger.sendRequestOwned(A.peer, PROTOCOL_MARKETPLACE_SERVE, encodeMarketplaceServeRequest({
      version: MARKETPLACE_SERVE_VERSION, buyer: ethers.getBytes(fields.buyer), sellerIdentityId: '7',
      offeringId: ethers.getBytes(fields.offeringId), callId: ethers.getBytes(fields.callId), epoch: fields.epoch,
      maxUnits: fields.maxUnits, askPerUnitWei: fields.askPerUnitWei.toString(), expiry: fields.expiry,
      authSignature: ethers.getBytes(signature), payloadKind: 'inference',
      payload: new TextEncoder().encode(JSON.stringify({ schema: 'openai-chat/v1', model: 'stub-chat', messages: GV2, max_tokens: 8 })),
    }));
    expect(sent.delivered && decodeMarketplaceServeResponse(sent.response).errorCode).toBe('BAD_AUTH');
  });
});

describe('buyer gateway query and models', () => {
  it('sizes a query by queryWorstCaseUnits, recounts it, and refuses oversized SPARQL before routing', async () => {
    const w = createWorld([A]);
    await w.subscribe();
    const { guard, calls } = recordingGuard();
    const sparql = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5';
    const result = await runGatewayQuery(w.deps(), { sparql, maxRows: 100, spendGuard: guard });
    expect(result.invoke.authorization.maxUnits).toBe(4n); // GV-10
    expect(result.rowCount).toBe(2);
    expect(result.metering).toMatchObject({ admissionUnits: 3, deliveryUnits: 1, servedUnits: 4 });
    expect(result.recount).toEqual({ verdict: 'match', servedUnits: 4n, recountUnits: 4n });
    expect(calls).toEqual([
      { kind: 'admit', wei: 4n * QUERY_ASK },
      { kind: 'settle', costWei: 4n * QUERY_ASK, servedUnits: 4n, delivery: 'served' },
    ]);
    await expect(runGatewayQuery(w.deps(), { sparql: `${sparql}${' '.repeat(8_200)}` }))
      .rejects.toMatchObject({ name: 'MarketplaceRequestError', code: 'invalid_sparql', param: 'sparql' });
    await expect(runGatewayQuery(w.deps(), { sparql, maxRows: 0 })).rejects.toMatchObject({ code: 'invalid_parameter', param: 'max_rows' });
  });

  it('lists chat models with their facts; routable follows the plan', async () => {
    const w = createWorld([A, B]);
    const unsubscribed = await listGatewayModels(w.deps());
    expect(unsubscribed).toEqual([{
      id: 'stub-chat', contextLength: 32_768n, offers: 2, sellers: [7n, 9n], minAskPerUnitWei: ASK_A,
      meteringBases: ['pinned'], tokenizerKinds: ['stub-words-v1'], provenanceClasses: ['upstream-claimed'],
      toolTransports: ['native'], routable: false,
    }]);
    await w.subscribe();
    expect((await listGatewayModels(w.deps()))[0].routable).toBe(true);
  });
});
