import { describe, it, expect, vi } from 'vitest';
import { LlmClient } from '../src/llm/client.js';

describe('LlmClient', () => {
  it('omits unsupported optional params for gpt-5 models', async () => {
    const client = new LlmClient();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200 }),
    );

    await client.complete({
      config: { apiKey: 'test', model: 'gpt-5-mini', baseURL: 'https://api.openai.com/v1' },
      request: {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 123,
        temperature: 0.2,
        stream: false,
      },
    });

    const reqInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(reqInit?.body ?? '{}'));
    expect(payload.max_tokens).toBeUndefined();
    expect(payload.temperature).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('streams normalized events for SSE responses', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const client = new LlmClient();
    const events: Array<{ type: string; [k: string]: any }> = [];
    for await (const ev of client.stream({
      config: { apiKey: 'test', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
      request: {
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
    })) {
      events.push(ev as any);
    }

    expect(events.some(e => e.type === 'text_delta' && e.delta === 'Hel')).toBe(true);
    expect(events.some(e => e.type === 'text_delta' && e.delta === 'lo')).toBe(true);
    const final = events.find(e => e.type === 'final');
    expect(final).toBeTruthy();
    expect(final?.mode).toBe('streaming');
    expect(final?.message?.content).toBe('Hello');
    fetchSpy.mockRestore();
  });

  it('falls back to blocking mode when streaming is disabled by capabilities', async () => {
    class NoStreamClient extends LlmClient {
      override resolveCapabilities(config: any) {
        const base = super.resolveCapabilities(config);
        return { ...base, supportsStreaming: false };
      }
    }

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: 'blocking response' } }],
      }), { status: 200 }),
    );

    const client = new NoStreamClient();
    const events: Array<{ type: string; [k: string]: any }> = [];
    for await (const ev of client.stream({
      config: { apiKey: 'test', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
      request: {
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
    })) {
      events.push(ev as any);
    }

    const final = events.find(e => e.type === 'final');
    expect(final?.mode).toBe('blocking');
    expect(final?.message?.content).toBe('blocking response');
    const reqInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(reqInit?.body ?? '{}'));
    expect(payload.stream).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('falls back to blocking parsing when stream response is non-SSE JSON', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: 'json fallback' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const client = new LlmClient();
    const events: Array<{ type: string; [k: string]: any }> = [];
    for await (const ev of client.stream({
      config: { apiKey: 'test', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
      request: {
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
    })) {
      events.push(ev as any);
    }

    const final = events.find(e => e.type === 'final');
    expect(final?.mode).toBe('blocking');
    expect(final?.message?.content).toBe('json fallback');
    fetchSpy.mockRestore();
  });
});
