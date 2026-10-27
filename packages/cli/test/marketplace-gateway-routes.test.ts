// OT-RFC-27 buyer gateway routes over a fake agent: request validation, the
// §9.6 error table, the chat/query/models response shapes, buffered SSE,
// per-key rps and the concurrency cap, key-budget accounting through the
// spend guard, `charged_wei`, the module graph, and log hygiene.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapGatewayError } from '../src/daemon/routes/marketplace-gateway-errors.js';
import {
  ASK_WEI,
  CALL_ID,
  GV2_MESSAGES,
  GV2_REPLY,
  RECEIPT_WEI,
  WORST_CASE_WEI,
  bearer,
  fakeChatResult,
  getJson,
  makeFakeAgent,
  mintKey,
  namedError,
  postJson,
  startGatewayServer,
  type GatewayServer,
} from './marketplace-gateway-fixtures.js';

let server: GatewayServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function withKey(agentOverrides: Parameters<typeof makeFakeAgent>[0] = {}, opts: Parameters<typeof startGatewayServer>[0] extends infer O ? Partial<O> : never = {}) {
  const fake = makeFakeAgent(agentOverrides);
  server = await startGatewayServer({ agent: fake.agent, ...opts });
  const key = await mintKey(server.store);
  return { ...fake, server, ...key };
}

const chat = (s: GatewayServer, key: string, body: unknown) => postJson(`${s.base}/chat/completions`, body, bearer(key));
const query = (s: GatewayServer, key: string, body: unknown) => postJson(`${s.base}/query`, body, bearer(key));

describe('chat request validation (§9.2 step 5)', () => {
  it.each([
    [{ messages: GV2_MESSAGES }, 'invalid_model', 'model'],
    [{ model: 42, messages: GV2_MESSAGES }, 'invalid_model', 'model'],
    [{ model: 'Not A Model!', messages: GV2_MESSAGES }, 'invalid_model', 'model'],
    [{ model: 'stub-chat' }, 'invalid_messages', 'messages'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, stream: 'yes' }, 'invalid_parameter', 'stream'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, n: 2 }, 'unsupported_parameter', 'n'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, logprobs: true }, 'unsupported_parameter', 'logprobs'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, response_format: { type: 'json_object' } }, 'unsupported_parameter', 'response_format'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, max_tokens: 0 }, 'invalid_parameter', 'max_tokens'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, max_tokens: 1.5 }, 'invalid_parameter', 'max_tokens'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, max_completion_tokens: 1_000_001 }, 'invalid_parameter', 'max_completion_tokens'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, temperature: 2.5 }, 'invalid_parameter', 'temperature'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, top_p: -0.1 }, 'invalid_parameter', 'top_p'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, seed: 1.5 }, 'invalid_parameter', 'seed'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, stop: ['a', 'b', 'c', 'd', 'e'] }, 'invalid_parameter', 'stop'],
    [{ model: 'stub-chat', messages: GV2_MESSAGES, stop: [1] }, 'invalid_parameter', 'stop'],
  ])('%j → 400 %s', async (body, code, param) => {
    const { server: s, plaintext, calls } = await withKey();
    const res = await chat(s, plaintext, body);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ type: 'invalid_request_error', code, param });
    expect(res.json.error.dkg).toEqual({ charged_wei: '0', retryable: false });
    expect(calls).toEqual([]);
  });

  it('bad JSON and non-object bodies are 400 invalid_json; an oversized body is 413 with Connection: close', async () => {
    const { server: s, plaintext } = await withKey({}, { config: { maxBodyBytes: 2048 } });
    const bad = await chat(s, plaintext, '{"model":');
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid_json');
    const arr = await chat(s, plaintext, '[1,2]');
    expect(arr.json.error.code).toBe('invalid_json');
    const big = await chat(s, plaintext, { model: 'stub-chat', messages: [{ role: 'user', content: 'x'.repeat(4096) }] });
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe('request_too_large');
    expect(big.headers.get('connection')).toBe('close');
  });

  it('forwards the OpenAI fields, ignores user/penalties/logit_bias/stream_options/unknowns, canonicalizes the model', async () => {
    const { server: s, plaintext, calls } = await withKey();
    const res = await chat(s, plaintext, {
      model: 'Stub-Chat', messages: GV2_MESSAGES, max_completion_tokens: 64, temperature: 0.5, top_p: 1, seed: 7,
      stop: 'END', tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'auto', parallel_tool_calls: false,
      user: 'u-1', frequency_penalty: 1, presence_penalty: 1, logit_bias: { 1: 2 }, stream_options: { include_usage: true },
      n: 1, logprobs: false, response_format: { type: 'text' }, mystery: true,
    });
    expect(res.status).toBe(200);
    const input = calls[0].input;
    expect(input).toMatchObject({
      model: 'stub-chat', messages: GV2_MESSAGES, maxTokens: 64, defaultMaxTokens: 256, temperature: 0.5, topP: 1,
      seed: 7, stop: 'END', tools: [{ type: 'function', function: { name: 'f' } }], toolChoice: 'auto', parallelToolCalls: false,
    });
    for (const dropped of ['user', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'stream_options', 'mystery', 'n']) {
      expect(input).not.toHaveProperty(dropped);
    }
    expect(typeof input.spendGuard?.admit).toBe('function');
  });

  it('a model outside the key allowlist is 403 model_not_allowed before any agent call', async () => {
    const fake = makeFakeAgent();
    server = await startGatewayServer({ agent: fake.agent });
    const { plaintext } = await mintKey(server.store, { modelAllowlist: ['other-chat'] });
    const res = await chat(server, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatchObject({ type: 'permission_error', code: 'model_not_allowed' });
    expect(fake.calls).toEqual([]);
  });
});

describe('chat responses (§9.3, §9.4)', () => {
  it('non-stream: the OpenAI chat.completion shape plus the dkg block (bigints as strings)', async () => {
    const { server: s, plaintext, keyId } = await withKey();
    const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(res.status).toBe(200);
    const body = res.json;
    expect(body).toMatchObject({
      id: `chatcmpl-${CALL_ID.slice(2)}`,
      object: 'chat.completion',
      model: 'stub-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: GV2_REPLY }, finish_reason: 'stop', logprobs: null }],
      usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
      system_fingerprint: null,
    });
    expect(Number.isSafeInteger(body.created)).toBe(true);
    expect(body.dkg).toEqual({
      call_id: CALL_ID,
      offering_id: `0x${'66'.repeat(32)}`,
      seller: { identity_id: '1', peer_id: '12D3KooWSeller', address: `0x${'88'.repeat(20)}` },
      served_units: '22',
      ask_per_unit_wei: '500000000000',
      cost_wei: '11000000000000',
      receipt: { auth_digest: `0x${'11'.repeat(32)}`, result_commitment: `0x${'22'.repeat(32)}`, seller_sig: `0x${'33'.repeat(65)}` },
      metering: {
        basis: 'pinned', tokenizer_kind: 'stub-words-v1', tokenizer_digest: expect.stringMatching(/^sha256:/),
        chat_template: 'openai-chat-count/v1', prompt_units: '17', tool_units: '0', completion_units: '5',
        truncated: false, provider_usage: { prompt_tokens: 17, completion_tokens: 5 },
      },
      recount: { verdict: 'match', reason: null, recount_units: '22' },
      key: { key_id: keyId, spent_wei: RECEIPT_WEI.toString(), remaining_wei: (10n ** 18n - RECEIPT_WEI).toString() },
    });
    expect(body.choices[0].message).not.toHaveProperty('tool_calls');
  });

  it('stream: buffered SSE — role chunk, content, finish, usage+dkg, [DONE]', async () => {
    const { server: s, plaintext } = await withKey();
    const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const frames = res.text.split('\n\n').filter(Boolean);
    expect(frames.every((frame) => frame.startsWith('data: '))).toBe(true);
    expect(frames.at(-1)).toBe('data: [DONE]');
    const events = frames.slice(0, -1).map((frame) => JSON.parse(frame.slice('data: '.length)));
    expect(events).toHaveLength(4);
    const id = `chatcmpl-${CALL_ID.slice(2)}`;
    for (const event of events) expect(event).toMatchObject({ id, object: 'chat.completion.chunk', model: 'stub-chat' });
    expect(events[0].choices).toEqual([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
    expect(events[1].choices).toEqual([{ index: 0, delta: { content: GV2_REPLY }, finish_reason: null }]);
    expect(events[2].choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    expect(events[3].choices).toEqual([]);
    expect(events[3].usage).toEqual({ prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 });
    expect(events[3].dkg.served_units).toBe('22');
    expect(new Set(events.map((event) => event.created)).size).toBe(1);
  });

  it('stream with tool calls: one tool_calls delta chunk and finish_reason tool_calls', async () => {
    const toolCall = { id: 'call_1', type: 'function' as const, function: { name: 'lookup', arguments: '{"q":"x"}' } };
    const { server: s, plaintext } = await withKey({
      marketplaceChatCompletion: async (input: any) => {
        input.spendGuard.admit(WORST_CASE_WEI);
        input.spendGuard.settle({ costWei: RECEIPT_WEI, servedUnits: 22n, delivery: 'served' });
        return fakeChatResult({ message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finishReason: 'tool_calls' });
      },
    });
    const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES, stream: true });
    const events = res.text.split('\n\n').filter(Boolean).slice(0, -1).map((frame) => JSON.parse(frame.slice(6)));
    expect(events).toHaveLength(4);
    expect(events[1].choices[0].delta).toEqual({
      tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
    });
    expect(events[2].choices[0].finish_reason).toBe('tool_calls');
    const plain = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(plain.json.choices[0].message).toEqual({ role: 'assistant', content: null, tool_calls: [toolCall] });
  });

  it('errors under stream:true are plain JSON with their HTTP status (never SSE)', async () => {
    const { server: s, plaintext } = await withKey({
      marketplaceChatCompletion: async () => { throw namedError('MarketplaceNotSubscribedError', 'no subscription'); },
    });
    const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES, stream: true });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.json.error.code).toBe('not_subscribed');
  });
});

describe('§9.6 error mapping (one case per row)', () => {
  const invoke = (code: string, delivery = 'not-served') =>
    namedError('MarketplaceInvokeError', `marketplace: invoke failed (${code}): x`, { code, delivery });
  const route = (reason: string, rejections: Array<{ offerId: string; reason: string }> = []) =>
    namedError('MarketplaceRouteError', `no route (${reason})`, { reason, rejections });
  const rows: Array<[string, Error, number, string, string]> = [
    ['request error', namedError('MarketplaceRequestError', 'bad', { code: 'invalid_tools', param: 'tools' }), 400, 'invalid_request_error', 'invalid_tools'],
    ['sparql too large', namedError('MarketplaceRequestError', 'too large', { code: 'invalid_sparql', param: 'sparql' }), 400, 'invalid_request_error', 'invalid_sparql'],
    ['model not found', namedError('MarketplaceModelNotFoundError', 'no offer', { model: 'x' }), 404, 'invalid_request_error', 'model_not_found'],
    ['not subscribed', namedError('MarketplaceNotSubscribedError', 'no sub'), 403, 'permission_error', 'not_subscribed'],
    ['no bucket', route('no-bucket'), 403, 'permission_error', 'no_plan_bucket'],
    ['max-units reason', route('max-units'), 400, 'invalid_request_error', 'max_units_exceeded'],
    ['every rejection max-units', route('no-eligible-offer', [{ offerId: 'o1', reason: 'max-units' }, { offerId: 'o2', reason: 'max-units' }]), 400, 'invalid_request_error', 'max_units_exceeded'],
    ['every rejection soft-ceiling', route('no-eligible-offer', [{ offerId: 'o1', reason: 'soft-ceiling' }]), 429, 'insufficient_quota', 'soft_ceiling'],
    ['no offers', route('no-offers'), 503, 'service_unavailable', 'no_offers'],
    ['other no-eligible-offer', route('no-eligible-offer', [{ offerId: 'o1', reason: 'price-cap' }, { offerId: 'o2', reason: 'max-units' }]), 503, 'service_unavailable', 'no_route'],
    ['key budget', namedError('MarketplaceSpendRefusedError', 'budget', { code: 'key_budget_exceeded' }), 429, 'insufficient_quota', 'key_budget_exceeded'],
    ['underfunded', invoke('UNDERFUNDED'), 429, 'insufficient_quota', 'underfunded'],
    ['context exceeded', invoke('CONTEXT_EXCEEDED'), 400, 'invalid_request_error', 'context_length_exceeded'],
    ['over max units', invoke('OVER_MAX_UNITS'), 400, 'invalid_request_error', 'max_units_exceeded'],
    ['bad payload', invoke('BAD_PAYLOAD'), 400, 'invalid_request_error', 'seller_rejected_request'],
    ['model mismatch', invoke('MODEL_MISMATCH'), 400, 'invalid_request_error', 'seller_rejected_request'],
    ['tools unsupported', invoke('TOOLS_UNSUPPORTED'), 400, 'invalid_request_error', 'seller_rejected_request'],
    ['upstream rate limited', invoke('UPSTREAM_RATE_LIMITED'), 429, 'rate_limit_error', 'upstream_rate_limited'],
    ['upstream timeout', invoke('UPSTREAM_TIMEOUT'), 504, 'api_error', 'upstream_timeout'],
    ['upstream error', invoke('UPSTREAM_ERROR'), 502, 'api_error', 'upstream_error'],
    ['upstream auth', invoke('UPSTREAM_AUTH'), 502, 'api_error', 'upstream_error'],
    ['execution failed', invoke('EXECUTION_FAILED'), 502, 'api_error', 'upstream_error'],
    ['connector unavailable', invoke('CONNECTOR_UNAVAILABLE'), 502, 'api_error', 'upstream_error'],
    ['seller not ready', invoke('SELLER_NOT_READY'), 502, 'api_error', 'upstream_error'],
    ['empty result', invoke('EMPTY_RESULT'), 502, 'api_error', 'upstream_error'],
    ['metering overrun', invoke('METERING_OVERRUN'), 502, 'api_error', 'upstream_error'],
    ['delivery unknown', invoke('DELIVERY_UNKNOWN', 'ambiguous'), 504, 'api_error', 'delivery_unknown'],
    ['bad receipt', invoke('BAD_RECEIPT', 'served'), 502, 'api_error', 'bad_receipt'],
    ['malformed receipt', invoke('MALFORMED_RECEIPT', 'served'), 502, 'api_error', 'bad_receipt'],
    ['malformed result', invoke('MALFORMED_RESULT', 'served'), 502, 'api_error', 'bad_receipt'],
    ['unverifiable seller', invoke('UNVERIFIABLE_SELLER', 'served'), 502, 'api_error', 'bad_receipt'],
    ...['EXPIRED', 'STALE_AUTHORIZATION', 'REPLAYED_CALL_ID', 'BAD_AUTH', 'WRONG_SELLER', 'BAD_ASK', 'SETTLEMENT_CLOSED',
      'UNKNOWN_OFFERING', 'UNSUPPORTED_VERSION', 'MALFORMED_REQUEST', 'WRONG_PAYLOAD_KIND', 'BUYER_NOT_ALLOWED', 'NOT_DELIVERED',
    ].map((code): [string, Error, number, string, string] => [`refusal ${code}`, invoke(code), 502, 'api_error', 'seller_refused']),
    ['invalid tool response', namedError('MarketplaceInvalidToolResponseError', 'bad tools'), 502, 'api_error', 'invalid_tool_response'],
    ['runtime off', new Error('marketplace is not running on this node (config.marketplace.enabled …)'), 503, 'service_unavailable', 'marketplace_unavailable'],
    ['anything else', new TypeError('boom secret-internal-detail'), 500, 'api_error', 'internal_error'],
  ];

  it.each(rows)('%s → %i %s/%s', async (_label, err, status, type, code) => {
    const { server: s, plaintext } = await withKey({ marketplaceChatCompletion: async () => { throw err; } });
    const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(res.status).toBe(status);
    expect(res.json.error).toMatchObject({ type, code });
    expect(Object.keys(res.json.error).sort()).toEqual(['code', 'dkg', 'message', 'param', 'type']);
    expect(res.json.error.dkg.charged_wei).toBe('0');
    if (code === 'internal_error') expect(res.text).not.toContain('secret-internal-detail');
    if (code === 'seller_rejected_request' || code === 'seller_refused' || code === 'upstream_error') {
      expect(res.json.error.dkg.reason).toBe((err as { code?: string }).code);
    }
    if (code === 'no_route') expect(res.json.error.dkg.rejections).toHaveLength(2);
    if (code === 'upstream_rate_limited' || code === 'no_offers' || code === 'no_route' || code === 'marketplace_unavailable') {
      expect(res.headers.get('retry-after')).toBe('1');
    }
    if (code === 'key_budget_exceeded' || code === 'underfunded' || code === 'soft_ceiling') {
      expect(res.headers.get('retry-after')).toBeNull();
    }
    // OpenAI SDKs obey x-should-retry before their status rule (they retry 429/≥500 by default).
    expect(res.headers.get('x-should-retry')).toBe(res.json.error.dkg.retryable ? 'true' : 'false');
  });

  it('the query route names max_rows for an over-cap route', () => {
    const err = namedError('MarketplaceRouteError', 'x', { reason: 'max-units', rejections: [] });
    expect(mapGatewayError(err, 'max_rows').param).toBe('max_rows');
    expect(mapGatewayError(err, 'max_tokens').param).toBe('max_tokens');
  });
});

describe('spend guard → key ledger (§10.3) and charged_wei', () => {
  it('served: the receipt value is booked against the key; the reservation returns to 0', async () => {
    const { server: s, plaintext, keyId } = await withKey();
    await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    const record = s.store.ledger().get(keyId)!;
    expect(record.usage).toMatchObject({ spentWei: RECEIPT_WEI, reservedWei: 0n, calls: 1, inferenceCalls: 1, queryCalls: 0, servedUnits: 22n });
  });

  it('not-served releases the hold with no usage change', async () => {
    const { server: s, plaintext, keyId } = await withKey({
      marketplaceChatCompletion: async (input: any) => {
        input.spendGuard.admit(WORST_CASE_WEI);
        expect(s.store.ledger().get(keyId)!.usage.reservedWei).toBe(WORST_CASE_WEI);
        input.spendGuard.settle({ costWei: 0n, servedUnits: 0n, delivery: 'not-served' });
        throw namedError('MarketplaceInvokeError', 'refused', { code: 'BAD_AUTH', delivery: 'not-served' });
      },
    });
    const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(res.json.error.dkg.charged_wei).toBe('0');
    expect(s.store.ledger().get(keyId)!.usage).toMatchObject({ spentWei: 0n, reservedWei: 0n, calls: 0 });
  });

  it('ambiguous: the worst case stays charged and charged_wei says so', async () => {
    const { server: s, plaintext, keyId } = await withKey({
      marketplaceChatCompletion: async (input: any) => {
        input.spendGuard.admit(WORST_CASE_WEI);
        input.spendGuard.settle({ costWei: WORST_CASE_WEI, servedUnits: 0n, delivery: 'ambiguous' });
        throw namedError('MarketplaceInvokeError', 'timeout', { code: 'DELIVERY_UNKNOWN', delivery: 'ambiguous' });
      },
    });
    const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(res.status).toBe(504);
    expect(res.json.error.dkg.charged_wei).toBe(WORST_CASE_WEI.toString());
    expect(s.store.ledger().get(keyId)!.usage.spentWei).toBe(WORST_CASE_WEI);
  });

  it('MALFORMED_RESULT: charged_wei is what the guard settled (worst case pre-receipt, receipt value post-receipt)', async () => {
    for (const [settledWei, label] of [[WORST_CASE_WEI, 'pre-receipt'], [RECEIPT_WEI, 'post-receipt']] as const) {
      const { server: s, plaintext } = await withKey({
        marketplaceChatCompletion: async (input: any) => {
          input.spendGuard.admit(WORST_CASE_WEI);
          input.spendGuard.settle({ costWei: settledWei, servedUnits: settledWei === RECEIPT_WEI ? 22n : 0n, delivery: 'served' });
          throw namedError('MarketplaceInvokeError', 'malformed', { code: 'MALFORMED_RESULT', delivery: 'served' });
        },
      });
      const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
      expect(res.status, label).toBe(502);
      expect(res.json.error.code).toBe('bad_receipt');
      expect(res.json.error.dkg.charged_wei, label).toBe(settledWei.toString());
      await server!.close();
      server = undefined;
    }
  });

  it('invalid tool response is charged at the receipt value', async () => {
    const { server: s, plaintext } = await withKey({
      marketplaceChatCompletion: async (input: any) => {
        input.spendGuard.admit(WORST_CASE_WEI);
        input.spendGuard.settle({ costWei: RECEIPT_WEI, servedUnits: 22n, delivery: 'served' });
        throw namedError('MarketplaceInvalidToolResponseError', 'tool not offered');
      },
    });
    const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(res.status).toBe(502);
    expect(res.json.error.dkg.charged_wei).toBe(RECEIPT_WEI.toString());
  });

  it('a budget below the worst case refuses with key_budget_exceeded and the admit error passes through unchanged', async () => {
    const fake = makeFakeAgent({
      marketplaceChatCompletion: async (input: any) => {
        try {
          input.spendGuard.admit(WORST_CASE_WEI);
        } catch (err) {
          expect((err as Error).name).toBe('MarketplaceSpendRefusedError');
          expect((err as { remainingWei?: bigint }).remainingWei).toBe(WORST_CASE_WEI - 1n);
          throw err;
        }
        throw new Error('admit should have refused');
      },
    });
    server = await startGatewayServer({ agent: fake.agent });
    const { plaintext, keyId } = await mintKey(server.store, { budgetWei: WORST_CASE_WEI - 1n });
    const res = await chat(server, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(res.status).toBe(429);
    expect(res.json.error).toMatchObject({ type: 'insufficient_quota', code: 'key_budget_exceeded' });
    expect(server.store.ledger().get(keyId)!.usage).toMatchObject({ spentWei: 0n, reservedWei: 0n });
  });

  it('an internal error after a settle reports the settled charge in the body and the log (GAT-2)', async () => {
    const { server: s, plaintext, keyId } = await withKey({
      marketplaceChatCompletion: async (input: any) => {
        input.spendGuard.admit(WORST_CASE_WEI);
        input.spendGuard.settle({ costWei: WORST_CASE_WEI, servedUnits: 0n, delivery: 'ambiguous' });
        throw new SyntaxError('Cannot convert x to a BigInt');
      },
    });
    const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatchObject({ code: 'internal_error', dkg: { charged_wei: WORST_CASE_WEI.toString(), retryable: false } });
    expect(res.headers.get('x-should-retry')).toBe('false');
    expect(s.store.ledger().get(keyId)!.usage.spentWei).toBe(WORST_CASE_WEI);
    expect(s.logs.join('\n')).toContain(`charged_wei=${WORST_CASE_WEI}`);
    expect(res.text).not.toContain('BigInt');
  });

  it('a charged failure is never retryable: x-should-retry false and no Retry-After, whatever its code (GAT-3)', async () => {
    const cases: Array<[string, () => Error, bigint]> = [
      ['delivery unknown', () => namedError('MarketplaceInvokeError', 'timeout', { code: 'DELIVERY_UNKNOWN', delivery: 'ambiguous' }), WORST_CASE_WEI],
      ['bad receipt', () => namedError('MarketplaceInvokeError', 'bad', { code: 'BAD_RECEIPT', delivery: 'served' }), WORST_CASE_WEI],
      ['invalid tool response', () => namedError('MarketplaceInvalidToolResponseError', 'tool not offered'), RECEIPT_WEI],
      // A retryable code that nonetheless carries a charge loses its retry hint.
      ['charged upstream error', () => namedError('MarketplaceInvokeError', 'x', { code: 'UPSTREAM_RATE_LIMITED', delivery: 'served' }), RECEIPT_WEI],
    ];
    for (const [label, makeError, settled] of cases) {
      const { server: s, plaintext } = await withKey({
        marketplaceChatCompletion: async (input: any) => {
          input.spendGuard.admit(WORST_CASE_WEI);
          input.spendGuard.settle({ costWei: settled, servedUnits: 22n, delivery: 'served' });
          throw makeError();
        },
      });
      const res = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
      expect(res.json.error.dkg, label).toMatchObject({ charged_wei: settled.toString(), retryable: false });
      expect(res.headers.get('x-should-retry'), label).toBe('false');
      expect(res.headers.get('retry-after'), label).toBeNull();
      await server!.close();
      server = undefined;
    }
    // An uncharged, retryable refusal keeps both hints.
    const { server: s, plaintext } = await withKey({
      marketplaceChatCompletion: async () => { throw namedError('MarketplaceInvokeError', 'x', { code: 'UPSTREAM_RATE_LIMITED', delivery: 'not-served' }); },
    });
    const ok = await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(ok.status).toBe(429);
    expect(ok.headers.get('x-should-retry')).toBe('true');
    expect(ok.headers.get('retry-after')).toBe('1');
    // Pre-body rejections carry it too.
    const unauthorized = await getJson(`${s.base}/models`, bearer('dkg_gw_00000000_' + 'A'.repeat(43)));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('x-should-retry')).toBe('false');
  });

  it('a hold the agent never settles is released (defensive)', async () => {
    const { server: s, plaintext, keyId } = await withKey({
      marketplaceChatCompletion: async (input: any) => {
        input.spendGuard.admit(WORST_CASE_WEI);
        throw new Error('bug: no settle');
      },
    });
    await chat(s, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(s.store.ledger().get(keyId)!.usage.reservedWei).toBe(0n);
  });
});

describe('/query and /models', () => {
  it('query: body checks, allowQuery scope, and the dkg.query.result shape', async () => {
    const fake = makeFakeAgent();
    server = await startGatewayServer({ agent: fake.agent });
    const { plaintext, keyId } = await mintKey(server.store);
    expect((await query(server, plaintext, {})).json.error).toMatchObject({ code: 'invalid_sparql', param: 'sparql' });
    expect((await query(server, plaintext, { sparql: 'x'.repeat(8193) })).json.error.code).toBe('invalid_sparql');
    expect((await query(server, plaintext, { sparql: 'SELECT 1', max_rows: 10_001 })).json.error)
      .toMatchObject({ code: 'invalid_parameter', param: 'max_rows' });
    const res = await query(server, plaintext, { sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 5', max_rows: 100 });
    expect(res.status).toBe(200);
    expect(fake.calls.at(-1)!.input).toMatchObject({ sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 5', maxRows: 100 });
    expect(res.json).toMatchObject({
      object: 'dkg.query.result', id: CALL_ID, result: { bindings: [{ s: 'urn:x' }] }, row_count: 1, aborted: null,
      usage: { admission_units: 3, delivery_units: 1, total_units: 4 },
    });
    expect(res.json.dkg).toMatchObject({
      served_units: '4', cost_wei: (4n * ASK_WEI).toString(),
      metering: { schedule_digest: expect.stringMatching(/^sha256:/), admission_units: '3', delivery_units: '1' },
      key: { key_id: keyId, spent_wei: (4n * ASK_WEI).toString() },
    });
    expect(server.store.ledger().get(keyId)!.usage).toMatchObject({ queryCalls: 1, inferenceCalls: 0 });

    const noQuery = await mintKey(server.store, { allowQuery: false });
    const refused = await query(server, noQuery.plaintext, { sparql: 'SELECT 1' });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatchObject({ type: 'permission_error', code: 'query_not_allowed' });
  });

  it('models: the OpenAI list filtered by the key allowlist; context_length is a number', async () => {
    const fake = makeFakeAgent();
    server = await startGatewayServer({ agent: fake.agent });
    const all = await mintKey(server.store);
    const scoped = await mintKey(server.store, { modelAllowlist: ['stub-chat'] });
    const everything = await getJson(`${server.base}/models`, bearer(all.plaintext));
    expect(everything.json.object).toBe('list');
    expect(everything.json.data.map((m: { id: string }) => m.id)).toEqual(['other-chat', 'stub-chat']);
    const only = await getJson(`${server.base}/models`, bearer(scoped.plaintext));
    expect(only.json.data).toEqual([{
      id: 'stub-chat', object: 'model', created: 0, owned_by: 'dkg-marketplace', context_length: 32768,
      dkg: {
        offers: 2, sellers: ['1', '3'], min_ask_per_unit_wei: '500000000000', metering_bases: ['pinned'],
        tokenizer_kinds: ['stub-words-v1'], provenance_classes: ['upstream-claimed'], tool_transports: ['native'], routable: true,
      },
    }]);
    expect(everything.json.data[0]).not.toHaveProperty('context_length');
  });
});

describe('per-key rps and the concurrency cap', () => {
  it('rps: the (rps+1)-th request inside one second is 429 rate_limit_exceeded with Retry-After', async () => {
    const fake = makeFakeAgent();
    const nowMs = 1_800_000_000_000;
    server = await startGatewayServer({ agent: fake.agent, nowMs: () => nowMs });
    const { plaintext } = await mintKey(server.store, { rps: 2 });
    expect((await getJson(`${server.base}/models`, bearer(plaintext))).status).toBe(200);
    expect((await getJson(`${server.base}/models`, bearer(plaintext))).status).toBe(200);
    const limited = await getJson(`${server.base}/models`, bearer(plaintext));
    expect(limited.status).toBe(429);
    expect(limited.json.error).toMatchObject({ type: 'rate_limit_error', code: 'rate_limit_exceeded' });
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(limited.headers.get('connection')).toBe('close');
  });

  it('concurrency: beyond maxConcurrent another key gets 503 gateway_busy (after its body); slots free on completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = makeFakeAgent({
      marketplaceChatCompletion: async (input: any) => {
        await gate;
        input.spendGuard.admit(WORST_CASE_WEI);
        input.spendGuard.settle({ costWei: RECEIPT_WEI, servedUnits: 22n, delivery: 'served' });
        return fakeChatResult();
      },
    });
    server = await startGatewayServer({ agent: fake.agent, config: { maxConcurrent: 1 } });
    const holder = await mintKey(server.store);
    const other = await mintKey(server.store);
    const first = chat(server, holder.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const busy = await chat(server, other.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(busy.status).toBe(503);
    expect(busy.json.error).toMatchObject({ type: 'api_error', code: 'gateway_busy' });
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(busy.headers.get('x-should-retry')).toBe('true');
    // The holding key is at its own cap (ceil(1/2) = 1): refused BEFORE its body is read.
    const own = await chat(server, holder.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(own.status).toBe(429);
    expect(own.json.error).toMatchObject({ type: 'rate_limit_error', code: 'rate_limit_exceeded' });
    expect(own.headers.get('connection')).toBe('close');
    release();
    expect((await first).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await chat(server, other.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES })).status).toBe(200);
    expect((await chat(server, holder.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES })).status).toBe(200);
  });

  it('one key holds at most ceil(maxConcurrent/2) calls: its next call is 429, another key still gets a slot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = makeFakeAgent({
      marketplaceChatCompletion: async (input: any) => {
        input.spendGuard.admit(WORST_CASE_WEI);
        await gate;
        input.spendGuard.settle({ costWei: RECEIPT_WEI, servedUnits: 22n, delivery: 'served' });
        return fakeChatResult();
      },
    });
    server = await startGatewayServer({ agent: fake.agent, config: { maxConcurrent: 4 } });
    const greedy = await mintKey(server.store);
    const polite = await mintKey(server.store);
    const held = [
      chat(server, greedy.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES }),
      chat(server, greedy.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = await chat(server, greedy.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(third.status).toBe(429);
    expect(third.json.error).toMatchObject({ code: 'rate_limit_exceeded', dkg: { retryable: true, charged_wei: '0' } });
    expect(third.json.error.message).toContain('2 requests in flight');
    expect(third.headers.get('retry-after')).toBe('1');
    expect(third.headers.get('x-should-retry')).toBe('true');
    const theirs = chat(server, polite.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    expect((await theirs).status).toBe(200);
    for (const call of held) expect((await call).status).toBe(200);
  });

  it('a slow body holds only its own key: a no-scope key trickling bodies cannot starve another key (GAT-1)', async () => {
    const fake = makeFakeAgent();
    server = await startGatewayServer({ agent: fake.agent, config: { maxConcurrent: 2 } });
    const attacker = await mintKey(server.store, { modelAllowlist: [], allowQuery: false, budgetWei: 1n });
    const victim = await mintKey(server.store);
    const port = Number(new URL(server.url).port);
    const head = (key: string) => [
      'POST /api/marketplace/gateway/v1/chat/completions HTTP/1.1',
      'Host: 127.0.0.1',
      `Authorization: Bearer ${key}`,
      'Content-Type: application/json',
      'Content-Length: 100',
      '', '{',
    ].join('\r\n');
    const sockets: Socket[] = [];
    const replies: string[] = [];
    try {
      // More trickling requests than the whole gateway cap (2): one holds the
      // attacker's own slot; the rest are refused before any body byte.
      for (let i = 0; i < 3; i += 1) {
        const socket = connect(port, '127.0.0.1');
        sockets.push(socket);
        const index = i;
        replies[index] = '';
        socket.on('data', (chunk) => { replies[index] += chunk.toString('utf8'); });
        socket.on('error', () => {});
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        socket.write(head(attacker.plaintext));
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(replies[0], 'the first trickle is still reading its body').toBe('');
      for (const reply of replies.slice(1)) {
        expect(reply).toMatch(/^HTTP\/1\.1 429 /);
        expect(reply.toLowerCase()).toContain('connection: close');
        expect(reply).toContain('"rate_limit_exceeded"');
      }
      // The victim is unaffected: the gateway-wide slots were never taken.
      const models = await getJson(`${server.base}/models`, bearer(victim.plaintext));
      expect(models.status).toBe(200);
      const answer = await chat(server, victim.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES });
      expect(answer.status).toBe(200);
      expect(fake.calls.filter((c) => c.method === 'chat')).toHaveLength(1);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  it('a client that disconnects mid-call keeps its slots until the agent call completes (no cap bypass)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = 0;
    const fake = makeFakeAgent({
      marketplaceChatCompletion: async (input: any) => {
        input.spendGuard.admit(WORST_CASE_WEI);
        await gate;
        input.spendGuard.settle({ costWei: RECEIPT_WEI, servedUnits: 22n, delivery: 'served' });
        finished += 1;
        return fakeChatResult();
      },
    });
    server = await startGatewayServer({ agent: fake.agent, config: { maxConcurrent: 1 } });
    const { plaintext, keyId } = await mintKey(server.store);
    const other = await mintKey(server.store);
    const abort = new AbortController();
    const first = fetch(`${server.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(plaintext) },
      body: JSON.stringify({ model: 'stub-chat', messages: GV2_MESSAGES }),
      signal: abort.signal,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Both the gateway-wide slot and the key's own slot stay held.
    expect((await chat(server, other.plaintext, { model: 'stub-chat', messages: GV2_MESSAGES })).status).toBe(503);
    expect((await chat(server, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES })).status).toBe(429);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toBe(1);
    // The abandoned call still completed and its charge stands.
    expect(server.store.ledger().get(keyId)!.usage.spentWei).toBe(RECEIPT_WEI);
    expect((await chat(server, plaintext, { model: 'stub-chat', messages: GV2_MESSAGES })).status).toBe(200);
  });
});

describe('hygiene', () => {
  it('logs never carry the key, the Authorization header, or prompt text', async () => {
    const prompt = 'TOP-SECRET-PROMPT-TEXT';
    const fake = makeFakeAgent({ marketplaceChatCompletion: async () => { throw new TypeError('unexpected'); } });
    server = await startGatewayServer({ agent: fake.agent });
    const { plaintext, keyId } = await mintKey(server.store);
    await chat(server, plaintext, { model: 'stub-chat', messages: [{ role: 'user', content: prompt }] });
    await getJson(`${server.base}/models`, bearer(`dkg_gw_0badc0de_${'A'.repeat(43)}`));
    const logs = server.logs.join('\n');
    expect(logs).toContain(keyId);
    expect(logs).not.toContain(plaintext);
    expect(logs).not.toContain(plaintext.slice(-43));
    expect(logs).not.toContain(prompt);
    expect(logs).not.toMatch(/authorization|bearer/i);
  });

  it('the gateway modules never value-import the agent runtime root', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = resolve(here, '../src');
    for (const file of [
      'daemon/marketplace-gateway-dispatch.ts',
      'daemon/routes/marketplace-gateway.ts',
      'daemon/routes/marketplace-gateway-errors.ts',
      'daemon/routes/marketplace-keys.ts',
      'marketplace-gateway-key-store.ts',
      'marketplace-codex-oauth-flow.ts',
      'marketplace-connector-config.ts',
    ]) {
      const source = readFileSync(join(src, file), 'utf8');
      const rootImports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'@origintrail-official\/dkg-agent'/gms)];
      for (const match of rootImports) expect(match[1], `${file}: ${match[0]}`).toBe('type ');
    }
  });
});
