/**
 * Unit tests for the Kafka route adapter's privacy-envelope logic.
 *
 * The route adapter (packages/cli/src/daemon/routes/kafka.ts) is responsible
 * for wrapping the bare KA in either `{ private: KA }` or `{ public: KA }`
 * before passing it to agent.publish(). The kafka package itself stays agnostic.
 *
 * These tests invoke handleKafkaRoutes directly with a minimal RequestContext
 * mock — no real daemon, no network, no chain.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleKafkaRoutes } from '../src/daemon/routes/kafka.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make a minimal fake IncomingMessage for POST /api/kafka/endpoint with the
 * given JSON body.
 *
 * readBody() uses req.on('data' | 'end' | 'error') so we simulate an
 * EventEmitter that emits those events synchronously after the first tick.
 */
function makeFakeRequest(body: object): IncomingMessage {
  const bodyStr = JSON.stringify(body);
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  emitter.method = 'POST';
  emitter.url = '/api/kafka/endpoint';

  // Emit data/end on the next tick so listeners are attached first
  setImmediate(() => {
    emitter.emit('data', Buffer.from(bodyStr));
    emitter.emit('end');
  });

  return emitter;
}

/**
 * Make a fake ServerResponse that captures the status and JSON body.
 *
 * jsonResponse() calls writeHead(status, headers) then end(body), so we
 * must accept the (status, headers?) overload of writeHead.
 */
function makeFakeResponse(): { res: ServerResponse; getResult: () => { status: number; body: unknown } } {
  let capturedStatus = 0;
  let capturedBody: unknown = null;

  const res = new EventEmitter() as unknown as ServerResponse;
  (res as any).writeHead = (status: number, _headers?: unknown) => {
    capturedStatus = status;
    return res;
  };
  (res as any).end = (data?: string) => {
    try {
      capturedBody = data ? JSON.parse(data) : null;
    } catch {
      capturedBody = data;
    }
    return res;
  };

  return {
    res,
    getResult: () => ({ status: capturedStatus, body: capturedBody }),
  };
}

/**
 * Build a minimal RequestContext with a mock agent.publish that captures calls.
 */
function makeContext(req: IncomingMessage, res: ServerResponse): {
  ctx: RequestContext;
  publishCalls: Array<{ cgId: string; envelope: unknown }>;
} {
  const publishCalls: Array<{ cgId: string; envelope: unknown }> = [];

  const mockAgent = {
    async publish(cgId: string, envelope: unknown) {
      publishCalls.push({ cgId, envelope });
      return { ual: 'did:dkg:test/1', kcId: '1', status: 'confirmed' as const };
    },
  };

  const ctx: Partial<RequestContext> = {
    req,
    res,
    agent: mockAgent as unknown as RequestContext['agent'],
    requestAgentAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    path: '/api/kafka/endpoint',
  };

  return { ctx: ctx as RequestContext, publishCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const VALID_BASE_BODY = {
  contextGraphId: 'devnet-test',
  broker: 'kafka.example.com:9092',
  topic: 'orders.created',
  messageFormat: 'application/json',
};

describe('Kafka route adapter — privacy envelope', () => {
  it('wraps with { private: KA } when private: true is in request body', async () => {
    const req = makeFakeRequest({ ...VALID_BASE_BODY, private: true });
    const { res, getResult } = makeFakeResponse();
    const { ctx, publishCalls } = makeContext(req, res);

    await handleKafkaRoutes(ctx);

    const { status, body } = getResult();
    expect(status).toBe(200);

    expect(publishCalls).toHaveLength(1);
    const { envelope } = publishCalls[0]!;
    expect(envelope).toHaveProperty('private');
    expect(envelope).not.toHaveProperty('public');

    // Response must echo the resolved private flag
    expect((body as Record<string, unknown>).private).toBe(true);
  });

  it('wraps with { public: KA } when private: false is in request body', async () => {
    const req = makeFakeRequest({ ...VALID_BASE_BODY, private: false });
    const { res, getResult } = makeFakeResponse();
    const { ctx, publishCalls } = makeContext(req, res);

    await handleKafkaRoutes(ctx);

    const { status, body } = getResult();
    expect(status).toBe(200);

    expect(publishCalls).toHaveLength(1);
    const { envelope } = publishCalls[0]!;
    expect(envelope).toHaveProperty('public');
    expect(envelope).not.toHaveProperty('private');

    // Response must echo the resolved private flag
    expect((body as Record<string, unknown>).private).toBe(false);
  });

  it('defaults to { private: KA } when private field is omitted from request body', async () => {
    // No `private` field — route defaults to private: true
    const req = makeFakeRequest(VALID_BASE_BODY);
    const { res, getResult } = makeFakeResponse();
    const { ctx, publishCalls } = makeContext(req, res);

    await handleKafkaRoutes(ctx);

    const { status, body } = getResult();
    expect(status).toBe(200);

    expect(publishCalls).toHaveLength(1);
    const { envelope } = publishCalls[0]!;
    expect(envelope).toHaveProperty('private');
    expect(envelope).not.toHaveProperty('public');

    // Response echoes resolved private flag = true (default)
    expect((body as Record<string, unknown>).private).toBe(true);
  });

  it('returns 400 when contextGraphId is missing', async () => {
    const req = makeFakeRequest({ broker: 'x:9092', topic: 't', messageFormat: 'application/json' });
    const { res, getResult } = makeFakeResponse();
    const { ctx } = makeContext(req, res);

    await handleKafkaRoutes(ctx);

    expect(getResult().status).toBe(400);
  });

  it('returns 400 when broker is missing', async () => {
    const req = makeFakeRequest({ contextGraphId: 'devnet-test', topic: 't', messageFormat: 'application/json' });
    const { res, getResult } = makeFakeResponse();
    const { ctx } = makeContext(req, res);

    await handleKafkaRoutes(ctx);

    expect(getResult().status).toBe(400);
  });

  it('returns 400 when "private" is a non-boolean value (e.g. string "false")', async () => {
    // The route enforces a strict boolean for `private` to keep the privacy
    // contract unambiguous. Truthy/falsy coercion would create an unsafe
    // ambiguity at a privacy boundary.
    const req = makeFakeRequest({ ...VALID_BASE_BODY, private: 'false' });
    const { res, getResult } = makeFakeResponse();
    const { ctx, publishCalls } = makeContext(req, res);

    await handleKafkaRoutes(ctx);

    const { status, body } = getResult();
    expect(status).toBe(400);
    expect((body as Record<string, unknown>).error).toMatch(/"private" must be a boolean/);
    // No publish should have happened
    expect(publishCalls).toHaveLength(0);
  });
});
