import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { LlmClient } from '../src/llm/client.js';

let server: Server;
let baseUrl: string;
let originalFetch: typeof globalThis.fetch;

const requestLog: Array<{ url: string; body: any; headers: Record<string, string> }> = [];

function startTestServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        requestLog.push({
          url,
          body: parsed,
          headers: req.headers as Record<string, string>,
        });

        if (parsed.stream === true) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: parsed._testResponse ?? 'ok' } }],
        }));
      });
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
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('LlmClient', () => {
  it('omits unsupported optional params for gpt-5 models', async () => {
    requestLog.length = 0;
    const client = new LlmClient();

    await client.complete({
      config: { apiKey: 'test', model: 'gpt-5-mini', baseURL: baseUrl + '/v1' },
      request: {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 123,
        temperature: 0.2,
        stream: false,
      },
    });

    expect(requestLog).toHaveLength(1);
    const payload = requestLog[0].body;
    expect(payload.max_tokens).toBeUndefined();
    expect(payload.temperature).toBeUndefined();
  });

  it('streams normalized events for SSE responses', async () => {
    requestLog.length = 0;
    const client = new LlmClient();
    const events: Array<{ type: string; [k: string]: any }> = [];

    for await (const ev of client.stream({
      config: { apiKey: 'test', model: 'gpt-4o-mini', baseURL: baseUrl + '/v1' },
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
  });

  it('falls back to blocking mode when streaming is disabled by capabilities', async () => {
    requestLog.length = 0;

    class NoStreamClient extends LlmClient {
      override resolveCapabilities(config: any) {
        const base = super.resolveCapabilities(config);
        return { ...base, supportsStreaming: false };
      }
    }

    const client = new NoStreamClient();
    const events: Array<{ type: string; [k: string]: any }> = [];
    for await (const ev of client.stream({
      config: { apiKey: 'test', model: 'gpt-4o-mini', baseURL: baseUrl + '/v1' },
      request: {
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
    })) {
      events.push(ev as any);
    }

    const final = events.find(e => e.type === 'final');
    expect(final?.mode).toBe('blocking');
    expect(requestLog.length).toBeGreaterThan(0);
    const payload = requestLog[requestLog.length - 1].body;
    expect(payload.stream).toBeUndefined();
  });

  it('falls back to blocking parsing when stream response is non-SSE JSON', async () => {
    requestLog.length = 0;

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const redirected = url.replace(/^https?:\/\/[^/]+/, baseUrl);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      body.stream = false;
      body._testResponse = 'json fallback';
      return origFetch(redirected, { ...init, body: JSON.stringify(body) });
    };

    try {
      const client = new LlmClient();
      const events: Array<{ type: string; [k: string]: any }> = [];
      for await (const ev of client.stream({
        config: { apiKey: 'test', model: 'gpt-4o-mini', baseURL: baseUrl + '/v1' },
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
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
