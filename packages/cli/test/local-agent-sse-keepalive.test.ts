import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DkgConfig } from '../src/config.js';
import {
  LOCAL_AGENT_SSE_KEEPALIVE_FRAME,
  LOCAL_AGENT_SSE_KEEPALIVE_INTERVAL_MS,
  pipeOpenClawStream,
  startLocalAgentSseKeepalive,
  writeLocalAgentSseHead,
} from '../src/daemon/local-agent-sse.js';
import { handleHermesRoutes } from '../src/daemon/routes/hermes.js';
import { handleOpenclawRoutes } from '../src/daemon/routes/openclaw.js';
import { daemonState } from '../src/daemon/state.js';

/**
 * Issue #3886: a tool-heavy local-agent turn can go minutes without a
 * transcript byte, and a proxy in front of the daemon ends a silent response
 * (with a 524, for example). The daemon sends its SSE head at once and a
 * `: keepalive` comment every 15 s while a stream is open.
 *
 * Only `setInterval`/`clearInterval` are faked, so request bodies, sockets and
 * the polling helper below run on real timers.
 */

// Keep profile resolution off the real home directory, as daemon-hermes.test.ts does.
vi.mock('@origintrail-official/dkg-adapter-hermes', () => ({
  disconnectHermesProfile: vi.fn(),
  resolveHermesProfile: vi.fn(() => ({
    profileName: undefined,
    hermesHome: 'C:\\Hermes\\default',
    memoryMode: 'provider',
  })),
}));

const KEEPALIVE = ': keepalive\n\n';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  daemonState.openClawBridgeHealth = null;
});

function fakeIntervals(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
}

async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** A few real macrotask turns, so a relay can consume what upstream just sent. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeRes() {
  const res = new EventEmitter() as any;
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.writableEnded = false;
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.flushHeaders = vi.fn();
  res.write = (chunk: string | Uint8Array) => {
    res.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  res.end = (chunk?: string) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
  };
  return res;
}

function makeJsonRequest(path: string, payload: unknown) {
  const req = new EventEmitter() as any;
  req.method = 'POST';
  req.url = path;
  req.headers = {};
  setTimeout(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  }, 0);
  return req;
}

/** A bridge response body the test feeds one chunk at a time. */
function makeUpstream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(innerController) {
      controller = innerController;
    },
  });
  return {
    stream,
    push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
  };
}

/** A reader for the shared pump that the test feeds by hand. */
function makeControlledReader() {
  type ReadResult = { done: boolean; value?: Uint8Array };
  const queued: ReadResult[] = [];
  const waiting: Array<(result: ReadResult) => void> = [];
  const deliver = (result: ReadResult) => {
    const next = waiting.shift();
    if (next) next(result);
    else queued.push(result);
  };
  return {
    reader: {
      read: () => (queued.length > 0
        ? Promise.resolve(queued.shift()!)
        : new Promise<ReadResult>((resolve) => { waiting.push(resolve); })),
      cancel: async () => undefined,
      releaseLock: () => undefined,
    },
    push: (text: string) => deliver({ done: false, value: Buffer.from(text, 'utf8') }),
    end: () => deliver({ done: true }),
  };
}

function dataEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

function makeConfig(localAgentIntegrations: DkgConfig['localAgentIntegrations']): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
    localAgentIntegrations,
  };
}

const HERMES_OPENAI_CONFIG = makeConfig({
  hermes: {
    enabled: true,
    transport: { kind: 'hermes-openai', gatewayUrl: 'http://127.0.0.1:8642' },
  },
});

function makeRouteContext(fields: { req: unknown; res: unknown; config: DkgConfig; path: string }) {
  return {
    ...fields,
    agent: { store: { query: vi.fn(async () => ({ bindings: [] })) } },
    memoryManager: {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    },
    bridgeAuthToken: 'bridge-token',
    extractionStatus: new Map(),
    requestAgentAddress: '0x0000000000000000000000000000000000000001',
  } as any;
}

/** Serves `stream` for every non-health request and records the URLs asked for. */
function stubUpstream(stream: ReadableStream<Uint8Array>): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), { status: 200 });
    }
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }));
  return urls;
}

const HERMES_OPENAI_URL = 'http://127.0.0.1:8642/v1/chat/completions';

describe('writeLocalAgentSseHead', () => {
  it('sends the SSE head with the proxy headers at once', () => {
    const res = makeRes();

    writeLocalAgentSseHead(res, { 'Access-Control-Allow-Origin': 'http://ui.local' });

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': 'http://ui.local',
    });
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
  });

  it('accepts a response without flushHeaders', () => {
    const res = makeRes();
    delete res.flushHeaders;

    writeLocalAgentSseHead(res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['X-Accel-Buffering']).toBe('no');
  });
});

describe('startLocalAgentSseKeepalive', () => {
  it('writes a comment frame every 15 s and nothing after it is stopped', () => {
    fakeIntervals();
    const res = makeRes();

    const stop = startLocalAgentSseKeepalive(res);
    vi.advanceTimersByTime(14_999);
    expect(res.body).toBe('');
    vi.advanceTimersByTime(1);
    expect(res.body).toBe(KEEPALIVE);
    vi.advanceTimersByTime(30_000);
    expect(res.body).toBe(KEEPALIVE.repeat(3));

    stop();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(res.listenerCount('finish') + res.listenerCount('close') + res.listenerCount('error')).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(res.body).toBe(KEEPALIVE.repeat(3));
    expect(LOCAL_AGENT_SSE_KEEPALIVE_FRAME).toBe(KEEPALIVE);
    expect(LOCAL_AGENT_SSE_KEEPALIVE_INTERVAL_MS).toBe(15_000);
  });

  it.each(['finish', 'close', 'error'])('stops when the response emits %s', (event) => {
    fakeIntervals();
    const res = makeRes();

    startLocalAgentSseKeepalive(res);
    res.emit(event, event === 'error' ? new Error('socket reset') : undefined);

    expect(vi.getTimerCount()).toBe(0);
    expect(res.listenerCount('finish') + res.listenerCount('close') + res.listenerCount('error')).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(res.body).toBe('');
  });

  it('stops at the next tick once the response ended, its socket is gone, or a write throws', () => {
    fakeIntervals();
    const ended = makeRes();
    const destroyed = makeRes();
    const throwing = makeRes();
    throwing.write = () => {
      throw new Error('write after destroy');
    };

    startLocalAgentSseKeepalive(ended);
    startLocalAgentSseKeepalive(destroyed);
    startLocalAgentSseKeepalive(throwing);
    ended.writableEnded = true;
    destroyed.destroyed = true;
    expect(vi.getTimerCount()).toBe(3);

    vi.advanceTimersByTime(15_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(ended.body).toBe('');
    expect(destroyed.body).toBe('');
    expect(throwing.listenerCount('close')).toBe(0);
  });

  it('holds the comment while canWrite says a frame is open', () => {
    fakeIntervals();
    const res = makeRes();
    let frameOpen = true;

    const stop = startLocalAgentSseKeepalive(res, { canWrite: () => !frameOpen });
    vi.advanceTimersByTime(15_000);
    expect(res.body).toBe('');
    frameOpen = false;
    vi.advanceTimersByTime(15_000);
    expect(res.body).toBe(KEEPALIVE);
    stop();
  });

  it('starts no timer for a zero interval', () => {
    fakeIntervals();
    const res = makeRes();

    const stop = startLocalAgentSseKeepalive(res, { intervalMs: 0 });

    expect(vi.getTimerCount()).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    stop();
  });
});

describe('channel relay keepalive', () => {
  it('keeps a quiet bridge stream alive and stops at the final frame', async () => {
    fakeIntervals();
    const res = makeRes();
    const upstream = makeControlledReader();

    const piping = pipeOpenClawStream(new EventEmitter() as any, res, upstream.reader);
    vi.advanceTimersByTime(15_000);
    expect(res.body).toBe(KEEPALIVE);
    upstream.push('data: {"type":"delta","text":"He"}\n\n');
    await until(() => res.body.includes('"He"'), 'the delta');
    vi.advanceTimersByTime(15_000);
    upstream.push('data: {"type":"final","text":"Hello","correlationId":"c1"}\n\n');
    await piping;

    expect(res.body).toBe(
      KEEPALIVE
        + 'data: {"type":"delta","text":"He"}\n\n'
        + KEEPALIVE
        + 'data: {"type":"final","text":"Hello","correlationId":"c1"}\n\n',
    );
    expect(res.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never writes a comment inside an oversized frame that waits for drain', async () => {
    fakeIntervals();
    const res = makeRes();
    const writes: string[] = [];
    res.write = (chunk: string | Uint8Array) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      writes.push(text);
      res.body += text;
      // The first piece of the oversized frame fills the socket buffer.
      return writes.length > 1;
    };
    const upstream = makeControlledReader();
    const frameStart = `data: {"type":"delta","text":"${'x'.repeat(1_000_010)}`;
    const frameEnd = '"}\n\n';

    const piping = pipeOpenClawStream(new EventEmitter() as any, res, upstream.reader);
    upstream.push(frameStart);
    await until(() => writes.length === 1, 'the first piece of the frame');
    vi.advanceTimersByTime(15_000);
    expect(writes).toHaveLength(1);

    res.emit('drain');
    upstream.push(frameEnd);
    await until(() => res.body.endsWith(frameEnd), 'the end of the frame');
    vi.advanceTimersByTime(15_000);
    upstream.end();
    await piping;

    expect(res.body === frameStart + frameEnd + KEEPALIVE).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Hermes stream route keepalive (#3886)', () => {
  it('keeps a tool-heavy OpenAI-compatible turn alive and streams the same text', async () => {
    fakeIntervals();
    const upstream = makeUpstream();
    const urls = stubUpstream(upstream.stream);
    const res = makeRes();
    const ctx = makeRouteContext({
      req: makeJsonRequest('/api/hermes-channel/stream', { text: 'run the tools', correlationId: 'corr-quiet' }),
      res,
      config: HERMES_OPENAI_CONFIG,
      path: '/api/hermes-channel/stream',
    });

    const routed = handleHermesRoutes(ctx);
    await until(() => res.statusCode === 200, 'the SSE head');
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    expect(res.headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    expect(res.body).toBe('');

    // Tools run for 90 s. Hermes sends only its own comment frames, which the
    // relay does not forward, so the client sees the daemon's every 15 s.
    for (let tick = 1; tick <= 6; tick += 1) {
      upstream.push(KEEPALIVE);
      await settle();
      vi.advanceTimersByTime(15_000);
      expect(res.body).toBe(KEEPALIVE.repeat(tick));
    }

    upstream.push('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    upstream.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    upstream.push('data: [DONE]\n\n');
    upstream.close();
    await routed;

    expect(urls).toEqual([HERMES_OPENAI_URL]);
    expect(dataEvents(res.body)).toEqual([
      { type: 'delta', text: 'Hel', correlationId: 'corr-quiet' },
      { type: 'delta', text: 'lo', correlationId: 'corr-quiet' },
      expect.objectContaining({ type: 'final', text: 'Hello', correlationId: 'corr-quiet' }),
    ]);
    expect(ctx.memoryManager.storeChatExchange).toHaveBeenCalledWith(
      'hermes:dkg-ui',
      'run the tools',
      'Hello',
      undefined,
      expect.objectContaining({ persistenceState: 'stored' }),
    );
    expect(res.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const bodyAtEnd = res.body;
    vi.advanceTimersByTime(60_000);
    expect(res.body).toBe(bodyAtEnd);
  });

  it('stops the keepalive when the upstream stream fails', async () => {
    fakeIntervals();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const failing = new ReadableStream<Uint8Array>({ start(innerController) { controller = innerController; } });
    stubUpstream(failing);
    const res = makeRes();
    const ctx = makeRouteContext({
      req: makeJsonRequest('/api/hermes-channel/stream', { text: 'run the tools', correlationId: 'corr-fail' }),
      res,
      config: HERMES_OPENAI_CONFIG,
      path: '/api/hermes-channel/stream',
    });

    const routed = handleHermesRoutes(ctx);
    await until(() => res.statusCode === 200, 'the SSE head');
    vi.advanceTimersByTime(15_000);
    controller.error(new Error('upstream reset'));
    await routed;

    expect(res.body.startsWith(KEEPALIVE)).toBe(true);
    expect(dataEvents(res.body)).toEqual([{ type: 'error', error: 'upstream reset' }]);
    expect(res.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.memoryManager.storeChatExchange).not.toHaveBeenCalled();
  });

  it('keeps the Hermes channel protocol stream alive through the shared relay', async () => {
    fakeIntervals();
    const upstream = makeUpstream();
    const urls = stubUpstream(upstream.stream);
    const res = makeRes();
    const routed = handleHermesRoutes(makeRouteContext({
      req: makeJsonRequest('/api/hermes-channel/stream', { text: 'run the tools', correlationId: 'corr-channel' }),
      res,
      config: makeConfig({
        hermes: {
          enabled: true,
          capabilities: { localChat: true },
          transport: { kind: 'hermes-channel', bridgeUrl: 'http://127.0.0.1:9202' },
        },
      }),
      path: '/api/hermes-channel/stream',
    }));

    await until(() => res.statusCode === 200, 'the SSE head');
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    vi.advanceTimersByTime(15_000);
    expect(res.body).toBe(KEEPALIVE);
    upstream.push('data: {"type":"final","text":"done","correlationId":"corr-channel"}\n\n');
    await routed;

    expect(urls.at(-1)).toBe('http://127.0.0.1:9202/stream');
    expect(res.body).toBe(`${KEEPALIVE}data: {"type":"final","text":"done","correlationId":"corr-channel"}\n\n`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('puts the head and keepalive bytes on the wire before the first text', async () => {
    const upstream = makeUpstream();
    const urls = stubUpstream(upstream.stream);
    const server = createServer((req, res) => {
      void handleHermesRoutes(makeRouteContext({
        req,
        res,
        config: HERMES_OPENAI_CONFIG,
        path: '/api/hermes-channel/stream',
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // The server's own housekeeping timers stay real; only the route's keepalive is faked.
    fakeIntervals();
    try {
      const { port } = server.address() as AddressInfo;
      const body = JSON.stringify({ text: 'run the tools', correlationId: 'corr-wire' });
      const chunks: string[] = [];
      let response: IncomingMessage | undefined;
      let ended = false;
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/hermes-channel/stream',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (incoming) => {
        response = incoming;
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => chunks.push(chunk));
        incoming.on('end', () => { ended = true; });
      });
      request.end(body);

      // The 200 arrives while Hermes is still silent, not with the first text.
      await until(() => response !== undefined, 'the response head');
      expect(response?.statusCode).toBe(200);
      expect(response?.headers['cache-control']).toBe('no-cache, no-transform');
      expect(response?.headers['x-accel-buffering']).toBe('no');
      expect(chunks).toEqual([]);

      upstream.push(KEEPALIVE);
      await settle();
      vi.advanceTimersByTime(15_000);
      await until(() => chunks.join('') === KEEPALIVE, 'a keepalive on the wire');

      upstream.push('data: {"choices":[{"delta":{"content":"DONE"}}]}\n\n');
      upstream.push('data: [DONE]\n\n');
      upstream.close();
      await until(() => ended, 'the end of the response');

      expect(urls).toEqual([HERMES_OPENAI_URL]);
      expect(chunks.join('').startsWith(KEEPALIVE)).toBe(true);
      expect(dataEvents(chunks.join(''))).toEqual([
        { type: 'delta', text: 'DONE', correlationId: 'corr-wire' },
        expect.objectContaining({ type: 'final', text: 'DONE', correlationId: 'corr-wire' }),
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('OpenClaw stream route keepalive', () => {
  it('keeps a quiet bridge turn alive with the same head as Hermes', async () => {
    fakeIntervals();
    const upstream = makeUpstream();
    const urls = stubUpstream(upstream.stream);
    const res = makeRes();
    const routed = handleOpenclawRoutes(makeRouteContext({
      req: makeJsonRequest('/api/openclaw-channel/stream', { text: 'run the tools', correlationId: 'corr-oc' }),
      res,
      config: makeConfig({
        openclaw: {
          enabled: true,
          capabilities: { localChat: true },
          transport: { kind: 'openclaw-channel', bridgeUrl: 'http://127.0.0.1:9301' },
        },
      }),
      path: '/api/openclaw-channel/stream',
    }));

    await until(() => res.statusCode === 200, 'the SSE head');
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    expect(res.headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    vi.advanceTimersByTime(30_000);
    expect(res.body).toBe(KEEPALIVE.repeat(2));
    upstream.push('data: {"type":"final","text":"done","correlationId":"corr-oc"}\n\n');
    await routed;

    expect(urls.at(-1)).toBe('http://127.0.0.1:9301/inbound/stream');
    expect(res.body).toBe(`${KEEPALIVE.repeat(2)}data: {"type":"final","text":"done","correlationId":"corr-oc"}\n\n`);
    expect(res.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
