/**
 * The `chat-connector` executor (spec §5.6) over an in-test stub connector
 * that re-implements the devnet llm-stub's deterministic reply formula
 * (golden vectors GV-2 / GV-3), plus every fail-closed path: OVER_MAX_UNITS,
 * tool-call overflow, METERING_OVERRUN, missing usage, result size cap,
 * MODEL_MISMATCH, TOOLS_UNSUPPORTED, CONTEXT_EXCEEDED and upstream codes.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST,
  STUB_WORDS_DIGEST,
  createStubWordsEngine,
  parseChatServeResult,
  type ChatToolCall,
} from '@origintrail-official/dkg-marketplace';
import { createChatConnectorExecutor } from '../src/marketplace/chat-executor.js';
import type { ChatConnector, ConnectorChatOutcome, ConnectorChatRequest } from '../src/marketplace/connectors/types.js';

const words = (text: string): string[] => (text.trim() === '' ? [] : text.trim().split(/\s+/));

/** The llm-stub formula: reversed upper-cased words of the last user turn, `max_tokens` bounds WORDS. */
function stubReply(lastUser: string, maxTokens: number, honorMaxTokens: boolean) {
  const body = words(lastUser).reverse().map((w) => w.toUpperCase());
  const full = [`STUB:${body[0] ?? ''}`, ...body.slice(1), '::', 'ok'];
  const cap = honorMaxTokens ? maxTokens : Infinity;
  const out = full.length > cap ? full.slice(0, cap) : full;
  return { content: out.join(' '), finishReason: full.length > cap ? 'length' : 'stop', completion: out.length };
}

function stubConnector(opts: {
  toolTransport?: 'native' | 'prompt' | 'none';
  honorMaxTokens?: boolean;
  outcome?: (request: ConnectorChatRequest) => ConnectorChatOutcome;
} = {}) {
  const seen: ConnectorChatRequest[] = [];
  const connector: ChatConnector = {
    description: {
      kind: 'openai-compatible', toolTransport: opts.toolTransport ?? 'native', provenanceClass: 'upstream-claimed',
      upstreamModel: 'stub-chat', upstreamOrigin: 'http://127.0.0.1:18080', secretConfigured: true,
    },
    async complete(request) {
      seen.push(request);
      if (opts.outcome) return opts.outcome(request);
      const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const reply = stubReply(lastUser, request.maxTokens, opts.honorMaxTokens ?? true);
      const prompt = request.messages.reduce((s, m) => s + words(m.content).length + words(m.role).length + 3, 0) + 3;
      return {
        ok: true, content: reply.content, finishReason: reply.finishReason,
        providerUsage: { promptTokens: prompt, completionTokens: reply.completion },
      };
    },
    async health() { return { ok: true, latencyMs: 0 }; },
  };
  return { connector, seen };
}

const GV2_MESSAGES = [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'hello marketplace world' }];
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const payload = (overrides: Record<string, unknown> = {}) => encode({
  schema: 'openai-chat/v1', model: 'stub-chat', messages: GV2_MESSAGES, max_tokens: 256, ...overrides,
});
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
const engine = createStubWordsEngine();

describe('chat-connector executor — pinned stub-words metering', () => {
  it('GV-2: prompt 17, completion 5, served 22; the result parses and agrees with the receipt units', async () => {
    const { connector, seen } = stubConnector();
    const executor = createChatConnectorExecutor({ connector, modelId: 'stub-chat', engine });
    const executed = await executor.execute(payload(), { maxUnits: 4_000n });
    expect(executed.unitsServed).toBe(22n);
    const result = decode(executed.resultBytes);
    expect(result).toEqual({
      schema: 'openai-chat-result/v1',
      model: 'stub-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'STUB:WORLD MARKETPLACE HELLO :: ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
      metering: {
        basis: 'pinned',
        tokenizer: { kind: 'stub-words-v1', digest: STUB_WORDS_DIGEST },
        chatTemplate: { id: 'openai-chat-count/v1', digest: CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST },
        promptUnits: 17, toolUnits: 0, completionUnits: 5, servedUnits: 22, truncated: false,
        providerUsage: { prompt_tokens: 17, completion_tokens: 5 },
      },
    });
    const parsed = parseChatServeResult(result);
    expect(parsed.ok && parsed.result.metering.servedUnits).toBe(22);
    // Budget = min(max_tokens, maxUnits − fixed); no sampler field leaks upstream.
    expect(seen[0]).toEqual({ upstreamModel: 'stub-chat', messages: GV2_MESSAGES, maxTokens: 256 });
  });

  it('GV-3: max_tokens 3 → the stub truncates (finish length, usage 17/3/20)', async () => {
    const executor = createChatConnectorExecutor({ connector: stubConnector().connector, modelId: 'stub-chat', engine });
    const executed = await executor.execute(payload({ max_tokens: 3 }), { maxUnits: 4_000n });
    const result = decode(executed.resultBytes) as { choices: Array<{ message: { content: string }; finish_reason: string }>; usage: unknown };
    expect(result.choices[0]).toMatchObject({ message: { content: 'STUB:WORLD MARKETPLACE HELLO' }, finish_reason: 'length' });
    expect(result.usage).toEqual({ prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 });
    expect(executed.unitsServed).toBe(20n);
  });

  it('bounds the delivered text with boundCompletion when the upstream ignores max_tokens', async () => {
    const { connector } = stubConnector({ honorMaxTokens: false });
    const executor = createChatConnectorExecutor({ connector, modelId: 'stub-chat', engine });
    // maxUnits 19 leaves 2 completion units, below max_tokens 256.
    const executed = await executor.execute(payload(), { maxUnits: 19n });
    const result = decode(executed.resultBytes) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>; metering: { truncated: boolean };
    };
    expect(result.choices[0].message.content).toBe('STUB:WORLD MARKETPLACE ');
    expect(result.choices[0].finish_reason).toBe('length');
    expect(result.metering.truncated).toBe(true);
    expect(executed.unitsServed).toBe(19n);
  });

  it('fails closed: OVER_MAX_UNITS when the prompt fills maxUnits, CONTEXT_EXCEEDED past the context', async () => {
    const executor = createChatConnectorExecutor({ connector: stubConnector().connector, modelId: 'stub-chat', engine });
    await expect(executor.execute(payload(), { maxUnits: 17n })).rejects.toMatchObject({ code: 'OVER_MAX_UNITS' });
    const small = createChatConnectorExecutor({ connector: stubConnector().connector, modelId: 'stub-chat', engine, contextLength: 17n });
    await expect(small.execute(payload(), { maxUnits: 4_000n })).rejects.toMatchObject({ code: 'CONTEXT_EXCEEDED' });
  });

  it('tool calls cannot be truncated: an overflow fails closed OVER_MAX_UNITS', async () => {
    const call: ChatToolCall = { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q": "a b c d e f"}' } };
    const { connector } = stubConnector({
      outcome: () => ({ ok: true, content: '', toolCalls: [call], finishReason: 'tool_calls' }),
    });
    const executor = createChatConnectorExecutor({ connector, modelId: 'stub-chat', engine });
    const tools = { tools: [{ type: 'function', function: { name: 'lookup' } }], tool_choice: 'required' };
    const fixedPlusTools = 17n + BigInt(engine.encodeCount(JSON.stringify({
      messageMetadata: [{}, {}], tools: tools.tools, tool_choice: 'required',
    })));
    await expect(executor.execute(payload(tools), { maxUnits: fixedPlusTools + 1n })).rejects.toMatchObject({ code: 'OVER_MAX_UNITS' });
    const ok = await executor.execute(payload(tools), { maxUnits: fixedPlusTools + 500n });
    const result = decode(ok.resultBytes) as { choices: Array<{ message: { content: unknown; tool_calls: unknown }; finish_reason: string }> };
    expect(result.choices[0]).toEqual({ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' });
    expect(ok.unitsServed).toBe(fixedPlusTools + BigInt(engine.encodeCount(JSON.stringify([call]))));
  });

  it('refuses MODEL_MISMATCH, BAD_PAYLOAD and TOOLS_UNSUPPORTED (prompt transport) before calling upstream', async () => {
    const { connector, seen } = stubConnector({ toolTransport: 'prompt' });
    const executor = createChatConnectorExecutor({ connector, modelId: 'stub-chat', engine });
    await expect(executor.execute(payload({ model: 'other-model' }), { maxUnits: 100n })).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
    await expect(executor.execute(encode({ prompt: 'legacy' }), { maxUnits: 100n })).rejects.toMatchObject({ code: 'BAD_PAYLOAD' });
    await expect(executor.execute(payload({ tools: [{ type: 'function', function: { name: 'lookup' } }] }), { maxUnits: 100n }))
      .rejects.toMatchObject({ code: 'TOOLS_UNSUPPORTED' });
    expect(seen).toHaveLength(0);
  });

  it('refuses a result over the deliverable size cap before any receipt exists', async () => {
    const executor = createChatConnectorExecutor({ connector: stubConnector().connector, modelId: 'stub-chat', engine, maxResultBytes: 64 });
    await expect(executor.execute(payload(), { maxUnits: 4_000n })).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('passes upstream failure codes through (no receipt)', async () => {
    const { connector } = stubConnector({ outcome: () => ({ ok: false, code: 'UPSTREAM_RATE_LIMITED', status: 429, detail: 'slow down' }) });
    const executor = createChatConnectorExecutor({ connector, modelId: 'stub-chat', engine });
    await expect(executor.execute(payload(), { maxUnits: 4_000n })).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
  });
});

describe('chat-connector executor — provider-reported basis', () => {
  it('bills the upstream usage, labels the basis, and parses', async () => {
    const executor = createChatConnectorExecutor({ connector: stubConnector().connector, modelId: 'stub-chat' });
    const executed = await executor.execute(payload(), { maxUnits: 4_000n });
    expect(executed.unitsServed).toBe(22n);
    const result = decode(executed.resultBytes);
    expect(result.metering).toEqual({
      basis: 'provider-reported', promptUnits: 17, toolUnits: 0, completionUnits: 5, servedUnits: 22, truncated: false,
      providerUsage: { prompt_tokens: 17, completion_tokens: 5 },
    });
    expect(parseChatServeResult(result).ok).toBe(true);
  });

  it('a usage total over maxUnits is METERING_OVERRUN (seller fault); missing usage is UPSTREAM_ERROR', async () => {
    const executor = createChatConnectorExecutor({ connector: stubConnector().connector, modelId: 'stub-chat' });
    await expect(executor.execute(payload(), { maxUnits: 21n })).rejects.toMatchObject({ code: 'METERING_OVERRUN' });
    const { connector } = stubConnector({ outcome: () => ({ ok: true, content: 'x', finishReason: 'stop' }) });
    await expect(createChatConnectorExecutor({ connector, modelId: 'stub-chat' }).execute(payload(), { maxUnits: 4_000n }))
      .rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});
