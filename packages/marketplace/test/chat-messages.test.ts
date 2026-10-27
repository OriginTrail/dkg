import { describe, expect, it } from 'vitest';
import {
  buildPromptToolTransport,
  hasToolHistory,
  normalizeChatMessages,
  normalizeChatToolChoice,
  normalizeChatTools,
  normalizeToolCalls,
  parsePromptToolTransport,
  PROMPT_TOOL_TRANSPORT_KEY,
  validateToolCallsAgainstOptions,
  type ChatMessage,
  type ChatTool,
  type ChatToolCall,
  type ChatToolOptions,
} from '../src/index.js';

const norm = normalizeChatMessages;
const tool: ChatTool = {
  type: 'function',
  function: {
    name: 'memory_recall',
    description: 'Recall memory',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};
const calls = [{ id: 'call_123', type: 'function', function: { name: 'memory_recall', arguments: '{"query":"origintrail"}' } }];

function messagesOf(raw: unknown, opts?: Parameters<typeof normalizeChatMessages>[1]): ChatMessage[] {
  const result = norm(raw, opts);
  if (!result.ok) throw new Error(result.detail);
  return result.messages;
}

describe('normalizeChatMessages', () => {
  it('flattens an array of text parts to one newline-joined string, role preserved', () => {
    const parts = messagesOf([{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'input_text', text: 'world' }] }]);
    expect(parts).toEqual([{ role: 'user', content: 'hello\nworld' }]);
  });

  it('refuses a non-text part, naming the offending index and type', () => {
    const img = norm([{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:' } }] }]);
    expect(img.ok).toBe(false);
    if (img.ok) return;
    expect(img.code).toBe('invalid_messages');
    expect(img.detail).toMatch(/content\[1\]/);
    expect(img.detail).toMatch(/image_url/);
  });

  it('refuses non-string roles, empty lists, numeric content and non-object entries', () => {
    for (const raw of [[{ role: 42, content: 'x' }], [], [{ role: 'user', content: 42 }], ['hi'], 'hi', null]) {
      const result = norm(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid_messages');
    }
  });

  it('turns null content (assistant tool-call turn) into an empty string', () => {
    expect(messagesOf([{ role: 'assistant', content: null }, { role: 'user', content: 'next' }]).map((m) => m.content)).toEqual([
      '',
      'next',
    ]);
  });

  it('passes plain string messages through unchanged and drops unknown fields', () => {
    expect(messagesOf([{ role: 'system', content: 's', extra: 1 }, { role: 'user', content: 'u' }])).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });

  it('the seller (allowParts: false) refuses a parts array', () => {
    const strict = norm([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], { allowParts: false });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.detail).toMatch(/flattens parts/);
  });

  it('keeps assistant tool calls and tool-result correlation ids', () => {
    const messages = messagesOf([
      { role: 'assistant', content: null, tool_calls: calls },
      { role: 'tool', tool_call_id: 'call_123', content: 'remembered' },
    ]);
    expect(messages[0].tool_calls?.[0].function.arguments).toContain('origintrail');
    expect(messages[1].tool_call_id).toBe('call_123');
    expect(hasToolHistory(messages)).toBe(true);
    expect(hasToolHistory([{ role: 'user', content: 'x', name: 'alice' }])).toBe(false);
  });

  it('treats tool_calls of [] or null as absent (vLLM plain-reply shape)', () => {
    for (const toolCalls of [[], null]) {
      expect(messagesOf([{ role: 'assistant', content: 'hi', tool_calls: toolCalls }])).toEqual([{ role: 'assistant', content: 'hi' }]);
    }
  });

  it('enforces message-count and byte bounds, including tool-call arguments across the history', () => {
    expect(norm([{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }], { maxMessages: 1 }).ok).toBe(false);
    // role 4 + content 10 bytes + the 2-byte `{}` metadata envelope = 16
    expect(norm([{ role: 'user', content: 'é'.repeat(5) }], { maxBytes: 16 }).ok).toBe(true);
    expect(norm([{ role: 'user', content: 'é'.repeat(5) }], { maxBytes: 15 }).ok).toBe(false);
    expect(norm([{ role: 'user', content: 'é'.repeat(6) }], { maxBytes: 15 }).ok).toBe(false);
    const aggregateHuge = norm(
      [0, 1, 2].map((i) => ({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `large_${i}`, type: 'function', function: { name: 'memory_recall', arguments: 'x'.repeat(700_000) } }],
      })),
    );
    expect(aggregateHuge.ok).toBe(false);
  });

  it('validates name and tool_call_id shapes', () => {
    expect(norm([{ role: 'user', content: 'x', name: 'has space' }]).ok).toBe(false);
    expect(norm([{ role: 'user', content: 'x', name: '' }]).ok).toBe(false);
    expect(norm([{ role: 'tool', content: 'x', tool_call_id: '' }]).ok).toBe(false);
    expect(norm([{ role: 'tool', content: 'x', tool_call_id: 'c'.repeat(257) }]).ok).toBe(false);
    expect(messagesOf([{ role: 'user', content: 'x', name: 'alice_1' }])[0].name).toBe('alice_1');
  });

  it('refuses strings that are not well-formed UTF-16 (lone surrogates)', () => {
    for (const content of ['bad \uD800 high', 'bad \uDC00 low', '\uDBFF']) {
      const result = norm([{ role: 'user', content }]);
      expect(result.ok, JSON.stringify(content)).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid_messages');
    }
    expect(norm([{ role: 'tool', content: 'x', tool_call_id: 'id\uD800' }]).ok).toBe(false);
    expect(norm([{ role: 'assistant', content: '', tool_calls: [{ ...calls[0], function: { name: 'f', arguments: '\uDC00' } }] }]).ok).toBe(false);
    expect(norm([{ role: 'user', content: 'paired 👋 surrogates' }]).ok).toBe(true);
  });

  it('is idempotent through a JSON round trip (allowParts: false on the second pass)', () => {
    const inputs: unknown[] = [
      [{ role: 'user', content: 'hello' }],
      [{ role: 'system', content: '' }, { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'output_text', text: 'b' }] }],
      [{ role: 'user', content: 'x', name: 'alice', extra: true }],
      [
        { role: 'assistant', content: null, tool_calls: calls },
        { role: 'tool', tool_call_id: 'call_123', name: 'memory_recall', content: 'remembered' },
        { role: 'assistant', content: 'done', tool_calls: [] },
        { role: 'assistant', content: undefined, tool_calls: null },
      ],
      [{ role: 'user', content: 'tabs\tnewlines\n\r and "quotes" \\ é 漢 👋' }],
    ];
    for (const raw of inputs) {
      const first = messagesOf(raw);
      const second = messagesOf(JSON.parse(JSON.stringify(first)), { allowParts: false });
      expect(second).toEqual(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });
});

describe('tools and tool_choice', () => {
  it('keeps function tools and named tool_choice', () => {
    const tools = normalizeChatTools([tool]);
    const choice = normalizeChatToolChoice({ type: 'function', function: { name: 'memory_recall' } });
    expect(tools).toEqual({ ok: true, tools: [tool] });
    expect(choice).toEqual({ ok: true, toolChoice: { type: 'function', function: { name: 'memory_recall' } } });
    for (const value of ['auto', 'none', 'required'] as const) expect(normalizeChatToolChoice(value)).toEqual({ ok: true, toolChoice: value });
    expect(normalizeChatToolChoice(undefined)).toEqual({ ok: true });
    expect(normalizeChatTools(null)).toEqual({ ok: true });
  });

  it('drops unknown tool fields and refuses non-function tools and bad shapes', () => {
    expect(normalizeChatTools([{ ...tool, extra: 1, function: { ...tool.function, junk: 2 } }])).toEqual({ ok: true, tools: [tool] });
    const refusals: unknown[] = [
      'tools',
      [{ type: 'browser', function: { name: 'x' } }],
      [{ type: 'function', function: { name: 'bad name' } }],
      [{ type: 'function', function: { name: 'x', parameters: [] } }],
      [{ type: 'function', function: { name: 'x', description: 1 } }],
      [{ type: 'function', function: { name: 'x', strict: 'yes' } }],
      Array.from({ length: 257 }, () => tool),
    ];
    for (const raw of refusals) {
      const result = normalizeChatTools(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid_tools');
    }
    for (const raw of ['sometimes', { type: 'function' }, { type: 'function', function: { name: '' } }, 3]) {
      const result = normalizeChatToolChoice(raw);
      expect(result).toMatchObject({ ok: false, code: 'invalid_tools' });
    }
  });

  it('normalizeToolCalls refuses empty, oversized, and non-string-argument calls', () => {
    expect(normalizeToolCalls(calls)).toMatchObject({ ok: true });
    expect(normalizeToolCalls([]).ok).toBe(false);
    expect(normalizeToolCalls([{ id: 'x', type: 'function', function: { name: 'x', arguments: {} } }]).ok).toBe(false);
    expect(normalizeToolCalls([{ id: 'huge', type: 'function', function: { name: 'f', arguments: 'x'.repeat(1_000_000) } }]).ok).toBe(false);
    expect(normalizeToolCalls(Array.from({ length: 129 }, () => calls[0])).ok).toBe(false);
  });
});

describe('validateToolCallsAgainstOptions', () => {
  const options: ChatToolOptions = { tools: [tool], toolChoice: 'auto' };
  const named = (name: string): ChatToolCall[] => normalizedCalls().map((call) => ({ ...call, function: { ...call.function, name } }));

  it('refuses unlisted tools, a wrong named tool, missing required calls, calls under none, and disabled parallelism', () => {
    expect(validateToolCallsAgainstOptions(normalizedCalls(), options)).toEqual({ ok: true });
    expect(validateToolCallsAgainstOptions(named('shell'), options).ok).toBe(false);
    const other: ChatTool = { type: 'function', function: { name: 'other' } };
    expect(
      validateToolCallsAgainstOptions(normalizedCalls(), {
        tools: [tool, other],
        toolChoice: { type: 'function', function: { name: 'other' } },
      }).ok,
    ).toBe(false);
    expect(validateToolCallsAgainstOptions(undefined, { tools: [tool], toolChoice: 'required' }).ok).toBe(false);
    expect(validateToolCallsAgainstOptions(undefined, { tools: [tool], toolChoice: 'auto' }).ok).toBe(true);
    expect(validateToolCallsAgainstOptions(normalizedCalls(), { tools: [tool], toolChoice: 'none' }).ok).toBe(false);
    const two = [...normalizedCalls(), { ...normalizedCalls()[0], id: 'call_2' }];
    expect(validateToolCallsAgainstOptions(two, { tools: [tool], parallelToolCalls: false }).ok).toBe(false);
    expect(validateToolCallsAgainstOptions(two, { tools: [tool], parallelToolCalls: true }).ok).toBe(true);
  });

  function normalizedCalls() {
    const result = normalizeToolCalls(calls);
    if (!result.ok) throw new Error(result.detail);
    return result.value;
  }
});

describe('prompt-tool transport', () => {
  const history = messagesOf([
    { role: 'assistant', content: null, tool_calls: calls },
    { role: 'tool', tool_call_id: 'call_123', content: 'remembered' },
  ]);
  const promptOptions: ChatToolOptions = {
    tools: [tool],
    toolChoice: { type: 'function', function: { name: 'memory_recall' } },
    parallelToolCalls: false,
  };

  it('exposes the tool schema and renders correlated tool results as ordinary messages', () => {
    const bridged = buildPromptToolTransport(history, promptOptions);
    expect(bridged[0].role).toBe('system');
    expect(bridged[0].content).toContain('memory_recall');
    expect(bridged[0].content).toContain(PROMPT_TOOL_TRANSPORT_KEY);
    expect(bridged[0].content).toContain('You MUST call exactly the function named "memory_recall".');
    expect(bridged.at(-1)?.role).toBe('user');
    expect(bridged.at(-1)?.content).toContain('call_123');
    expect(bridged.every((m) => m.tool_calls === undefined && m.tool_call_id === undefined)).toBe(true);
    // The transported messages are themselves valid seller wire messages.
    expect(norm(JSON.parse(JSON.stringify(bridged)), { allowParts: false }).ok).toBe(true);
  });

  it('translates prior tool calls/results without a new-call protocol when tool_choice is none', () => {
    const historyOnly = buildPromptToolTransport(history, { toolChoice: 'none' });
    expect(historyOnly).toHaveLength(2);
    expect(historyOnly[0]).toMatchObject({ role: 'assistant' });
    expect(historyOnly[0].content).toContain('call_123');
    expect(historyOnly[1]).toMatchObject({ role: 'user' });
    expect(historyOnly[1].content).toContain('remembered');
    expect(historyOnly.some((m) => m.content.includes('compatibility transport is active'))).toBe(false);
  });

  it('returns validated deterministic OpenAI tool calls from an all-body envelope', () => {
    const envelope = JSON.stringify({ [PROMPT_TOOL_TRANSPORT_KEY]: [{ name: 'memory_recall', arguments: { query: 'origintrail' } }] });
    const first = parsePromptToolTransport(envelope, promptOptions);
    const again = parsePromptToolTransport(`  ${envelope}\n`, promptOptions);
    expect(first.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(first.toolCalls?.[0].id).toMatch(/^call_dkg_[0-9a-f]{24}$/);
    expect(first.toolCalls?.[0].function.arguments).toBe('{"query":"origintrail"}');
    expect(again.toolCalls).toEqual(first.toolCalls);
  });

  it('never executes prose-wrapped envelopes or unlisted tools; required fails closed; auto keeps answers', () => {
    const envelope = JSON.stringify({ [PROMPT_TOOL_TRANSPORT_KEY]: [{ name: 'memory_recall', arguments: { query: 'x' } }] });
    expect(parsePromptToolTransport(`Here is prose ${envelope}`, promptOptions).ok).toBe(false);
    const unlisted = JSON.stringify({ [PROMPT_TOOL_TRANSPORT_KEY]: [{ name: 'shell', arguments: {} }] });
    expect(parsePromptToolTransport(unlisted, promptOptions).ok).toBe(false);
    expect(parsePromptToolTransport('I cannot use tools', promptOptions).ok).toBe(false);
    expect(parsePromptToolTransport('A normal final answer', { ...promptOptions, toolChoice: 'auto' })).toEqual({ ok: true });
    const parallel = JSON.stringify({
      [PROMPT_TOOL_TRANSPORT_KEY]: [
        { name: 'memory_recall', arguments: {} },
        { name: 'memory_recall', arguments: {} },
      ],
    });
    expect(parsePromptToolTransport(parallel, { ...promptOptions, toolChoice: 'auto' }).ok).toBe(false);
    expect(parsePromptToolTransport(JSON.stringify({ [PROMPT_TOOL_TRANSPORT_KEY]: [] }), promptOptions).ok).toBe(false);
    expect(parsePromptToolTransport(`{"${PROMPT_TOOL_TRANSPORT_KEY}": [`, promptOptions).ok).toBe(false);
  });
});
