import { describe, it, expect, vi } from 'vitest';
import { fetchMemorySessionGraphDelta, streamChatMessage, streamChatPersistenceEvents } from '../src/ui/api.js';

describe('ui chat stream api', () => {
  it('parses SSE frames and resolves final payload', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"meta","sessionId":"s1"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"text_delta","delta":"Hel"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"text_delta","delta":"lo"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"final","reply":"Hello","sessionId":"s1","responseMode":"streaming"}\n\n'));
        controller.close();
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const events: string[] = [];
    const res = await streamChatMessage('hi', {
      onEvent: (event) => events.push(event.type),
    });

    expect(res.reply).toBe('Hello');
    expect(res.sessionId).toBe('s1');
    expect(events).toContain('meta');
    expect(events).toContain('text_delta');
    expect(events).toContain('final');
    fetchSpy.mockRestore();
  });

  it('falls back to plain JSON payload when endpoint responds in blocking mode', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ reply: 'Blocking response', sessionId: 's2', responseMode: 'blocking' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const events: string[] = [];
    const res = await streamChatMessage('hello', {
      onEvent: (event) => events.push(event.type),
    });

    expect(res.reply).toBe('Blocking response');
    expect(res.responseMode).toBe('blocking');
    expect(events).toEqual(['final']);
    fetchSpy.mockRestore();
  });

  it('throws when stream emits error event', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"error","error":"provider unavailable"}\n\n'));
        controller.close();
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    await expect(streamChatMessage('hello')).rejects.toThrow('provider unavailable');
    fetchSpy.mockRestore();
  });

  it('parses persistence SSE status and health events', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"persist_health","ts":1,"pending":2,"inProgress":0,"stored":4,"failed":0,"overduePending":0,"oldestPendingAgeMs":12}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"persist_status","turnId":"t1","sessionId":"s1","status":"stored","attempts":1,"maxAttempts":4,"queuedAt":1,"updatedAt":2,"storeMs":8}\n\n'));
        controller.close();
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const events: string[] = [];
    await streamChatPersistenceEvents({
      onEvent: (event) => events.push(event.type),
    });

    expect(events).toEqual(['persist_health', 'persist_status']);
    fetchSpy.mockRestore();
  });

  it('requests session graph delta with turn watermark query params', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          mode: 'delta',
          sessionId: 's1',
          turnId: 't2',
          watermark: {
            baseTurnId: 't1',
            previousTurnId: 't1',
            appliedTurnId: 't2',
            latestTurnId: 't2',
            turnIndex: 2,
            turnCount: 2,
          },
          triples: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await fetchMemorySessionGraphDelta('s1', 't2', { baseTurnId: 't1' });
    expect(res.mode).toBe('delta');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/memory/sessions/s1/graph-delta?turnId=t2&baseTurnId=t1');
    fetchSpy.mockRestore();
  });
});
