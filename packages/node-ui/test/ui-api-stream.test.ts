import { describe, it, expect, vi } from 'vitest';
import { fetchMemorySessionGraphDelta, streamLocalAgentChat, streamOpenClawLocalChat } from '../src/ui/api.js';

describe('ui local-agent stream api', () => {
  it('parses OpenClaw SSE frames and resolves the final payload', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text_delta","delta":"Hel"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"text_delta","delta":"lo"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"final","text":"Hello","correlationId":"c1"}\n\n'));
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
    const res = await streamOpenClawLocalChat('hi', {
      onEvent: (event) => events.push(event.type),
    });

    expect(res.text).toBe('Hello');
    expect(res.correlationId).toBe('c1');
    expect(events).toEqual(['text_delta', 'text_delta', 'final']);
    fetchSpy.mockRestore();
  });

  it('falls back to plain JSON payload when the OpenClaw stream endpoint responds in blocking mode', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ text: 'Blocking response', correlationId: 'c2' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const events: string[] = [];
    const res = await streamOpenClawLocalChat('hello', {
      onEvent: (event) => events.push(event.type),
    });

    expect(res.text).toBe('Blocking response');
    expect(res.correlationId).toBe('c2');
    expect(events).toEqual(['final']);
    fetchSpy.mockRestore();
  });

  it('throws when the OpenClaw stream emits an error event', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"error","error":"bridge unavailable"}\n\n'));
        controller.close();
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    await expect(streamOpenClawLocalChat('hello')).rejects.toThrow('bridge unavailable');
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

  it('forwards attachment refs through the generic local-agent chat transport', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ text: 'Attached response', correlationId: 'c3' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const attachments = [{
      id: 'att-1',
      fileName: 'notes.md',
      contextGraphId: 'project-1',
      assertionName: 'assert-1',
      assertionUri: 'urn:dkg:assertion:1',
      fileHash: 'abc123',
      detectedContentType: 'text/markdown',
      extractionStatus: 'completed' as const,
      tripleCount: 12,
    }];

    const result = await streamLocalAgentChat('openclaw', 'hello', {
      attachments,
    });

    expect(result.text).toBe('Attached response');
    const payload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(payload.attachmentRefs).toEqual(attachments);
    expect(payload.text).toBe('hello');
    fetchSpy.mockRestore();
  });
});
