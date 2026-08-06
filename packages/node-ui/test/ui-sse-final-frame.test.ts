import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';

import { streamHermesLocalChat, streamPrimeAgentLocalChat } from '../src/ui/api.js';

/**
 * Regression coverage for the Node UI half of the SSE terminal-frame contract.
 *
 * The bug: both readers looped until `reader.read()` reported `done`, i.e. they
 * waited for the HTTP socket to close. `final` is the terminal SEMANTIC event
 * and a bridge may keep its connection open afterwards — Prime Agent does — so
 * the promise never settled and the composer kept spinning over an answer that
 * was already on screen.
 *
 * The server below deliberately never ends these responses. If a reader waits
 * for EOF, the test times out; that is the whole point.
 */

let server: Server;
let baseUrl: string;
let originalFetch: typeof globalThis.fetch;
const heldResponses: ServerResponse[] = [];

function writeStreamAndHold(res: ServerResponse, frames: string[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  for (const frame of frames) res.write(frame);
  // No res.end() — the socket stays open, exactly like a real agent bridge that
  // reuses its connection for the next turn.
  res.on('error', () => {});
  heldResponses.push(res);
}

beforeAll(async () => {
  baseUrl = await new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url.includes('/api/prime-agent-channel/stream')) {
        writeStreamAndHold(res, [
          'data: {"type":"delta","text":"Hel"}\n\n',
          'data: {"type":"delta","text":"lo!"}\n\n',
          'data: {"type":"final","text":"Hello!","correlationId":"p1","sessionId":"s1"}\n\n',
        ]);
        return;
      }
      if (url.includes('/api/hermes-channel/stream')) {
        writeStreamAndHold(res, [
          'data: {"type":"delta","text":"Her"}\n\n',
          'data: {"type":"final","text":"Hermes","correlationId":"h1"}\n\n',
        ]);
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

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = String(input);
    url = url.startsWith('/') ? baseUrl + url : url.replace(/^https?:\/\/[^/]+/, baseUrl);
    return originalFetch(url, init);
  };
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const res of heldResponses) {
    try { res.end(); } catch { /* already torn down by the client cancel */ }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('ui SSE readers: resolve on the final frame', () => {
  it('resolves the Prime Agent stream without waiting for the socket to close', async () => {
    const events: string[] = [];
    const result = await streamPrimeAgentLocalChat('hi', {
      onEvent: (event) => events.push(event.type),
    });

    expect(result.text).toBe('Hello!');
    expect(result.correlationId).toBe('p1');
    expect(result.sessionId).toBe('s1');
    // Deltas are normalised to text_delta for the composer; final is last.
    expect(events).toEqual(['text_delta', 'text_delta', 'final']);
  });

  it('resolves the Hermes stream on the same contract', async () => {
    const result = await streamHermesLocalChat('hi', {});
    expect(result.text).toBe('Hermes');
    expect(result.correlationId).toBe('h1');
  });
});
