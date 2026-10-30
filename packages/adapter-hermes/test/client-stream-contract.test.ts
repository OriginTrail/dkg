import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesDkgClient, redact } from '../src/dkg-client.js';
import { HermesAdapterPlugin } from '../src/HermesAdapterPlugin.js';
import { createTrackingApi } from './hermes-adapter.shared.js';

afterEach(() => vi.restoreAllMocks());

describe('Hermes client transport boundaries', () => {
  it('persists a turn with its caller-supplied idempotency key', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, turnId: 'turn' }));
    const client = new HermesDkgClient({ fetchImpl });
    const payload = { sessionId: 'session', turnId: 'turn', idempotencyKey: 'key', userMessage: 'user', assistantReply: 'assistant' };
    expect(await client.persistHermesTurn(payload)).toEqual({ ok: true, turnId: 'turn' });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9200/api/hermes-channel/persist-turn', expect.objectContaining({
      method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }));
  });

  it.each(['data:', 'data: {"final":true}', 'data: malformed'])('flushes final SSE frame %s without requiring a newline', async (tail) => {
    const bytes = new TextEncoder().encode(`: heartbeat\r\ndata: \r\ndata: invalid\r\ndata: {"text":"café"}\r\n\r\n${tail}`);
    const stream = new ReadableStream({ start(controller) {
      // Split every byte, including the multibyte UTF-8 character and frame delimiters.
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const client = new HermesDkgClient({ fetchImpl: vi.fn(async () => new Response(stream)) });
    const events: unknown[] = [];
    await client.streamHermesMessage({ text: 'hello', correlationId: 'test-request' }, (event) => events.push(event));
    expect(events).toEqual(tail.includes('true') ? [{ text: 'café' }, { final: true }] : [{ text: 'café' }]);
  });

  it('accepts an empty streaming response and reports unreadable HTTP errors', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new HermesDkgClient({ fetchImpl });
    const onEvent = vi.fn();
    await client.streamHermesMessage({ text: 'hello', correlationId: 'test-request' }, onEvent);
    expect(onEvent).not.toHaveBeenCalled();
    const response = new Response('private', { status: 503 });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('body unavailable'));
    fetchImpl.mockResolvedValue(response);
    await expect(client.getHermesChannelHealth()).rejects.toThrow('responded 503: ');
  });

  it.each([['bearerWITHOUTSPACE', 'bearerWITHOUTSPACE'], ['Bearer @', 'Bearer @'], ['BEARER\tsecret Bearer two', 'BEARER [REDACTED] Bearer [REDACTED]']])('redacts malformed or repeated bearer values: %s', (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it('registers and executes its cleanup hook exactly once', async () => {
    const api = createTrackingApi();
    const info = vi.spyOn(api.logger, 'info');
    const plugin = new HermesAdapterPlugin();
    plugin.register(api);
    plugin.register(api);
    expect(api.registerHookCalls).toHaveLength(1);
    await api.hooks.get('session_end')!();
    expect(info).toHaveBeenCalledWith('[hermes] Daemon shutting down — Hermes adapter cleanup');
  });
});
