import { describe, expect, it } from 'vitest';
import {
  CHAT_PAYLOAD_SCHEMA,
  CHAT_RESULT_SCHEMA,
  CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST,
  MAX_SERVE_RESULT_BYTES,
  parseChatServePayload,
  parseChatServeResult,
  parseQueryServeResult,
  QUERY_COST_SCHEDULE_V1_DIGEST,
  QUERY_RESULT_SCHEMA,
  STUB_WORDS_DIGEST,
} from '../src/index.js';

type Json = Record<string, unknown>;

function payload(overrides: Json = {}): Json {
  return {
    schema: 'openai-chat/v1',
    model: 'stub-chat',
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hello marketplace world' },
    ],
    max_tokens: 256,
    ...overrides,
  };
}

/** The GV-2 pinned result an honest stub-words seller emits. */
function chatResult(overrides: Json = {}, message: Json = {}, metering: Json = {}): Json {
  return {
    schema: 'openai-chat-result/v1',
    model: 'stub-chat',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'STUB:WORLD MARKETPLACE HELLO :: ok', ...message },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
    metering: {
      basis: 'pinned',
      tokenizer: { kind: 'stub-words-v1', digest: STUB_WORDS_DIGEST },
      chatTemplate: { id: 'openai-chat-count/v1', digest: CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST },
      promptUnits: 17,
      toolUnits: 0,
      completionUnits: 5,
      servedUnits: 22,
      truncated: false,
      providerUsage: { prompt_tokens: 17, completion_tokens: 5 },
      ...metering,
    },
    ...overrides,
  };
}

function queryResult(overrides: Json = {}, metering: Json = {}): Json {
  return {
    schema: 'sparql-result/v1',
    result: { bindings: [{ s: 'a' }, { s: 'b' }] },
    rowCount: 2,
    metering: {
      scheduleDigest: QUERY_COST_SCHEDULE_V1_DIGEST,
      admissionUnits: 3,
      deliveryUnits: 1,
      servedUnits: 4,
      rowCount: 2,
      ...metering,
    },
    ...overrides,
  };
}

describe('constants', () => {
  it('pins the schema ids and the result cap', () => {
    expect([CHAT_PAYLOAD_SCHEMA, CHAT_RESULT_SCHEMA, QUERY_RESULT_SCHEMA]).toEqual([
      'openai-chat/v1',
      'openai-chat-result/v1',
      'sparql-result/v1',
    ]);
    expect(MAX_SERVE_RESULT_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('parseChatServePayload', () => {
  it('accepts a minimal payload and returns normalized wire objects and tool options', () => {
    const parsed = parseChatServePayload(payload());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload).toEqual(payload());
    expect(parsed.options).toEqual({});
  });

  it('canonicalizes the model and carries tools, sampler fields and stop', () => {
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    const parsed = parseChatServePayload(
      payload({
        model: ' Stub-Chat ',
        tools,
        tool_choice: 'required',
        parallel_tool_calls: false,
        temperature: 0.7,
        top_p: 1,
        seed: 42,
        stop: ['\n\n', 'END'],
        unknown_field: 'ignored',
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.model).toBe('stub-chat');
    expect(parsed.payload).toMatchObject({ temperature: 0.7, top_p: 1, seed: 42, stop: ['\n\n', 'END'], parallel_tool_calls: false });
    expect(parsed.payload).not.toHaveProperty('unknown_field');
    expect(parsed.options).toEqual({ tools, toolChoice: 'required', parallelToolCalls: false });
  });

  it('is idempotent: re-parsing the JSON of a parsed payload yields the same payload', () => {
    const first = parseChatServePayload(payload({ tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'auto' }));
    if (!first.ok) throw new Error(first.detail);
    const second = parseChatServePayload(JSON.parse(JSON.stringify(first.payload)));
    expect(second).toEqual(first);
  });

  it('rejects every malformed field', () => {
    const rejections: Json[] = [
      payload({ schema: 'openai-chat/v2' }),
      payload({ model: 'Not A Model!' }),
      payload({ model: 7 }),
      payload({ messages: [] }),
      payload({ messages: [{ role: 'user', content: [{ type: 'text', text: 'parts' }] }] }),
      payload({ tools: [{ type: 'browser' }] }),
      payload({ tool_choice: 'sometimes' }),
      payload({ parallel_tool_calls: 'yes' }),
      payload({ max_tokens: 0 }),
      payload({ max_tokens: 1_000_001 }),
      payload({ max_tokens: 2.5 }),
      payload({ max_tokens: undefined }),
      payload({ temperature: 2.5 }),
      payload({ temperature: Number.NaN }),
      payload({ top_p: -0.1 }),
      payload({ seed: 2 ** 60 }),
      payload({ stop: 'END' }),
      payload({ stop: ['a', 'b', 'c', 'd', 'e'] }),
      payload({ stop: [''] }),
      payload({ stop: ['x'.repeat(257)] }),
    ];
    for (const raw of rejections) expect(parseChatServePayload(raw).ok, JSON.stringify(raw)).toBe(false);
    expect(parseChatServePayload(null).ok).toBe(false);
    expect(parseChatServePayload([payload()]).ok).toBe(false);
  });

  it('applies the message bounds', () => {
    expect(parseChatServePayload(payload(), { maxMessages: 1 }).ok).toBe(false);
    expect(parseChatServePayload(payload(), { maxBytes: 20 }).ok).toBe(false);
  });
});

describe('parseChatServeResult', () => {
  it('accepts the GV-2 pinned result', () => {
    const parsed = parseChatServeResult(chatResult());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.metering.servedUnits).toBe(22);
    expect(parsed.result.choices[0].message.content).toBe('STUB:WORLD MARKETPLACE HELLO :: ok');
  });

  it('accepts tool calls with null content and keeps the parsed array as delivered', () => {
    const toolCalls = [{ type: 'function', id: 'call_stub_1', function: { arguments: '{"echo":3}', name: 'lookup' } }];
    const parsed = parseChatServeResult(
      chatResult(
        {
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 17, completion_tokens: 1, total_tokens: 18 },
        },
        {},
        { completionUnits: 1, servedUnits: 18 },
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // R4: the buyer counts JSON.stringify of the array as parsed — key order preserved.
    expect(JSON.stringify(parsed.result.choices[0].message.tool_calls)).toBe(JSON.stringify(toolCalls));
  });

  it('accepts a provider-reported result whose usage echoes the provider', () => {
    const parsed = parseChatServeResult(
      chatResult(
        { usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } },
        {},
        {
          basis: 'provider-reported',
          tokenizer: undefined,
          chatTemplate: undefined,
          promptUnits: 30,
          completionUnits: 5,
          servedUnits: 35,
          providerUsage: { prompt_tokens: 30, completion_tokens: 5 },
        },
      ),
    );
    expect(parsed.ok).toBe(true);
  });

  it('rejects the malformed-result matrix', () => {
    const call = { id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } };
    const rejections: unknown[] = [
      null,
      chatResult({ schema: 'openai-chat-result/v2' }),
      chatResult({ model: 'Stub-Chat' }),
      chatResult({ choices: [] }),
      chatResult({ choices: [{ index: 1, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }] }),
      chatResult({}, { role: 'user' }),
      chatResult({}, { content: 7 }),
      chatResult({}, { content: null }), // null content without tool calls
      chatResult({ choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'eos' }] }),
      chatResult({ choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'tool_calls' }] }),
      chatResult({}, { tool_calls: [] }),
      chatResult({}, { tool_calls: [{ ...call, extra: 1 }] }), // extra key
      chatResult({}, { tool_calls: [{ id: 'c', type: 'function', function: { name: 'f' } }] }), // missing key
      chatResult({}, { tool_calls: [{ ...call, function: { ...call.function, strict: true } }] }),
      chatResult({ usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 23 } }),
      chatResult({ usage: { prompt_tokens: 16, completion_tokens: 6, total_tokens: 22 } }),
      chatResult({ usage: { prompt_tokens: 17.5, completion_tokens: 5, total_tokens: 22 } }),
      chatResult({}, {}, { servedUnits: 23 }), // ≠ sum of parts
      chatResult({}, {}, { promptUnits: 2 ** 53, servedUnits: 2 ** 53 + 5 }), // not a safe integer
      chatResult({}, {}, { promptUnits: -1, servedUnits: 4 }),
      chatResult({}, {}, { promptUnits: '17' }),
      chatResult({}, {}, { basis: 'estimated' }),
      chatResult({}, {}, { tokenizer: undefined }),
      chatResult({}, {}, { chatTemplate: undefined }),
      chatResult({}, {}, { tokenizer: { kind: 'cl100k', digest: STUB_WORDS_DIGEST } }),
      chatResult({}, {}, { tokenizer: { kind: 'stub-words-v1', digest: 'sha256:XYZ' } }),
      chatResult({}, {}, { chatTemplate: { id: 'openai-chat-count/v2', digest: CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST } }),
      chatResult({}, {}, { truncated: 'no' }),
      chatResult({}, {}, { basis: 'provider-reported', tokenizer: undefined, chatTemplate: undefined, providerUsage: undefined }),
    ];
    for (const raw of rejections) expect(parseChatServeResult(raw).ok, JSON.stringify(raw)).toBe(false);
  });
});

describe('parseQueryServeResult', () => {
  it('accepts a delivered result and an aborted one', () => {
    expect(parseQueryServeResult(queryResult())).toMatchObject({ ok: true, result: { rowCount: 2 } });
    const aborted = queryResult(
      { result: null, rowCount: 0 },
      { deliveryUnits: 0, servedUnits: 3, rowCount: 0, aborted: { reason: 'row-cap' } },
    );
    const parsed = parseQueryServeResult(aborted);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.metering.aborted).toEqual({ reason: 'row-cap' });
    for (const reason of ['timeout', 'size-cap']) {
      expect(
        parseQueryServeResult(
          queryResult({ result: null, rowCount: 0 }, { deliveryUnits: 0, servedUnits: 3, rowCount: 0, aborted: { reason } }),
        ).ok,
      ).toBe(true);
    }
  });

  it('counts quads too', () => {
    expect(parseQueryServeResult(queryResult({ result: { quads: [{}, {}, {}] }, rowCount: 3 }, { rowCount: 3 })).ok).toBe(true);
  });

  it('rejects the malformed-result matrix', () => {
    const rejections: unknown[] = [
      null,
      { result: {} }, // legacy shape is malformed under the schedule
      queryResult({ schema: 'sparql-result/v2' }),
      queryResult({ rowCount: 3 }, { rowCount: 3 }), // rows ≠ delivered rows
      queryResult({}, { rowCount: 1 }),
      queryResult({}, { servedUnits: 5 }),
      queryResult({}, { scheduleDigest: 'sha256:nope' }),
      queryResult({}, { admissionUnits: 1.5, servedUnits: 2.5 }),
      queryResult({}, { aborted: { reason: 'oom' } }),
      queryResult({}, { aborted: { reason: 'timeout' } }), // aborted but delivered rows
      queryResult({ rowCount: -1 }),
    ];
    for (const raw of rejections) expect(parseQueryServeResult(raw).ok, JSON.stringify(raw)).toBe(false);
    const missingResult = queryResult();
    delete missingResult.result;
    expect(parseQueryServeResult(missingResult).ok).toBe(false);
  });
});
