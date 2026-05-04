/** Shared in-process mocks for unit-testing daemon route handlers. No real daemon, network, chain, or Hardhat. */

import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestContext } from '../../src/daemon/routes/context.js';

const DEFAULT_AGENT_ADDRESS = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** Fake IncomingMessage; body is JSON-encoded and emitted via data/end events on the next tick. */
export function makeFakeRequest(
  body: object | null,
  overrides: { method?: string; url?: string } = {},
): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  emitter.method = overrides.method ?? 'POST';
  emitter.url = overrides.url ?? '/';

  // Defer emit so listeners attach first.
  setImmediate(() => {
    if (body !== null) {
      emitter.emit('data', Buffer.from(JSON.stringify(body)));
    }
    emitter.emit('end');
  });

  return emitter;
}

export interface FakeResponse {
  res: ServerResponse;
  getResult: () => { status: number; body: unknown };
}

/** Fake ServerResponse capturing status + JSON body. Supports the writeHead(status, headers?) overload jsonResponse uses. */
export function makeFakeResponse(): FakeResponse {
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

export interface PublishCall {
  cgId: string;
  envelope: unknown;
}

export type PublishHook = (cgId: string, envelope: unknown) => Promise<unknown>;

/**
 * Build a minimal RequestContext; the mock agent.publish appends every call to `publishCalls`.
 * `overrides.onPublish` overrides the publish return value; `publishCalls` is still populated.
 */
export function makeRequestContext(
  req: IncomingMessage,
  res: ServerResponse,
  overrides: Partial<RequestContext> & { onPublish?: PublishHook } = {},
): { ctx: RequestContext; publishCalls: PublishCall[] } {
  const publishCalls: PublishCall[] = [];
  const { onPublish, ...ctxOverrides } = overrides;

  const mockAgent = {
    async publish(cgId: string, envelope: unknown) {
      publishCalls.push({ cgId, envelope });
      if (onPublish) return onPublish(cgId, envelope);
      return { ual: 'did:dkg:test/1', kcId: '1', status: 'confirmed' as const };
    },
  };

  const ctx: Partial<RequestContext> = {
    req,
    res,
    agent: mockAgent as unknown as RequestContext['agent'],
    requestAgentAddress: DEFAULT_AGENT_ADDRESS,
    path: req.url ?? '/',
    ...ctxOverrides,
  };

  return { ctx: ctx as RequestContext, publishCalls };
}
