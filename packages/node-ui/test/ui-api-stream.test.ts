import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchMemorySessionGraphDelta, streamLocalAgentChat, streamOpenClawLocalChat } from '../src/ui/api.js';

let server: Server;
let baseUrl: string;
let originalFetch: typeof globalThis.fetch;

const requestLog: Array<{ url: string; method: string }> = [];

function startTestServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      requestLog.push({ url, method: req.method ?? 'GET' });

      if (url.includes('/api/openclaw-channel/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"text_delta","delta":"Hel"}\n\n');
        res.write('data: {"type":"text_delta","delta":"lo"}\n\n');
        res.write('data: {"type":"final","text":"Hello","correlationId":"c1"}\n\n');
        res.end();
        return;
      }

      if (url.includes('/api/memory/sessions/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
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
        }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

beforeAll(async () => {
  baseUrl = await startTestServer();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = String(input);
    if (url.startsWith('/')) {
      url = baseUrl + url;
    } else {
      url = url.replace(/^https?:\/\/[^/]+/, baseUrl);
    }
    return originalFetch(url, init);
  };
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('ui local-agent stream api', () => {
  it('parses OpenClaw SSE frames and resolves the final payload', async () => {
    requestLog.length = 0;

    const events: string[] = [];
    const res = await streamOpenClawLocalChat('hi', {
      onEvent: (event) => events.push(event.type),
    });

    expect(res.text).toBe('Hello');
    expect(res.correlationId).toBe('c1');
    expect(events).toEqual(['text_delta', 'text_delta', 'final']);
  });

  it('throws when the OpenClaw stream emits an error event', async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      let url = String(input);
      if (url.startsWith('/')) {
        url = baseUrl + url;
      } else {
        url = url.replace(/^https?:\/\/[^/]+/, baseUrl);
      }
      const response = await originalFetch(url, init);
      const encoder = new TextEncoder();
      const errorStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"error","error":"bridge unavailable"}\n\n'));
          controller.close();
        },
      });
      return new Response(errorStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    try {
      await expect(streamOpenClawLocalChat('hello')).rejects.toThrow('bridge unavailable');
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('requests session graph delta with turn watermark query params', async () => {
    requestLog.length = 0;

    const res = await fetchMemorySessionGraphDelta('s1', 't2', { baseTurnId: 't1' });
    expect(res.mode).toBe('delta');
    expect(requestLog.some(r => r.url.includes('/api/memory/sessions/s1/graph-delta?turnId=t2&baseTurnId=t1'))).toBe(true);
  });

  it('forwards attachment refs through the generic local-agent chat transport', async () => {
    const fetchCalls: [string | URL | Request, RequestInit | undefined][] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([url, init]);
      return new Response(
        JSON.stringify({ text: 'Attached response', correlationId: 'c3' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

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

    try {
      const result = await streamLocalAgentChat('openclaw', 'hello', {
        attachments,
      });

      expect(result.text).toBe('Attached response');
      const payload = JSON.parse(String(fetchCalls[0]?.[1]?.body));
      expect(payload.attachmentRefs).toEqual(attachments);
      expect(payload.text).toBe('hello');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
