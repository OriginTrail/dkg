// Unit tests for the deterministic OpenAI-compatible devnet upstream
// (llm-stub.mjs). No devnet needed: the stub runs in-process on an ephemeral
// loopback port. Golden vectors are copied from the spec
// (agent-docs/plans/2026-10-27-rfc27-sellers-gateway.md §3.2, GV-1..GV-5) —
// the usage the stub reports MUST equal what both marketplace seats meter
// with the pinned `stub-words-v1` engine under `openai-chat-count/v1`.
//
//   node --test devnet/marketplace-rfc27/llm-stub.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEFAULT_MODEL,
  DEFAULT_PORT,
  PER_MESSAGE_TOKENS,
  PER_REPLY_PRIMER_TOKENS,
  createLlmStub,
  isLoopbackHost,
  parseStubSeams,
  stubReply,
  stubToolCalls,
  stubUsage,
  words,
} from './llm-stub.mjs';

const KEY = 'devnet-stub-key';
const GV2_MESSAGES = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'hello marketplace world' },
];
const GV2_REPLY = 'STUB:WORLD MARKETPLACE HELLO :: ok';
const GV3_REPLY = 'STUB:WORLD MARKETPLACE HELLO';
const GV4_MESSAGES = [{ role: 'user', content: '  multiple   spaces\tand\nnewlines  ' }];
const GV5_MESSAGES = [{ role: 'user', content: '' }];
const TOOLS = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];

/** Start a stub on an ephemeral port; returns { stub, base, close }. */
async function startStub(opts = {}) {
  const stub = createLlmStub({ apiKey: KEY, log: () => {}, ...opts });
  const port = await stub.listen(0, '127.0.0.1');
  return { stub, base: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

async function post(base, path, body, { auth = `Bearer ${KEY}` } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth !== null) headers.authorization = auth;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE */
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** `data: <json>\n\n` events → [...json, '[DONE]'] (throws on any other framing). */
function sseEvents(text) {
  assert.ok(text.endsWith('\n\n'), 'SSE body ends on an event boundary');
  return text.slice(0, -2).split('\n\n').map((block) => {
    assert.match(block, /^data: [^\n]*$/, `one data line per event: ${JSON.stringify(block)}`);
    const payload = block.slice('data: '.length);
    return payload === '[DONE]' ? payload : JSON.parse(payload);
  });
}

test('constants match the spec', () => {
  assert.equal(DEFAULT_PORT, 18080);
  assert.equal(DEFAULT_MODEL, 'stub-chat');
  assert.equal(PER_MESSAGE_TOKENS, 3);
  assert.equal(PER_REPLY_PRIMER_TOKENS, 3);
});

test('GV-1: words() is the stub-words-v1 count', () => {
  const vectors = [
    ['', 0],
    ['   ', 0],
    ['hello marketplace world', 3],
    ['  multiple   spaces\tand\nnewlines  ', 4],
    [GV2_REPLY, 5],
    ['{"a":1}', 1],
  ];
  for (const [text, count] of vectors) assert.equal(words(text).length, count, JSON.stringify(text));
});

test('GV-2: reply, finish and usage {17, 5, 22}', () => {
  const reply = stubReply('hello marketplace world');
  assert.deepEqual(reply, { content: GV2_REPLY, finishReason: 'stop', completionTokens: 5 });
  assert.deepEqual(stubUsage(GV2_MESSAGES, reply.completionTokens), { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 });
});

test('GV-3: max_tokens 3 truncates to 3 words with finish length, usage {17, 3, 20}', () => {
  const reply = stubReply('hello marketplace world', 3);
  assert.deepEqual(reply, { content: GV3_REPLY, finishReason: 'length', completionTokens: 3 });
  assert.deepEqual(stubUsage(GV2_MESSAGES, reply.completionTokens), { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 });
  // Absent, zero or negative caps mean uncapped.
  for (const cap of [undefined, 0, -1, Number.NaN]) assert.equal(stubReply('hello marketplace world', cap).content, GV2_REPLY);
});

test('GV-4: whitespace runs count as separators, usage {11, 6, 17}', () => {
  const reply = stubReply(GV4_MESSAGES[0].content);
  assert.deepEqual(reply, { content: 'STUB:NEWLINES AND SPACES MULTIPLE :: ok', finishReason: 'stop', completionTokens: 6 });
  assert.deepEqual(stubUsage(GV4_MESSAGES, reply.completionTokens), { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 });
});

test('GV-5: an empty prompt meters 7 and replies "STUB: :: ok"', () => {
  const reply = stubReply('');
  assert.deepEqual(reply, { content: 'STUB: :: ok', finishReason: 'stop', completionTokens: 3 });
  assert.equal(stubUsage(GV5_MESSAGES, reply.completionTokens).prompt_tokens, 7);
});

test('seams: leading tokens parsed and stripped; out-of-range status ignored; delay capped', () => {
  assert.deepEqual(parseStubSeams('__stub_status=429__ hello world'), { text: 'hello world', delayMs: 0, status: 429 });
  assert.deepEqual(parseStubSeams('__stub_delay_ms=25__ __stub_status=503__ x'), { text: 'x', delayMs: 25, status: 503 });
  assert.deepEqual(parseStubSeams('__stub_status=200__ x'), { text: 'x', delayMs: 0, status: null });
  assert.equal(parseStubSeams('__stub_delay_ms=999999__ x').delayMs, 60_000);
  // Only LEADING tokens are seams; text without seams is returned verbatim.
  assert.deepEqual(parseStubSeams('hi __stub_status=500__'), { text: 'hi __stub_status=500__', delayMs: 0, status: null });
});

test('tool-call reply: deterministic id, echo of the prompt word count, one completion word', () => {
  const { toolCalls, completionTokens } = stubToolCalls(GV2_MESSAGES, 'lookup', 'hello marketplace world');
  const id = 'call_stub_' + createHash('sha256').update(JSON.stringify(GV2_MESSAGES) + '|lookup').digest('hex').slice(0, 16);
  assert.deepEqual(toolCalls, [{ id, type: 'function', function: { name: 'lookup', arguments: '{"echo":3}' } }]);
  assert.equal(completionTokens, 1);
});

test('isLoopbackHost accepts loopback literals only', () => {
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '10.0.0.1', 'example.com', '', undefined]) assert.equal(isLoopbackHost(h), false, String(h));
});

test('listen() refuses a non-loopback host', async () => {
  const stub = createLlmStub({ log: () => {} });
  await assert.rejects(stub.listen(0, '0.0.0.0'), /loopback only/);
});

test('HTTP: bearer enforcement, healthz and models', async () => {
  const { base, stub, close } = await startStub();
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200, 'healthz needs no auth');
    assert.equal((await health.json()).ok, true);

    const missing = await post(base, '/v1/chat/completions', { messages: GV2_MESSAGES }, { auth: null });
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.json.error, { message: 'missing bearer', type: 'invalid_request_error', code: 'invalid_api_key' });
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer');

    const bad = await post(base, '/v1/chat/completions', { messages: GV2_MESSAGES }, { auth: 'Bearer nope' });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error.message, 'bad key');
    assert.equal(stub.state.lastAuthorization, 'Bearer nope');
    assert.equal(stub.state.calls, 0, 'refused requests are not counted');

    const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(models.status, 200);
    assert.deepEqual(await models.json(), { object: 'list', data: [{ id: 'stub-chat', object: 'model', created: 0, owned_by: 'dkg-devnet-stub' }] });

    const notFound = await post(base, '/v1/nope', {});
    assert.equal(notFound.status, 404);
    const badJson = await post(base, '/v1/chat/completions', '{not json');
    assert.equal(badJson.status, 400);
  } finally {
    await close();
  }
  const anon = await startStub({ allowAnon: true, apiKey: undefined });
  try {
    const r = await post(anon.base, '/v1/chat/completions', { messages: GV2_MESSAGES }, { auth: null });
    assert.equal(r.status, 200, 'allowAnon serves without a bearer');
  } finally {
    await anon.close();
  }
});

test('HTTP: non-stream GV-2 and GV-3', async () => {
  const { base, stub, close } = await startStub();
  try {
    const r = await post(base, '/v1/chat/completions', { model: 'stub-chat', messages: GV2_MESSAGES, max_tokens: 256 });
    assert.equal(r.status, 200);
    assert.match(r.json.id, /^chatcmpl-stub-[0-9a-f]{16}$/);
    assert.equal(r.json.object, 'chat.completion');
    assert.equal(r.json.model, 'stub-chat');
    assert.deepEqual(r.json.choices, [{ index: 0, message: { role: 'assistant', content: GV2_REPLY }, finish_reason: 'stop', logprobs: null }]);
    assert.deepEqual(r.json.usage, { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 });
    assert.equal(stub.state.lastAuthorization, `Bearer ${KEY}`);
    assert.equal(stub.state.lastBody.max_tokens, 256);
    assert.equal(stub.state.calls, 1);

    const capped = await post(base, '/v1/chat/completions', { messages: GV2_MESSAGES, max_completion_tokens: 3 });
    assert.equal(capped.json.choices[0].message.content, GV3_REPLY);
    assert.equal(capped.json.choices[0].finish_reason, 'length');
    assert.deepEqual(capped.json.usage, { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 });
  } finally {
    await close();
  }
});

test('HTTP: SSE framing — role chunk, word deltas, finish, usage chunk, [DONE]', async () => {
  const { base, close } = await startStub();
  try {
    const r = await post(base, '/v1/chat/completions', { messages: GV2_MESSAGES, stream: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/event-stream/);
    const events = sseEvents(r.text);
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1);
    const id = chunks[0].id;
    for (const c of chunks) {
      assert.equal(c.id, id);
      assert.equal(c.object, 'chat.completion.chunk');
    }
    assert.deepEqual(chunks[0].choices, [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
    const usage = chunks.at(-1);
    assert.deepEqual(usage.choices, []);
    assert.deepEqual(usage.usage, { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 });
    const finish = chunks.at(-2);
    assert.deepEqual(finish.choices, [{ index: 0, delta: {}, finish_reason: 'stop' }]);
    const deltas = chunks.slice(1, -2);
    assert.equal(deltas.length, 5, 'one delta per reply word');
    assert.equal(deltas.map((c) => c.choices[0].delta.content).join(''), GV2_REPLY);
  } finally {
    await close();
  }
});

test('HTTP: tool calls (JSON and SSE) when tool_choice forces a function', async () => {
  const { base, close } = await startStub();
  try {
    const required = await post(base, '/v1/chat/completions', { messages: GV2_MESSAGES, tools: TOOLS, tool_choice: 'required' });
    assert.equal(required.status, 200);
    const choice = required.json.choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.content, null);
    assert.deepEqual(choice.message.tool_calls, stubToolCalls(GV2_MESSAGES, 'lookup', 'hello marketplace world').toolCalls);
    assert.deepEqual(required.json.usage, { prompt_tokens: 17, completion_tokens: 1, total_tokens: 18 }, 'tools are not counted in the prompt');

    const named = await post(base, '/v1/chat/completions', {
      messages: GV2_MESSAGES,
      tools: [...TOOLS, { type: 'function', function: { name: 'other' } }],
      tool_choice: { type: 'function', function: { name: 'other' } },
    });
    assert.equal(named.json.choices[0].message.tool_calls[0].function.name, 'other');

    const auto = await post(base, '/v1/chat/completions', { messages: GV2_MESSAGES, tools: TOOLS, tool_choice: 'auto' });
    assert.equal(auto.json.choices[0].message.content, GV2_REPLY, 'any other tool_choice gets the text reply');

    const noName = await post(base, '/v1/chat/completions', { messages: GV2_MESSAGES, tools: [{ type: 'function', function: {} }], tool_choice: 'required' });
    assert.equal(noName.status, 400);

    const streamed = await post(base, '/v1/chat/completions', { messages: GV2_MESSAGES, tools: TOOLS, tool_choice: 'required', stream: true });
    const chunks = sseEvents(streamed.text).slice(0, -1);
    assert.equal(chunks.length, 4, 'role, ONE tool_calls delta, finish, usage');
    assert.deepEqual(chunks[1].choices[0].delta.tool_calls, choice.message.tool_calls.map((c, index) => ({ index, ...c })));
    assert.equal(chunks[2].choices[0].finish_reason, 'tool_calls');
  } finally {
    await close();
  }
});

test('HTTP: seams force a status or a delay without changing the metered usage', async () => {
  const { base, stub, close } = await startStub();
  try {
    const forced = await post(base, '/v1/chat/completions', { messages: [{ role: 'user', content: '__stub_status=429__ hello' }] });
    assert.equal(forced.status, 429);
    assert.deepEqual(forced.json, { error: { message: 'stub forced status 429', type: 'stub_error' } });

    const started = Date.now();
    const delayed = await post(base, '/v1/chat/completions', { messages: [{ role: 'user', content: '__stub_delay_ms=60__ hello marketplace world' }] });
    assert.ok(Date.now() - started >= 55, 'the delay seam sleeps');
    assert.equal(delayed.json.choices[0].message.content, GV2_REPLY, 'seam tokens are stripped from the reply text');
    // Usage counts the RAW message the seller sent (seam token included): 4 + 1 + 3 + 3.
    assert.equal(delayed.json.usage.prompt_tokens, 11);
    assert.equal(stub.state.lastBody.messages[0].content, '__stub_delay_ms=60__ hello marketplace world');
  } finally {
    await close();
  }
});
