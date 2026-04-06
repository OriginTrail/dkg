/**
 * Unit tests for sim-engine: devnetAuthTokenPath, fmtError, and HTTP handler.
 * E2E test (when devnet is running) is in sim-engine.e2e.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { devnetAuthTokenPath, fmtError, handleSimRequest } from '../src/server/sim-engine.js';

// ---------------------------------------------------------------------------
// Helpers: mock req/res for handleSimRequest
// ---------------------------------------------------------------------------

function mockReq(options: { url: string; method: string; body?: string }): IncomingMessage {
  const req = Object.assign(
    new Readable({ read() {} }),
    { url: options.url, method: options.method },
  ) as IncomingMessage;
  if (options.body !== undefined) {
    req.push(options.body);
    req.push(null);
  }
  return req;
}

function mockRes(): ServerResponse & { statusCode: number; headers: Record<string, string>; body: string } {
  const chunks: string[] = [];
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(statusCode: number, headers?: Record<string, string> | Record<string, string[]>) {
      this.statusCode = statusCode;
      if (headers) {
        const flat = headers as Record<string, string>;
        for (const [k, v] of Object.entries(flat)) this.headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      }
      return this;
    },
    write(chunk: string | Buffer) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      this.body = chunks.join('');
      return this;
    },
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    removeHeader: vi.fn(),
    hasHeader: vi.fn(),
    getHeaders: vi.fn(() => ({})),
    flushHeaders: vi.fn(),
    getHeaderNames: vi.fn(() => []),
    addTrailers: vi.fn(),
    finished: false,
    writableEnded: false,
    writable: true,
    destroyed: false,
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    setTimeout: vi.fn(),
  } as unknown as ServerResponse & { statusCode: number; headers: Record<string, string>; body: string };
}

function parseJsonBody(res: ReturnType<typeof mockRes>): unknown {
  return JSON.parse(res.body || 'null');
}

// ---------------------------------------------------------------------------
// devnetAuthTokenPath
// ---------------------------------------------------------------------------

describe('sim-engine', () => {
  describe('devnetAuthTokenPath', () => {
    it('uses nodeN not node-N so devnet dirs match', () => {
      const dir = '/tmp/.devnet';
      expect(devnetAuthTokenPath(dir, 1)).toBe('/tmp/.devnet/node1/auth.token');
      expect(devnetAuthTokenPath(dir, 6)).toBe('/tmp/.devnet/node6/auth.token');
    });

    it('never produces node-N path (regression for auth load fix)', () => {
      for (const id of [1, 2, 3, 4, 5, 6]) {
        const path = devnetAuthTokenPath('.devnet', id);
        expect(path).toContain(`node${id}/`);
        expect(path).not.toContain('node-');
      }
    });
  });

  describe('fmtError', () => {
    it('formats TimeoutError with op timeout seconds', () => {
      const err = new DOMException('timed out', 'TimeoutError');
      expect(fmtError(err, 'publish')).toBe('timeout (60s)');
      expect(fmtError(err, 'query')).toBe('timeout (30s)');
      expect(fmtError(err, 'unknown')).toBe('timeout (30s)');
    });

    it('formats AbortError as aborted', () => {
      const err = new DOMException('aborted', 'AbortError');
      expect(fmtError(err, 'publish')).toBe('aborted (simulation stopped)');
    });

    it('formats generic Error with message', () => {
      expect(fmtError(new Error('Paranet does not exist'), 'publish')).toBe('Paranet does not exist');
    });

    it('stringifies non-Error values', () => {
      expect(fmtError('connection refused', 'query')).toBe('connection refused');
    });
  });

  describe('handleSimRequest', () => {
    afterEach(async () => {
      // Stop any running sim so tests don't interfere
      const req = mockReq({ url: '/sim/stop', method: 'POST' });
      const res = mockRes();
      await handleSimRequest(req, res);
    });

    it('GET /sim/status returns 200 and body shape when idle', async () => {
      const req = mockReq({ url: '/sim/status', method: 'GET' });
      const res = mockRes();
      await handleSimRequest(req, res);
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody(res) as Record<string, unknown>;
      expect(body).toHaveProperty('running', false);
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('completed');
      expect(body).toHaveProperty('errors');
      expect(body).toHaveProperty('opsPerSec');
      expect(body).toHaveProperty('elapsedMs');
      expect(body).toHaveProperty('byOp');
    });

    it('POST /sim/start with invalid JSON returns 400', async () => {
      const req = mockReq({ url: '/sim/start', method: 'POST', body: 'not json' });
      const res = mockRes();
      await handleSimRequest(req, res);
      expect(res.statusCode).toBe(400);
      expect((parseJsonBody(res) as { error: string }).error).toContain('Invalid JSON');
    });

    it('POST /sim/start with missing opCount returns 400', async () => {
      const req = mockReq({
        url: '/sim/start',
        method: 'POST',
        body: JSON.stringify({ opsPerSec: 10, enabledOps: ['publish'] }),
      });
      const res = mockRes();
      await handleSimRequest(req, res);
      expect(res.statusCode).toBe(400);
      expect((parseJsonBody(res) as { error: string }).error).toContain('Missing required fields');
    });

    it('POST /sim/start with missing enabledOps returns 400', async () => {
      const req = mockReq({
        url: '/sim/start',
        method: 'POST',
        body: JSON.stringify({ opCount: 100, opsPerSec: 10, enabledOps: [] }),
      });
      const res = mockRes();
      await handleSimRequest(req, res);
      expect(res.statusCode).toBe(400);
      expect((parseJsonBody(res) as { error: string }).error).toContain('Missing required fields');
    });

    it('POST /sim/start with valid config returns 200 and starts sim', async () => {
      const req = mockReq({
        url: '/sim/start',
        method: 'POST',
        body: JSON.stringify({
          opCount: 2,
          opsPerSec: 1,
          enabledOps: ['publish'],
          concurrency: 1,
          contextGraph: 'devnet-test',
        }),
      });
      const res = mockRes();
      await handleSimRequest(req, res);
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody(res) as { started: boolean; name: string };
      expect(body.started).toBe(true);
      expect(body.name).toBeDefined();
      // Sim runs in background; ensureContextGraph will fail (no nodes) and sim may error out - we stop in afterEach
    });

    it('POST /sim/stop when not running returns 200 stopped: false', async () => {
      const req = mockReq({ url: '/sim/stop', method: 'POST' });
      const res = mockRes();
      await handleSimRequest(req, res);
      expect(res.statusCode).toBe(200);
      expect((parseJsonBody(res) as { stopped: boolean }).stopped).toBe(false);
    });

    it('POST /sim/start then POST /sim/stop returns stopped: true', async () => {
      const startReq = mockReq({
        url: '/sim/start',
        method: 'POST',
        body: JSON.stringify({ opCount: 500, opsPerSec: 10, enabledOps: ['publish'], concurrency: 2 }),
      });
      const startRes = mockRes();
      await handleSimRequest(startReq, startRes);
      expect(startRes.statusCode).toBe(200);

      const stopReq = mockReq({ url: '/sim/stop', method: 'POST' });
      const stopRes = mockRes();
      await handleSimRequest(stopReq, stopRes);
      expect(stopRes.statusCode).toBe(200);
      expect((parseJsonBody(stopRes) as { stopped: boolean }).stopped).toBe(true);
    });

    it('POST /sim/start twice without stop returns 409 on second', async () => {
      const body = JSON.stringify({ opCount: 10, opsPerSec: 1, enabledOps: ['query'] });
      const req1 = mockReq({ url: '/sim/start', method: 'POST', body });
      const res1 = mockRes();
      await handleSimRequest(req1, res1);
      expect(res1.statusCode).toBe(200);

      const req2 = mockReq({ url: '/sim/start', method: 'POST', body });
      const res2 = mockRes();
      await handleSimRequest(req2, res2);
      expect(res2.statusCode).toBe(409);
      expect((parseJsonBody(res2) as { error: string }).error).toContain('already running');

      await handleSimRequest(mockReq({ url: '/sim/stop', method: 'POST' }), mockRes());
    });

    it('GET /sim/events returns 200 and text/event-stream', async () => {
      const req = mockReq({ url: '/sim/events', method: 'GET' });
      const res = mockRes();
      await handleSimRequest(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
    });

    it('unknown method or path returns 404', async () => {
      const req = mockReq({ url: '/sim/unknown', method: 'GET' });
      const res = mockRes();
      await handleSimRequest(req, res);
      expect(res.statusCode).toBe(404);
      expect((parseJsonBody(res) as { error: string }).error).toContain('Unknown sim endpoint');
    });
  });
});
