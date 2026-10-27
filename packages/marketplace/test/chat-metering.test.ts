import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  boundCompletion,
  CHAT_TEMPLATE_OPENAI_COUNT_V1,
  CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST,
  chatPromptUpperBound,
  chatTemplateDigest,
  countChatCompletionUnits,
  countChatPromptUnits,
  countChatToolUnits,
  createHfBpeEngine,
  createStubWordsEngine,
  createTiktokenO200kEngine,
  isWellFormedText,
  meterChat,
  TOOL_CALL_SLACK_UNITS,
  toolEnvelopeText,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolOptions,
} from '../src/index.js';

const stub = createStubWordsEngine();
const hf = createHfBpeEngine(readFileSync(new URL('./fixtures/tiny-tokenizer.json', import.meta.url)));
const tk = createTiktokenO200kEngine(readFileSync(new URL('./fixtures/tiny-o200k.tiktoken', import.meta.url)));
const GV2_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'hello marketplace world' },
];
const lookupTool = { type: 'function' as const, function: { name: 'lookup', parameters: { type: 'object' } } };

describe('chat template v1', () => {
  it('pins the template constants and digest (byte-identical to the fork)', () => {
    expect(CHAT_TEMPLATE_OPENAI_COUNT_V1).toEqual({ version: 'openai-chat-count/v1', perMessageTokens: 3, perReplyPrimerTokens: 3 });
    expect(CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST).toBe('sha256:53662e1fb5c8ef588e2d3e3b8fc9025e25a7a4caf0650842a64323b29c71cee8');
    expect(chatTemplateDigest({ ...CHAT_TEMPLATE_OPENAI_COUNT_V1 })).toBe(CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST);
    expect(TOOL_CALL_SLACK_UNITS).toBe(128n);
  });
});

describe('golden vectors (stub-words-v1, template v1)', () => {
  it('GV-2: prompt 17, tools 0, completion 5, served 22', () => {
    expect(countChatPromptUnits(stub, GV2_MESSAGES)).toBe(17n);
    expect(countChatToolUnits(stub, GV2_MESSAGES, {})).toBe(0n);
    expect(countChatCompletionUnits(stub, 'STUB:WORLD MARKETPLACE HELLO :: ok')).toBe(5n);
    expect(meterChat(stub, { messages: GV2_MESSAGES, options: {}, content: 'STUB:WORLD MARKETPLACE HELLO :: ok' })).toEqual({
      promptUnits: 17n,
      toolUnits: 0n,
      completionUnits: 5n,
      servedUnits: 22n,
    });
  });

  it('GV-3: max_tokens 3 reply → completion 3, served 20', () => {
    expect(meterChat(stub, { messages: GV2_MESSAGES, options: {}, content: 'STUB:WORLD MARKETPLACE HELLO' }).servedUnits).toBe(20n);
  });

  it('GV-4: prompt 11, reply 6, served 17', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '  multiple   spaces\tand\nnewlines  ' }];
    expect(countChatPromptUnits(stub, messages)).toBe(11n);
    expect(meterChat(stub, { messages, options: {}, content: 'STUB:NEWLINES AND SPACES MULTIPLE :: ok' })).toEqual({
      promptUnits: 11n,
      toolUnits: 0n,
      completionUnits: 6n,
      servedUnits: 17n,
    });
  });

  it('GV-5: empty user content → prompt 7, reply 3', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '' }];
    expect(countChatPromptUnits(stub, messages)).toBe(7n);
    expect(countChatCompletionUnits(stub, 'STUB: :: ok')).toBe(3n);
  });

  it('GV-6: chatPromptUpperBound(GV-2 messages, {}) = (14+6+3) + (23+4+3) + 3 = 56', () => {
    expect(chatPromptUpperBound(GV2_MESSAGES, {})).toBe(56n);
  });

  it('GV-7: boundCompletion(stub, "a b c d e", 3n) keeps the trailing space', () => {
    expect(boundCompletion(stub, 'a b c d e', 3n)).toEqual({ text: 'a b c ', truncated: true });
  });
});

describe('toolEnvelopeText', () => {
  it("is '' with no metadata and no tool option", () => {
    expect(toolEnvelopeText(GV2_MESSAGES, {})).toBe('');
    expect(countChatToolUnits(hf, GV2_MESSAGES, {})).toBe(0n);
  });

  it('is stable JSON of {messageMetadata, tools?, tool_choice?, parallel_tool_calls?} in that key order', () => {
    const options: ChatToolOptions = { tools: [lookupTool], toolChoice: 'required', parallelToolCalls: false };
    expect(toolEnvelopeText([{ role: 'user', content: 'hi' }], options)).toBe(
      '{"messageMetadata":[{}],"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}],' +
        '"tool_choice":"required","parallel_tool_calls":false}',
    );
    const call: ChatToolCall = { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } };
    const history: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', content: 'r', tool_call_id: 'c1', name: 'lookup' },
    ];
    expect(toolEnvelopeText(history, {})).toBe(
      '{"messageMetadata":[{"tool_calls":[{"id":"c1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},' +
        '{"name":"lookup","tool_call_id":"c1"}]}',
    );
    expect(countChatToolUnits(stub, history, {})).toBe(1n); // one whitespace-free word
    expect(toolEnvelopeText([{ role: 'user', content: 'x' }], { parallelToolCalls: true })).toBe(
      '{"messageMetadata":[{}],"parallel_tool_calls":true}',
    );
  });
});

describe('meterChat and the strict byte upper bound', () => {
  it('counts tool calls as E(JSON.stringify(tool_calls)) on top of the content (R4)', () => {
    const toolCalls: ChatToolCall[] = [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q": 1}' } }];
    const json = JSON.stringify(toolCalls);
    expect(countChatCompletionUnits(stub, null, toolCalls)).toBe(BigInt(stub.encodeCount(json)));
    expect(countChatCompletionUnits(hf, 'abc', toolCalls)).toBe(BigInt(1 + hf.encodeCount(json)));
    expect(countChatCompletionUnits(stub, '', [])).toBe(0n);
    const bill = meterChat(stub, { messages: GV2_MESSAGES, options: { tools: [lookupTool] }, content: null, toolCalls });
    expect(bill.servedUnits).toBe(bill.promptUnits + bill.toolUnits + bill.completionUnits);
    expect(bill.toolUnits).toBeGreaterThan(0n);
  });

  it('bounds promptUnits + toolUnits for every engine', () => {
    const conversations: Array<[ChatMessage[], ChatToolOptions]> = [
      [GV2_MESSAGES, {}],
      [[{ role: 'user', content: 'abc abc 12 é 👋 漢字' }], { tools: [lookupTool], toolChoice: 'auto' }],
      [[{ role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: 'ab ab' } }] }], {}],
      [[{ role: 'user', content: '' }], {}],
    ];
    for (const [messages, options] of conversations) {
      const bound = chatPromptUpperBound(messages, options);
      for (const engine of [stub, hf, tk]) {
        expect(countChatPromptUnits(engine, messages) + countChatToolUnits(engine, messages, options)).toBeLessThanOrEqual(bound);
      }
    }
  });
});

describe('boundCompletion', () => {
  const reply = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');

  it('cuts a long reply to a strict prefix within the cap', () => {
    const bounded = boundCompletion(stub, reply, 96n);
    expect(bounded.truncated).toBe(true);
    expect(reply.startsWith(bounded.text)).toBe(true);
    expect(stub.encodeCount(bounded.text)).toBeLessThanOrEqual(96);
    expect(stub.encodeCount(bounded.text)).toBeGreaterThanOrEqual(95);
  });

  it('delivers a reply within the cap verbatim and a cap ≤ 0 as nothing', () => {
    expect(boundCompletion(stub, reply, 300n)).toEqual({ text: reply, truncated: false });
    expect(boundCompletion(stub, reply, 0n)).toEqual({ text: '', truncated: true });
    expect(boundCompletion(stub, reply, -5n)).toEqual({ text: '', truncated: true });
    expect(boundCompletion(stub, '', 0n)).toEqual({ text: '', truncated: false });
    expect(boundCompletion(stub, 'short', 10n ** 30n)).toEqual({ text: 'short', truncated: false });
  });

  it('never splits a surrogate pair, for every engine', () => {
    const text = 'héllo wörld 👋 ünïcode abc 12 '.repeat(40);
    for (const engine of [stub, hf, tk]) {
      for (const cap of [1n, 5n, 17n, 64n]) {
        const bounded = boundCompletion(engine, text, cap);
        expect(bounded.truncated).toBe(true);
        expect(text.startsWith(bounded.text)).toBe(true);
        expect(engine.encodeCount(bounded.text)).toBeLessThanOrEqual(Number(cap));
        expect(isWellFormedText(bounded.text)).toBe(true);
      }
    }
  });
});
